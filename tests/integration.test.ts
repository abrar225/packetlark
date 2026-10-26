import { startHttpFixture } from './http-fixture.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StudioServer } from '../src/server/StudioServer.js';

describe('StudioServer & Live Sniffer Integration', () => {
  let target: Awaited<ReturnType<typeof startHttpFixture>>;
  beforeAll(async()=>{target=await startHttpFixture();});
  afterAll(async()=>{await target.stop();});
  let server: StudioServer;
  const testWorkspace = mkdtempSync(join(tmpdir(), 'packetlark-test-'));
  const serverPort = 4199;
  const snifferPort = 8199;

  beforeAll(async () => {
    server = new StudioServer(serverPort, snifferPort, testWorkspace);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    rmSync(testWorkspace, { recursive: true, force: true });
  });

  it('reports server health and a numeric memory measurement', async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('healthy');
    expect(data.snifferActive).toBe(true);
    expect(Number(data.memoryRssMb)).toBeGreaterThan(0);
  });

  it('executes an HTTP request with timing metrics', async () => {
    const reqPayload = {
      request: {
        method: 'GET',
        url: `${target.url}/get?test=1`,
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
    expect(data.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(data.testResults.length).toBe(1);
    expect(data.testResults[0].passed).toBe(true);
  });

  it('sniffs live traffic and auto-reconstructs OpenAPI 3.1 & TypeScript SDK', async () => {
    // 1. Send request through the Sniffer Proxy on port 8199
    const sniffedRes = await fetch(`http://localhost:${snifferPort}/${target.url}/json`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PacketLarkIntegrationTest'
      }
    });

    expect(sniffedRes.status).toBe(200);

    // 2. Query captured traffic list from Studio API
    const trafficRes = await fetch(`http://localhost:${serverPort}/api/sniff/traffic`);
    const trafficList = await trafficRes.json();
    expect(trafficList.length).toBeGreaterThan(0);

    const captured = trafficList.find((t: any) => t.url.endsWith('/json'));
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
