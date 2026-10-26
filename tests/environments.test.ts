import { startHttpFixture } from './http-fixture.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StudioServer } from '../src/server/StudioServer.js';
import fs from 'node:fs';
import path from 'node:path';

describe('StudioServer Environment Management & Request Persistence', () => {
  let target: Awaited<ReturnType<typeof startHttpFixture>>;
  beforeAll(async()=>{target=await startHttpFixture();});
  afterAll(async()=>{await target.stop();});
  let server: StudioServer;
  const testWorkspace = mkdtempSync(join(tmpdir(), 'packetlark-test-'));
  const serverPort = 4288;
  const snifferPort = 8288;

  beforeAll(async () => {
    server = new StudioServer(serverPort, snifferPort, testWorkspace);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    rmSync(testWorkspace, { recursive: true, force: true });
  });

  it('handles environment creation, listing, and deletion', async () => {
    // 1. Create environment
    const createRes = await fetch(`http://localhost:${serverPort}/api/environments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Staging Env',
        values: [{ key: 'apiUrl', value: 'https://staging.example.com', enabled: true }]
      })
    });

    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created.id).toBeDefined();
    expect(created.name).toBe('Staging Env');

    // 2. Fetch single environment
    const getSingleRes = await fetch(`http://localhost:${serverPort}/api/environments/${created.id}`);
    expect(getSingleRes.status).toBe(200);
    const singleEnv = await getSingleRes.json();
    expect(singleEnv.name).toBe('Staging Env');

    // 3. Update environment via PUT
    const putRes = await fetch(`http://localhost:${serverPort}/api/environments/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Staging Env' })
    });
    expect(putRes.status).toBe(200);
    const updated = await putRes.json();
    expect(updated.name).toBe('Updated Staging Env');

    // 4. List environments
    const listRes = await fetch(`http://localhost:${serverPort}/api/environments`);
    const list = await listRes.json();
    const found = list.find((e: any) => e.id === created.id);
    expect(found).toBeDefined();
    expect(found.name).toBe('Updated Staging Env');

    // 5. Delete environment
    const delRes = await fetch(`http://localhost:${serverPort}/api/environments/${created.id}`, {
      method: 'DELETE'
    });
    expect(delRes.status).toBe(200);
  });

  it('persists requests to collection via /api/collections/:id/requests', async () => {
    // 1. Fetch collections
    const colRes = await fetch(`http://localhost:${serverPort}/api/collections`);
    const collections = await colRes.json();
    expect(collections.length).toBeGreaterThan(0);
    const targetCol = collections[0];

    // 2. Save a new request
    const newReqId = 'req_persist_' + Date.now();
    const saveRes = await fetch(`http://localhost:${serverPort}/api/collections/${targetCol.id}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: {
          id: newReqId,
          name: 'Persisted Dynamic Request',
          method: 'GET',
          url: `${target.url}/get`,
          headers: [],
          queryParams: [],
          body: { mode: 'none' },
          auth: { type: 'none' }
        }
      })
    });

    expect(saveRes.status).toBe(200);
    const savedData = await saveRes.json();
    expect(savedData.ok).toBe(true);

    // 3. Verify it is present in collection list
    const reloadRes = await fetch(`http://localhost:${serverPort}/api/collections`);
    const reloaded = await reloadRes.json();
    const updatedCol = reloaded.find((c: any) => c.id === targetCol.id);
    expect(updatedCol.items.some((i: any) => i.id === newReqId)).toBe(true);

    // 4. Test GET /api/collections/:id and GET /api/collections/:id/export/postman
    const getColRes = await fetch(`http://localhost:${serverPort}/api/collections/${targetCol.id}`);
    expect(getColRes.status).toBe(200);
    const fetchedCol = await getColRes.json();
    expect(fetchedCol.id).toBe(targetCol.id);

    const exportPostmanRes = await fetch(`http://localhost:${serverPort}/api/collections/${targetCol.id}/export/postman`);
    expect(exportPostmanRes.status).toBe(200);
    const exportedPostman = await exportPostmanRes.json();
    expect(exportedPostman.info.schema).toContain('v2.1.0');
    expect(exportedPostman.item.some((i: any) => i.name === 'Persisted Dynamic Request')).toBe(true);

    // 5. Delete request
    const delReqRes = await fetch(`http://localhost:${serverPort}/api/collections/${targetCol.id}/requests/${newReqId}`, {
      method: 'DELETE'
    });
    expect(delReqRes.status).toBe(200);
  });

  it.each(['token', 'counter'])('applies persistence policy to script mutations of %s with environmentId', async (key) => {
    const initialValue = `${key}-initial-value`;
    const mutatedValue = `${key}-script-value`;
    // 1. Create temporary environment
    const createRes = await fetch(`http://localhost:${serverPort}/api/environments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'AutoSync Test Env',
        values: [{ key, value: initialValue, enabled: true }]
      })
    });
    const env = await createRes.json();

    // 2. Execute request that mutates environment variable
    const execRes = await fetch(`http://localhost:${serverPort}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environmentId: env.id,
        request: {
          method: 'GET',
          url: `${target.url}/get`,
          headers: [],
          queryParams: [],
          body: { mode: 'none' },
          auth: { type: 'none' },
          testScript: `pm.environment.set(${JSON.stringify(key)}, ${JSON.stringify(mutatedValue)});`
        }
      })
    });

    expect(execRes.status).toBe(200);
    const execData = await execRes.json();
    expect(execData.updatedVariables[key]).toBe(key === 'token' ? '[REDACTED]' : mutatedValue);
    expect(execData.persistence.environment).toMatchObject(key === 'token'
      ? { status: 'failed', code: 'ERR_SECRET_PERSISTENCE' }
      : { status: 'saved' });
    if (key === 'token') expect(JSON.stringify(execData)).not.toContain(mutatedValue);

    // 3. Fetch environments and verify disk persistence
    const checkRes = await fetch(`http://localhost:${serverPort}/api/environments`);
    const envList = await checkRes.json();
    const updatedEnv = envList.find((e: any) => e.id === env.id);
    const storedValue = updatedEnv.values.find((v: any) => v.key === key)?.value;
    expect(storedValue).toBe(key === 'token' ? initialValue : mutatedValue);

    // Cleanup
    await fetch(`http://localhost:${serverPort}/api/environments/${env.id}`, { method: 'DELETE' });
  });

  it('handles top-level route errors gracefully without crashing the server', async () => {
    // Call execute with missing url to trigger structured 400
    const errRes = await fetch(`http://localhost:${serverPort}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: {} })
    });

    expect(errRes.status).toBe(400);
    const errData = await errRes.json();
    expect(errData.error).toContain('url is required');

    // Call unknown endpoint
    const notFoundRes = await fetch(`http://localhost:${serverPort}/api/nonexistent-route`);
    expect(notFoundRes.status).toBe(404);
  });
});
