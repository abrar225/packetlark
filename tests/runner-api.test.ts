import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { StudioServer } from "../src/server/StudioServer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe("runner workbench API", () => {
  const workspace = mkdtempSync(join(tmpdir(), "rea-run-api-"));
  const studio = new StudioServer(0, 0, workspace);
  let origin = "";
  beforeAll(async () => {
    origin = `http://127.0.0.1:${await studio.start()}`;
  });
  afterAll(async () => {
    await studio.stop();
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
    variable: [{ key: "base", value: origin }],
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
});
