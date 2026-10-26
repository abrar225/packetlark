import { PostmanConverter } from './PostmanConverter.js';
import type { ApiCollection } from './types.js';

export interface SemanticDifference {
  path: string;
  kind: 'added' | 'removed' | 'changed';
}
export interface ImportReport {
  format: 'postman-v2.1';
  preserved: boolean;
  requestCount: number;
  warnings: string[];
  differences: SemanticDifference[];
}
const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const pairs = (rows: any[] = []) => rows.map((row) => ({
  ...row, value: row.value == null ? '' : String(row.value),
  disabled: row.disabled === true, type: row.type || 'string',
}));

/** Independent Postman-side projection: ignore representational defaults and
 * generated identities, retain ordering, disabled rows and opaque fields.
 * Never includes raw field values in the resulting difference report. */
function semantics(input: any): any {
  const source = structuredClone(input);
  const authorization = (auth: any) => {
    if (!auth) return undefined;
    return { ...auth, ...(Array.isArray(auth[auth.type]) ? { [auth.type]: pairs(auth[auth.type]) } : {}) };
  };
  const url = (input: any) => {
    const result = typeof input === 'string' ? { raw: input } : { ...input };
    let raw = result.raw || '';
    if (!raw && result.host) {
      raw = `${result.protocol || 'https'}://${Array.isArray(result.host) ? result.host.join('.') : result.host}${result.port ? ':' + result.port : ''}/${Array.isArray(result.path) ? result.path.join('/') : result.path || ''}`;
    }
    const hashAt = raw.indexOf('#');
    const hash = hashAt < 0 ? '' : raw.slice(hashAt);
    const head = hashAt < 0 ? raw : raw.slice(0, hashAt);
    const queryAt = head.indexOf('?');
    result.query = pairs(result.query || [...new URLSearchParams(queryAt < 0 ? '' : head.slice(queryAt + 1))].map(([key, value]) => ({ key, value })));
    result.raw = (queryAt < 0 ? head : head.slice(0, queryAt)) + hash;
    return result;
  };
  const body = (value: any) => {
    if (!value?.mode) return undefined;
    const result = { ...value };
    if (value.mode === 'raw') {
      const language = value.options?.raw?.language || (/^\s*[\[{]/.test(value.raw || '') ? 'json' : 'text');
      result.options = { ...value.options, raw: { ...value.options?.raw, language } };
      result.raw = value.raw || '';
    }
    if (value.mode === 'formdata' || value.mode === 'urlencoded') result[value.mode] = pairs(value[value.mode]);
    return result;
  };
  const item = (value: any): any => {
    const result = { ...value };
    delete result.id;
    result.event = value.event || [];
    if (Array.isArray(value.item) && !value.request) {
      result.item = value.item.map(item);
      result.variable = pairs(value.variable);
      result.auth = authorization(value.auth);
    } else {
      const req = typeof value.request === 'string' ? { url: value.request } : value.request || {};
      result.request = { ...req, method: (req.method || 'GET').toUpperCase(),
        header: pairs(req.header), auth: authorization(req.auth), body: body(req.body), url: url(req.url) };
    }
    return result;
  };
  delete source.info?._postman_id;
  delete source.info?.id;
  return { ...source, info: { ...source.info, name: source.info?.name || 'Imported collection', description: source.info?.description || '', schema: source.info?.schema || schema },
    auth: authorization(source.auth), event: source.event || [], variable: pairs(source.variable), item: source.item.map(item) };
}

/** Compare original/exported Postman documents without comparing converter
 * output to itself. JSON pointer paths reveal losses without revealing secrets. */
export function comparePostmanSemantics(before: any, after: any): SemanticDifference[] {
  const differences: SemanticDifference[] = [];
  function visit(left: any, right: any, path: string) {
    if (left === right) return;
    if (left === undefined || right === undefined) {
      differences.push({ path: path || '/', kind: left === undefined ? 'added' : 'removed' });
    } else if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) {
      differences.push({ path: path || '/', kind: 'changed' });
    } else {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
        visit(left[key], right[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    }
  }
  visit(semantics(before), semantics(after), '');
  return differences;
}

export function reportPostmanImport(source: any): { collection: ApiCollection; report: ImportReport } {
  const collection = PostmanConverter.fromPostman(source);
  const differences = comparePostmanSemantics(source, PostmanConverter.toPostman(collection));
  let requestCount = 0;
  const count = (items: ApiCollection['items']) => { for (const item of items) item.isFolder ? count(item.items || []) : requestCount++; };
  count(collection.items);
  return { collection, report: { format: 'postman-v2.1', preserved: differences.length === 0,
    requestCount, warnings: collection.importWarnings || [], differences } };
}
