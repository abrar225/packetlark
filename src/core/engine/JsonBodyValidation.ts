import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let active = 0;
const failure = (message: string, code: string) => Object.assign(new Error(message), { code, statusCode: 400 });
const workerSource = `
(() => {
const { parentPort, workerData } = require('node:worker_threads');
let value;
try { value = JSON.parse(workerData.raw); }
catch { parentPort.postMessage({ code: 'ERR_INVALID_JSON', message: 'Request body is not valid JSON' }); return; }
if (workerData.schema === undefined) { parentPort.postMessage({ valid: true }); return; }
try {
  const imported = require(workerData.module);
  const Ajv = imported.Ajv2020 || imported.Ajv || imported.default;
  const ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true, validateFormats: true, logger: false });
  const check = ajv.compile(workerData.schema);
  if (check(value)) parentPort.postMessage({ valid: true });
  else parentPort.postMessage({ code: 'ERR_JSON_SCHEMA', message: 'JSON body failed schema validation (' + String(check.errors?.[0]?.keyword || 'schema').replace(/[^a-zA-Z]/g, '').slice(0, 40) + ')' });
} catch { parentPort.postMessage({ code: 'ERR_JSON_SCHEMA', message: 'Invalid or unsupported JSON schema; remote references and unknown formats are unavailable' }); }
})();
`;

/** Untrusted schema compilation/regex evaluation never runs on the server loop. */
export async function validateJsonBody(raw: string, schema?: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16 * 1024 * 1024)
    throw failure('JSON validation accepts at most 16 MiB', 'ERR_JSON_LIMIT');
  let module = require.resolve('ajv/dist/2020.js');
  if (schema !== undefined) {
    let encoded: string;
    try { encoded = JSON.stringify(schema); } catch { throw failure('JSON schema must be acyclic JSON data', 'ERR_JSON_SCHEMA'); }
    if (!encoded || Buffer.byteLength(encoded) > 64 * 1024) throw failure('Schema exceeds 64 KiB', 'ERR_JSON_LIMIT');
    let nodes = 0;
    const visit = (value: any, depth = 0) => {
      if (++nodes > 5000 || depth > 32) throw failure('Schema exceeds structural validation limits', 'ERR_JSON_LIMIT');
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['$ref', '$dynamicRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#')))
          throw failure('Remote schema references are not allowed', 'ERR_JSON_SCHEMA');
        visit(child, depth + 1);
      }
    };
    visit(schema);
    if (schema.$schema === 'http://json-schema.org/draft-07/schema#') module = require.resolve('ajv');
    else if (schema.$schema && schema.$schema !== 'https://json-schema.org/draft/2020-12/schema')
      throw failure('Supported JSON schemas are draft 2020-12 and draft-07', 'ERR_JSON_SCHEMA');
  }
  if (options.signal?.aborted) throw failure('JSON validation cancelled', 'ERR_ABORTED');
  if (active >= 2) throw Object.assign(failure('Two JSON validation jobs are active; retry after one finishes', 'ERR_JSON_BUSY'), { statusCode: 503 });
  active++;
  await new Promise<void>((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(workerSource, { eval: true, workerData: { raw, schema, module }, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } }); }
    catch { active--; reject(failure('JSON validation worker could not start', 'ERR_JSON_WORKER')); return; }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      void worker.terminate().finally(() => { active--; if (error) reject(error); else resolve(); });
    };
    const abort = () => finish(failure('JSON validation cancelled', 'ERR_ABORTED'));
    const timer = setTimeout(() => finish(failure('JSON validation exceeded its execution budget', 'ERR_JSON_TIMEOUT')), Math.min(2000, Math.max(1, options.timeoutMs ?? 2000)));
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (result) => finish(result.valid ? undefined : failure(result.message, result.code)));
    worker.once('error', () => finish(failure('JSON validation worker failed within its resource limit', 'ERR_JSON_WORKER')));
    worker.once('exit', () => { if (!settled) finish(failure('JSON validation worker exited before returning a result', 'ERR_JSON_WORKER')); });
    if (options.signal?.aborted) abort();
  });
}
