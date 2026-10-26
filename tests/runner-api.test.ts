import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { StudioServer } from "../src/server/StudioServer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
describe("runner workbench API", () => {
  const workspace = mkdtempSync(join(tmpdir(), "packetlark-run-api-"));
  const studio = new StudioServer(0, 0, workspace);
  const peer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  let origin = "";
  let targetOrigin = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    targetOrigin = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
    origin = `http://127.0.0.1:${await studio.start()}`;
  });
  afterAll(async () => {
    await studio.stop();
    await new Promise<void>((resolve, reject) => peer.close((error) => error ? reject(error) : resolve()));
    rmSync(workspace, { recursive: true, force: true });
  });
  const post = (endpoint: string, body: any) =>
    fetch(origin + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const source = (script: string) => ({
    info: { name: "API checks" },
    variable: [{ key: "base", value: targetOrigin }],
    event: [
      {
        listen: "test",
        script: {
          exec: ['pm.test("Parent",()=>pm.response.to.have.status(200));'],
        },
      },
    ],
    item: [
      {
        name: "Health",
        request: { url: "{{base}}/api/health", method: "GET" },
        event: [{ listen: "prerequest", script: { exec: [script] } }],
      },
    ],
  });
  it("returns actionable 400 responses for malformed JSON and invalid import", async () => {
    expect(
      (
        await fetch(origin + "/api/import/postman", {
          method: "POST",
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect((await post("/api/import/postman", { wrong: true })).status).toBe(
      400,
    );
    expect(
      (
        await post("/api/import/curl", {
          curl: "curl --unsupported https://example.com",
        })
      ).status,
    ).toBe(400);
  });
  it("resolves inherited scripts during single execution and preserves disabled environment entries", async () => {
    const collection = await (
      await post(
        "/api/import/postman",
        source('pm.environment.set("created","yes");'),
      )
    ).json();
    const env = await (
      await post("/api/environments", {
        name: "Scoped",
        values: [
          { key: "disabled", value: "keep", enabled: false },
          { key: "active", value: "keep", enabled: true },
        ],
      })
    ).json();
    const result = await (
      await post("/api/execute", {
        request: collection.items[0].request,
        collectionId: collection.id,
        environmentId: env.id,
      })
    ).json();
    expect(result.testResults[0].passed).toBe(true);
    const saved = await (
      await fetch(origin + "/api/environments/" + env.id)
    ).json();
    expect(saved.values).toContainEqual({
      key: "disabled",
      value: "keep",
      enabled: false,
    });
    expect(saved.values.find((v) => v.key === "created").value).toBe("yes");
  });
  it("starts, polls and cancels bounded runs", async () => {
    const collection = await (
      await post("/api/import/postman", source(""))
    ).json();
    const created = await post("/api/runs", {
      collectionId: collection.id,
      iterations: 2,
      delayMs: 5000,
    });
    expect(created.status).toBe(202);
    const job = await created.json();
    expect((await post("/api/runs/" + job.id + "/cancel", {})).status).toBe(
      200,
    );
    let state: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await (await fetch(origin + "/api/runs/" + job.id)).json();
      if (state.state === "completed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(state.state).toBe("completed");
    expect(state.result.status).toBe("cancelled");
    expect(state.result.summary.requests).toBe(0);
  });
  it("keeps run API reports and downloadable assertions free of rotated marked secrets", async () => {
    const imported = await (
      await post(
        "/api/import/postman",
        source(
          `pm.environment.set("opaque","api-rotation-one"); pm.test("api-rotation-one",()=>pm.expect(false).to.equal(true)); pm.environment.set("opaque","api-rotation-two");`,
        ),
      )
    ).json();
    const env = await (
      await post("/api/environments", {
        name: "Private",
        values: [{ key: "opaque", value: "api-initial-secret", secret: true }],
      })
    ).json();
    const job = await (
      await post("/api/runs", {
        collectionId: imported.id,
        environmentId: env.id,
      })
    ).json();
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = await (await fetch(origin + "/api/runs/" + job.id)).json();
      if (state.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(state.state).toBe("completed");
    expect(state.result.status).toBe("failed");
    const serialized = JSON.stringify(state);
    for (const secret of [
      "api-initial-secret",
      "api-rotation-one",
      "api-rotation-two",
    ])
      expect(serialized).not.toContain(secret);
    expect(state.result.environment).toBeUndefined();
  });
  it("bounds aggregate completed run history by bytes as well as count", async () => {
    const collection = await (
      await post(
        "/api/import/postman",
        source(
          'const label="x".repeat(4096);for(let i=0;i<1000;i++)pm.test(label,()=>pm.expect(true).to.equal(true));',
        ),
      )
    ).json();
    const jobs: string[] = [];
    for (let n = 0; n < 4; n++) {
      const job = await (
        await post("/api/runs", { collectionId: collection.id, iterations: 3 })
      ).json();
      jobs.push(job.id);
      let state: any;
      for (let i = 0; i < 200; i++) {
        state = await (await fetch(origin + "/api/runs/" + job.id)).json();
        if (state.state === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(state.result.status).toBe("passed");
      expect(state.result.summary.requests).toBe(3);
    }
    expect((await fetch(origin + "/api/runs/" + jobs[0])).status).toBe(404);
    expect((await fetch(origin + "/api/runs/" + jobs[3])).status).toBe(200);
    const health = await (await fetch(origin + "/api/health")).json();
    expect(health.runHistory.retainedBytes).toBeLessThanOrEqual(
      32 * 1024 * 1024,
    );
  }, 20000);
});
