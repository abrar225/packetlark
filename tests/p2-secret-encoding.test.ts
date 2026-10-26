import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { HttpExecutor, getExecutionState } from '../src/core/engine/HttpExecutor.js';
import { SecretRedactor } from '../src/core/security/SecretRedactor.js';
import { sanitizeExample } from '../src/core/workspace/WorkbenchState.js';
import type { HttpRequest } from '../src/core/models/types.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function fixture() {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; bodies.push(body); res.setHeader('content-type', 'application/json'); res.end(body || '{}'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); cleanup.push(() => new Promise<void>(r => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as any).port}/echo`;
  const request = (raw: string): HttpRequest => ({ method: 'POST', url, headers: [], queryParams: [], auth: { type: 'none' }, body: { mode: 'raw-json', raw } });
  return { bodies, request };
}
const id = '11111111-1111-4111-8111-111111111111'; const reference = `{{secret:${id}}}`;
describe('credential JSON encoding and diagnostics', () => {
  it('sends escaped credentials as JSON string values and preserves numeric-looking secrets as strings', async () => {
    const f = await fixture(); const seed = 'SEEDED-"quote"\nslash\\end';
    for (const secret of [seed, '123456789']) {
      const req = f.request(JSON.stringify({ plain: reference, nested: [reference], prefix: 'prefix ' + reference, number: 5 }));
      const response = await HttpExecutor.execute(req, [], [], { resolveCredential: async (ref, origin) => { expect(ref).toBe(id); expect(origin).toBe(new URL(req.url).origin); return secret; } });
      expect(response.status).toBe(200); const wire = JSON.parse(f.bodies.at(-1)!); expect(wire).toEqual({ plain: secret, nested: [secret], prefix: 'prefix ' + secret, number: 5 }); expect(typeof wire.plain).toBe('string');
    }
  });
  it('preserves no-reference JSON bytes, including whitespace and numeric spelling', async () => {
    const f = await fixture(); const raw = ' {  "ordinary" : "value", "number": 1e2 }\n'; const response = await HttpExecutor.execute(f.request(raw));
    expect(response.status).toBe(200); expect(f.bodies[0]).toBe(raw);
  });
  it('rejects references in JSON names, URL and header/query names before transport', async () => {
    const f = await fixture(); const cases = [f.request(JSON.stringify({ [reference]: 'value' })), f.request('{"\\u007b\\u007bsecret:' + id + '}}":"value"}'), { ...f.request('{}'), url: f.request('{}').url + '?token=' + reference }, { ...f.request('{}'), headers: [{ key: reference, value: 'value' }] }, { ...f.request('{}'), queryParams: [{ key: reference, value: 'value' }] }];
    for (const req of cases) { const response = await HttpExecutor.execute(req); expect(response.status).toBe(0); expect(response.transportAttempted).toBe(false); }
    expect(f.bodies).toEqual([]);
  });
  it('expands JSON-unicode-escaped string refs and redacts logs, returned maps/test names and generated examples', async () => {
    const f = await fixture(); const seed = 'SEEDED-"escaped"\nslash\\end'; const secrets = new SecretRedactor();
    const req = f.request('{"echo":"\\u007b\\u007bsecret:' + id + '}}"}');
    req.testScript = 'const value = pm.response.json().echo; console.log(JSON.stringify({echo:value})); pm.environment.set("copied", value); pm.collectionVariables.set(value,"key-copy"); pm.test(value, () => pm.expect(true).to.eql(true));';
    const response = await HttpExecutor.execute(req, [], [], { secrets, resolveCredential: async () => seed });
    expect(response.status).toBe(200); expect(JSON.parse(f.bodies[0]).echo).toBe(seed);
    const diagnostics = JSON.stringify({ logs: response.logs, tests: response.testResults, updatedVariables: response.updatedVariables, environment: response.updatedEnvironment, collection: response.updatedCollectionVariables });
    expect(diagnostics).not.toContain(JSON.stringify(seed).slice(1,-1)); expect(diagnostics).not.toContain('SEEDED-');
    const example = sanitizeExample(req, response, [], secrets); expect(JSON.parse(example.response.body).echo).not.toBe(seed); expect(JSON.stringify(example)).not.toContain('SEEDED-');
  });
  it('keeps generated numeric-secret JSON valid and failed diagnostics secret-free', async () => {
    const f = await fixture(); const seed = '123456789'; const secrets = new SecretRedactor();
    const req = f.request(JSON.stringify({ echo: reference })); req.testScript = 'console.log(JSON.stringify({echo:pm.response.json().echo}));';
    const response = await HttpExecutor.execute(req, [], [], { secrets, resolveCredential: async () => seed });
    const example = sanitizeExample(req, { ...response, body: '{"echo":123456789,"visible":true}' }, [], secrets); expect(JSON.parse(example.response.body).visible).toBe(true); expect(example.response.body).not.toContain(seed);
    const failed = await HttpExecutor.execute({ ...f.request('{}'), url: 'http://[invalid' }, [], [{ key: 'password', value: seed }]); expect(() => JSON.parse(failed.body)).not.toThrow(); expect(JSON.stringify(failed)).not.toContain(seed);
  });
  it('keeps trusted raw scopes in a detached nonserialized channel across success, skip and failures', async () => {
    const f = await fixture(); const secret = 'SEEDED-INTERNAL-STATE';
    const cases = [f.request('{}'), { ...f.request('{}'), maxResponseBytes: 1 }, { ...f.request('{}'), timeoutMs: 0 }, { ...f.request('{}'), preRequestScript: 'pm.execution.skipRequest();' }];
    for (const request of cases) {
      const result = await HttpExecutor.execute(request, [], [{ key: 'password', value: secret }, { key: 'ref', value: reference, secret: true }]);
      const state = getExecutionState(result)!; expect(state.environment.password).toBe(secret); state.environment.password = 'mutated'; expect(getExecutionState(result)!.environment.password).toBe(secret);
      expect(result.updatedEnvironment.password).not.toBe(secret); expect(result.updatedEnvironment.ref).toBe(reference); expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(getExecutionState({} as any)).toBeUndefined();
  });
  it('bounds combined JSON credential expansion before sending bytes', async () => {
    const f = await fixture(); const result = await HttpExecutor.execute({ ...f.request(JSON.stringify({ a: reference, b: reference })), maxRequestBytes: 200 }, [], [], { resolveCredential: async () => 'x'.repeat(120) });
    expect(result.status).toBe(0); expect(result.error.code).toBe('ERR_REQUEST_LIMIT'); expect(f.bodies).toEqual([]);
  });

});
