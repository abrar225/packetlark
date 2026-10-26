import { expect, it } from "vitest";
import { WorkbenchState, sanitizeExample } from "../src/core/workspace/WorkbenchState.js";

it("keeps late execution results with their live owning tab and bounds retained responses", () => {
  const state = new WorkbenchState();
  state.open("A", "A"); state.open("B", "B");
  const first = state.begin("A");
  state.finish("A", first, { status: 200, body: "A response" });
  expect(state.tabs.get("A")?.response.body).toBe("A response");
  expect(state.tabs.get("B")?.response).toBeUndefined();
  const older = state.begin("A"), newer = state.begin("A");
  expect(state.finish("A", older, { body: "obsolete" })).toBe(false);
  state.finish("A", newer, { body: "x".repeat(3 * 1024 * 1024) });
  expect(state.tabs.get("A")?.response.retentionWarning).toMatch(/preview/i);
  expect(state.retainedBytes()).toBeLessThanOrEqual(16 * 1024 * 1024);
  const token = state.begin("B"); state.close("B");
  expect(state.finish("B", token, { body: "closed" })).toBe(false);
  for (let i = 0; i < 19; i++) state.open(String(i), String(i));
  expect(() => state.open("overflow", "overflow")).toThrow(/20/);
});

it("expires older previews with an explicit notice while keeping their tabs and drafts addressable", () => {
  const state = new WorkbenchState();
  for (let i = 0; i < 9; i++) {
    const key = String(i); state.open(key, key);
    state.finish(key, state.begin(key), { status: 200, body: "x".repeat(1900 * 1024) });
  }
  expect(state.tabs.size).toBe(9);
  expect(state.retainedBytes()).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(state.tabs.get("0")?.response).toBeUndefined();
  expect(state.tabs.get("0")?.retentionNotice).toMatch(/expired.*16 MiB/);
  state.finish("0", state.begin("0"), { status: 200, body: "refreshed" });
  expect(state.tabs.get("0")?.retentionNotice).toBeUndefined();
});

it("excludes seeded credentials, scripts and binary inspection from reviewable saved examples", () => {
  const secret = "unique-credential-for-example";
  const value = sanitizeExample({ method: "POST", url: `http://alice:${secret}@example.test/items?api_key=${secret}`, headers: [{ key: "Authorization", value: `Bearer ${secret}` }], queryParams: [{ key: "token", value: secret }], auth: { type: "bearer", bearerToken: secret }, body: { mode: "raw-json", raw: JSON.stringify({ password: secret, visible: "kept" }) }, testScript: `console.log('${secret}')`, postman: { dangerous: secret } }, { status: 200, headers: { "set-cookie": `session=${secret}`, "content-type": "application/json" }, body: JSON.stringify({ token: secret, echo: encodeURIComponent(secret), visible: false }) }, []);
  expect(JSON.stringify(value)).not.toContain(secret);
  expect(value.request.auth.type).toBe("none");
  expect(value.request.testScript).toBeUndefined();
  expect(value.request.postman).toBeUndefined();
  expect(JSON.parse(value.response.body).visible).toBe(false);
});

it("learns sensitive query values from templated URLs before retaining examples", () => {
  const secret = "fixture-templated-query-secret";
  const value = sanitizeExample({ method: "GET", url: `{{baseUrl}}/items?api_key=${secret}`, headers: [], queryParams: [], auth: { type: "none" }, body: { mode: "none" } }, { status: 200, headers: {}, body: JSON.stringify({ echo: secret }) });
  expect(JSON.stringify(value)).not.toContain(secret);
  expect(value.request.url).toContain("{{baseUrl}}");
});

it("retains tolerant Basic credential redaction when the header uses base64url", () => {
  const secret = "portable-secret-???";
  const encoded = Buffer.from(`fixture:${secret}`).toString("base64url");
  expect(encoded).toMatch(/[-_]/);
  const value = sanitizeExample({ method: "GET", url: "https://fixture.invalid", headers: [{ key: "Authorization", value: `Basic ${encoded}` }], queryParams: [], auth: { type: "none" }, body: { mode: "none" } }, { status: 200, headers: {}, body: JSON.stringify({ echo: secret }) });
  expect(JSON.stringify(value)).not.toContain(secret);
  expect(() => JSON.parse(value.response.body)).not.toThrow();
});

it("keeps sanitized JSON parseable when sensitive JSON fields contain numeric values", () => {
  const value = sanitizeExample({ method: "POST", url: "https://fixture.invalid", headers: [], queryParams: [], auth: { type: "none" }, body: { mode: "raw-json", raw: JSON.stringify({ password: 123456789, visible: "kept" }) } }, { status: 200, headers: {}, body: JSON.stringify({ token: 987654321, visible: false }) });
  const requestBody = JSON.parse(value.request.body.raw);
  const responseBody = JSON.parse(value.response.body);
  expect(requestBody.password).toBe("[REDACTED]");
  expect(responseBody.token).toBe("[REDACTED]");
  expect(requestBody.visible).toBe("kept");
  expect(responseBody.visible).toBe(false);
});

it("bounds retained responses when assertion metadata itself exceeds the per-tab byte limit", () => {
  const state = new WorkbenchState();
  state.open("assertions", "Large assertion metadata");
  const token = state.begin("assertions");
  const response = {
    status: 200, statusText: "OK", body: "small response",
    timings: { totalMs: 12, unsupportedDetail: "t".repeat(3 * 1024 * 1024) },
    testResults: [{ name: "large assertion " + "n".repeat(3 * 1024 * 1024), passed: false, error: "e".repeat(3 * 1024 * 1024) }],
  };
  expect(state.finish("assertions", token, response)).toBe(true);
  expect(state.tabs.get("assertions")!.response.retentionWarning).toMatch(/preview/i);
  expect(state.retainedBytes()).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(state.tabs.get("assertions")!.response.status).toBe(200);
  expect(state.tabs.get("assertions")!.response.body).toBe("small response");
  expect(state.tabs.get("assertions")!.response.testResults[0].passed).toBe(false);
});

it("does not retain a known credential echoed as a JSON property name", () => {
  const secret = "fixtureZebraValueAlpha789";
  const value = sanitizeExample({ method: "GET", url: "https://fixture.invalid", headers: [], queryParams: [], auth: { type: "bearer", bearerToken: secret }, body: { mode: "none" } }, { status: 200, headers: {}, body: JSON.stringify({ [secret]: "echo", visible: true }) });
  expect(JSON.stringify(value)).not.toContain(secret);
  expect(() => JSON.parse(value.response.body)).not.toThrow();
  expect(JSON.parse(value.response.body).visible).toBe(true);
});
