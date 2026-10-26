import { startHttpFixture } from './http-fixture.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HttpExecutor, normalizeNetworkError } from '../src/core/engine/HttpExecutor.js';
import { HttpRequest } from '../src/core/models/types.js';

describe('HttpExecutor Hardening & Error Normalization', () => {
  let target: Awaited<ReturnType<typeof startHttpFixture>>;
  beforeAll(async()=>{target=await startHttpFixture();});
  afterAll(async()=>{await target.stop();});
  it('auto-prefixes http:// for bare URLs without protocol', async () => {
    const req: HttpRequest = {
      method: 'GET',
      url: `${target.url.replace('http://', '')}/get?autoPrefix=true`,
      headers: [],
      queryParams: [],
      body: { mode: 'none' },
      auth: { type: 'none' }
    };

    const res = await HttpExecutor.execute(req);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.args.autoPrefix).toBe('true');
  });

  it('normalizes DNS and network failures into clean structured errors without stack traces', async () => {
    const req: HttpRequest = {
      method: 'GET',
      url: 'http://packetlark-executor-fixture.invalid',
      headers: [],
      queryParams: [],
      body: { mode: 'none' },
      auth: { type: 'none' }
    };

    const res = await HttpExecutor.execute(req);
    expect(res.status).toBe(0);
    expect(res.error).toBeDefined();
    expect(res.error?.category).toMatch(/DNS Resolution Failed|Network Error/);
    expect(res.error?.guidance).toBeDefined();
    // Verify no host local path leakage
    expect(res.body).not.toContain('C:\\Users\\');
    expect(res.body).not.toContain('node:internal');
  });

  it('correctly maps error codes via normalizeNetworkError helper', () => {
    const dnsErr = normalizeNetworkError({ code: 'ENOTFOUND' }, 'https://api.fake.com');
    expect(dnsErr.category).toBe('DNS Resolution Failed');
    expect(dnsErr.message).toContain('api.fake.com');

    const connRefused = normalizeNetworkError({ code: 'ECONNREFUSED' }, 'http://localhost:9999');
    expect(connRefused.category).toBe('Connection Refused');
    expect(connRefused.message).toContain('9999');

    const timeoutErr = normalizeNetworkError({ code: 'ETIMEDOUT' });
    expect(timeoutErr.category).toBe('Request Timeout');

    const invalidUrl = normalizeNetworkError({ name: 'TypeError', message: 'Invalid URL' }, 'bad url');
    expect(invalidUrl.category).toBe('Invalid Request URL');
  });

  it('dispatches multipart/form-data and x-www-form-urlencoded requests', async () => {
    // 1. URL encoded
    const urlEncodedReq: HttpRequest = {
      method: 'POST',
      url: `${target.url}/post`,
      headers: [],
      queryParams: [],
      body: {
        mode: 'x-www-form-urlencoded',
        formData: [
          { key: 'username', value: 'packetlark_user', enabled: true },
          { key: 'disabledField', value: 'skip_me', enabled: false }
        ]
      },
      auth: { type: 'none' }
    };

    const urlEncodedRes = await HttpExecutor.execute(urlEncodedReq);
    expect(urlEncodedRes.status).toBe(200);
    const urlBody = JSON.parse(urlEncodedRes.body);
    expect(urlBody.form.username).toBe('packetlark_user');
    expect(urlBody.form.disabledField).toBeUndefined();

    // 2. Form data
    const formDataReq: HttpRequest = {
      method: 'POST',
      url: `${target.url}/post`,
      headers: [],
      queryParams: [],
      body: {
        mode: 'form-data',
        formData: [
          { key: 'uploadKey', value: 'binaryPayloadValue', enabled: true }
        ]
      },
      auth: { type: 'none' }
    };

    const formDataRes = await HttpExecutor.execute(formDataReq);
    expect(formDataRes.status).toBe(200);
    const formBody = JSON.parse(formDataRes.body);
    expect(formBody.form.uploadKey).toBe('binaryPayloadValue');
  });

  it('returns updatedVariables mutated by pre-request and test scripts', async () => {
    const req: HttpRequest = {
      method: 'GET',
      url: `${target.url}/get`,
      headers: [],
      queryParams: [],
      body: { mode: 'none' },
      auth: { type: 'none' },
      preRequestScript: `pm.environment.set("preVar", "123");`,
      testScript: `pm.environment.set("testVar", "456");`
    };

    const res = await HttpExecutor.execute(req);
    expect(res.status).toBe(200);
    expect(res.updatedVariables?.preVar).toBe('123');
    expect(res.updatedVariables?.testVar).toBe('456');
  });

  it('handles empty or whitespace-only URL defensively and returns ERR_EMPTY_URL', async () => {
    const req: HttpRequest = {
      method: 'GET',
      url: '   ',
      headers: [],
      queryParams: [],
      body: { mode: 'none' },
      auth: { type: 'none' }
    };

    const res = await HttpExecutor.execute(req);
    expect(res.status).toBe(0);
    expect(res.error?.code).toBe('ERR_EMPTY_URL');
    expect(res.error?.category).toBe('Invalid Request URL');
  });

  it('normalizes lowercase HTTP methods (e.g. get, post) without throwing', async () => {
    const req: HttpRequest = {
      method: 'get' as any,
      url: `${target.url}/get`,
      headers: [],
      queryParams: [],
      body: { mode: 'none' },
      auth: { type: 'none' }
    };

    const res = await HttpExecutor.execute(req);
    expect(res.status).toBe(200);
  });

  it('removes Content-Type header variants case-insensitively for form-data to preserve boundary', async () => {
    const req: HttpRequest = {
      method: 'POST',
      url: `${target.url}/post`,
      headers: [{ key: 'CONTENT-TYPE', value: 'application/json', enabled: true }],
      queryParams: [],
      body: {
        mode: 'form-data',
        formData: [{ key: 'field1', value: 'value1', enabled: true }]
      },
      auth: { type: 'none' }
    };

    const res = await HttpExecutor.execute(req);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.form.field1).toBe('value1');
  });
});
