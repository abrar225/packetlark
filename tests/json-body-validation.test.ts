import { it, expect } from 'vitest';
import { validateJsonBody } from '../src/core/engine/JsonBodyValidation.js';

it('validates JSON scalars and 2020-12 schemas without coercing the submitted body', async () => {
  await expect(validateJsonBody('false')).resolves.toBeUndefined();
  await expect(validateJsonBody('{"count":2}', { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false })).resolves.toBeUndefined();
  await expect(validateJsonBody('{"count":"2"}', { type: 'object', properties: { count: { type: 'integer' } } })).rejects.toMatchObject({ code: 'ERR_JSON_SCHEMA' });
  await expect(validateJsonBody('{"password":"fixture-secret"')).rejects.toMatchObject({ code: 'ERR_INVALID_JSON' });
});

it('rejects remote references, unsupported schema modes and overdeep structures before worker dispatch', async () => {
  await expect(validateJsonBody('{}', { $ref: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'ERR_JSON_SCHEMA' });
  await expect(validateJsonBody('{}', { $ref: 'http://127.0.0.1:1/private' })).rejects.toMatchObject({ code: 'ERR_JSON_SCHEMA' });
  await expect(validateJsonBody('{}', { $schema: 'http://json-schema.org/draft-04/schema#' })).rejects.toMatchObject({ code: 'ERR_JSON_SCHEMA' });
  let schema: any = { type: 'string' }; for (let i = 0; i < 40; i++) schema = { properties: { nested: schema } };
  await expect(validateJsonBody('{}', schema)).rejects.toMatchObject({ code: 'ERR_JSON_LIMIT' });
});

it('terminates expensive validation and allows a later job after cancellation', async () => {
  const controller = new AbortController();
  const task = validateJsonBody(JSON.stringify('a'.repeat(100) + '!'), { type: 'string', pattern: '^(a+)+$' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await expect(task).rejects.toMatchObject({ code: 'ERR_ABORTED' });
  await expect(validateJsonBody('{}')).resolves.toBeUndefined();
  await expect(validateJsonBody('"' + 'a'.repeat(100) + '!"', { type: 'string', pattern: '^(a+)+$' }, { timeoutMs: 150 })).rejects.toMatchObject({ code: 'ERR_JSON_TIMEOUT' });
});
