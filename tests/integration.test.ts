import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StudioServer } from '../src/server/StudioServer.js';

describe('StudioServer & Live Sniffer Integration', () => {
  let server: StudioServer;
  const serverPort = 4199;
  const snifferPort = 8199;

  beforeAll(async () => {
    server = new StudioServer(serverPort, snifferPort);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('reports healthy status and ultra-low memory baseline (<40MB)', async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('healthy');
    expect(data.snifferActive).toBe(true);
    expect(Number(data.memoryRssMb)).toBeLessThan(100);
  });

  it('executes an HTTP request with timing metrics', async () => {
    const reqPayload = {
      request: {
        method: 'GET',
        url: 'https://httpbin.org/get?test=1',
        headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
        queryParams: [],
        body: { mode: 'none' },
        auth: { type: 'none' },
        testScript: `
          pm.test("Status is 200", function() {
            pm.expect(pm.response.code).to.equal(200);
          });
        `
      }
    };

    const res = await fetch(`http://localhost:${serverPort}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqPayload)
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe(200);
    expect(data.timings.totalMs).toBeGreaterThan(0);
    expect(data.testResults.length).toBe(1);
    expect(data.testResults[0].passed).toBe(true);
  });

  it('sniffs live traffic and auto-reconstructs OpenAPI 3.1 & TypeScript SDK', async () => {
    // 1. Send request through the Sniffer Proxy on port 8199
    const sniffedRes = await fetch(`http://localhost:${snifferPort}/https://httpbin.org/json`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ReaIntegrationTest'
      }
    });

    expect(sniffedRes.status).toBe(200);

    // 2. Query captured traffic list from Studio API
    const trafficRes = await fetch(`http://localhost:${serverPort}/api/sniff/traffic`);
    const trafficList = await trafficRes.json();
    expect(trafficList.length).toBeGreaterThan(0);

    const captured = trafficList.find((t: any) => t.url.includes('httpbin.org/json'));
    expect(captured).toBeDefined();
    expect(captured.responseStatus).toBe(200);

    // 3. Auto-generate OpenAPI 3.1.0 specification
    const openApiRes = await fetch(`http://localhost:${serverPort}/api/sniff/export/openapi`, {
      method: 'POST'
    });
    const spec = await openApiRes.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/json']).toBeDefined();
    expect(spec.paths['/json'].get.responses['200']).toBeDefined();

    // 4. Auto-generate TypeScript Client SDK
    const sdkRes = await fetch(`http://localhost:${serverPort}/api/sniff/export/sdk`, {
      method: 'POST'
    });
    const sdkCode = await sdkRes.text();
    expect(sdkCode).toContain('export class');
    expect(sdkCode).toContain('getJson');
    expect(sdkCode).toContain('GetJsonResponse');
  });
});
