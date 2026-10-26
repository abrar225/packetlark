import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { PostmanConverter } from "../src/core/models/PostmanConverter.js";
import { collectionRequests } from "../src/core/models/CollectionContext.js";
import { HttpExecutor, getExecutionState } from "../src/core/engine/HttpExecutor.js";
import {
  CollectionRunner,
  junitReport,
} from "../src/core/runner/CollectionRunner.js";
import { ScriptSandbox } from "../src/core/engine/ScriptSandbox.js";
import { parseCsv } from "../src/core/runner/DataFile.js";
let target: http.Server,
  origin: string,
  calls = 0;
beforeAll(async () => {
  target = http.createServer((req, res) => {
    calls++;
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname === "/redirect") {
      res.writeHead(302, {
        "Set-Cookie": "session=packetlark; Path=/",
        Location: "/echo",
      });
      res.end();
      return;
    }
    if (url.pathname === "/binary") {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(Buffer.from([0, 255, 128, 1]));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/slow") {
      res.flushHeaders();
      setTimeout(() => res.end("{}"), 80);
      return;
    }
    res.end(
      JSON.stringify({
        url: req.url,
        auth: req.headers.authorization,
        cookie: req.headers.cookie,
      }),
    );
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  origin = `http://127.0.0.1:${(target.address() as any).port}`;
});
afterAll(() => new Promise<void>((resolve) => target.close(() => resolve())));
const request = (extra: any = {}) => ({
  id: "req",
  name: "Request",
  method: "GET" as const,
  url: origin + "/echo",
  headers: [],
  queryParams: [],
  auth: { type: "none" as const },
  body: { mode: "none" as const },
  ...extra,
});
const collection = (items: any[], extra: any = {}) => ({
  id: "col",
  name: "Collection",
  schemaVersion: "2.1.0",
  variables: [],
  items: items.map((r, i) => ({
    id: r.id || String(i),
    name: r.name || String(i),
    request: r,
  })),
  ...extra,
});
describe("Postman migration conformance", () => {
  it("uses one query representation and preserves disabled and repeated keys", async () => {
    const col = PostmanConverter.fromPostman({
      info: { name: "Query" },
      item: [
        {
          request: {
            url: {
              raw: origin + "/echo?tag=x&skip=y",
              query: [
                { key: "tag", value: "x" },
                { key: "tag", value: "z" },
                { key: "skip", value: "y", disabled: true },
              ],
            },
          },
        },
      ],
    });
    const req = collectionRequests(col)[0].request;
    const res = await HttpExecutor.execute(req);
    expect(JSON.parse(res.body).url).toBe("/echo?tag=x&tag=z");
    const round = PostmanConverter.fromPostman(PostmanConverter.toPostman(col));
    expect(round.items[0].request?.queryParams).toEqual(
      col.items[0].request?.queryParams,
    );
  });
  it("inherits collection/folder auth and scripts while respecting explicit noauth", () => {
    const col = PostmanConverter.fromPostman({
      info: { name: "Inheritance" },
      auth: { type: "bearer", bearer: [{ key: "token", value: "root" }] },
      event: [
        { listen: "prerequest", script: { exec: ['console.log("root")'] } },
      ],
      item: [
        {
          name: "Folder",
          auth: { type: "basic", basic: [{ key: "username", value: "user" }] },
          event: [
            { listen: "test", script: { exec: ['console.log("folder")'] } },
          ],
          item: [
            { name: "Inherited", request: { url: origin } },
            {
              name: "Public",
              request: { url: origin, auth: { type: "noauth" } },
            },
          ],
        },
      ],
    });
    const [a, b] = collectionRequests(col);
    expect(a.request.auth.type).toBe("basic");
    expect(a.request.preRequestScripts).toEqual(['console.log("root")']);
    expect(a.request.testScripts).toEqual(['console.log("folder")']);
    expect(b.request.auth.type).toBe("none");
    const exported = PostmanConverter.toPostman(col);
    expect(exported.item[0].auth.type).toBe("basic");
    expect(exported.item[0].item[0].request.auth).toBeUndefined();
  });
  it("preserves raw text and unsupported OAuth without silently weakening authentication", async () => {
    const col = PostmanConverter.fromPostman({
      info: { name: "Bodies" },
      item: [
        {
          request: {
            url: origin,
            auth: {
              type: "oauth2",
              oauth2: [{ key: "accessToken", value: "example" }],
            },
            body: {
              mode: "raw",
              raw: "hello",
              options: { raw: { language: "text" } },
            },
          },
        },
      ],
    });
    expect(col.items[0].request?.body.mode).toBe("raw-text");
    expect(col.importWarnings?.length).toBe(1);
    expect(
      (await HttpExecutor.execute(col.items[0].request!)).error?.code,
    ).toBe("ERR_UNSUPPORTED");
    expect(PostmanConverter.toPostman(col).item[0].request.auth.type).toBe(
      "oauth2",
    );
  });
  it("keeps string URLs, variables and non-model fields across export", () => {
    const col = PostmanConverter.fromPostman({
      info: { name: "Metadata" },
      variable: [{ key: "zero", value: 0 }],
      item: [
        {
          name: "String URL",
          response: [{ name: "example" }],
          request: origin + "/echo?a=1",
        },
      ],
    });
    expect(col.variables[0].value).toBe("0");
    expect(PostmanConverter.toPostman(col).item[0].response).toEqual([
      { name: "example" },
    ]);
  });
  it("tokenizes cURL without executing shell text and rejects unhandled options", () => {
    expect(
      PostmanConverter.fromCurl(
        `curl '${origin}/echo' --data-raw '{"name":"O'"'"'Brien"}'`,
      ).body.raw,
    ).toBe('{"name":"O\'Brien"}');
    expect(() =>
      PostmanConverter.fromCurl(`curl ${origin} --cert private.pem`),
    ).toThrow("Unsupported cURL option");
    expect(() =>
      PostmanConverter.fromCurl(`curl ${origin} -d @secret.txt`),
    ).toThrow("no local file was read");
  });
});
describe("Interpreter and request reliability", () => {
  it("runs real Chai deep equality, regex and async callback assertions", async () => {
    const res = await ScriptSandbox.executeAsync(
      `pm.test('deep',()=>pm.expect({a:1,b:2}).to.deep.equal({b:2,a:1}));pm.test('async',done=>setTimeout(()=>{pm.expect('packetlark').to.match(/^packet/);done();},5));`,
      {},
    );
    expect(res.testResults).toHaveLength(2);
    expect(res.testResults.every((t) => t.passed)).toBe(true);
  });
  it("does not expose host process, module loading or host object prototypes", () => {
    const result = ScriptSandbox.execute(
      `pm.test('host',()=>{pm.expect(typeof process).to.equal('undefined');pm.expect(typeof require).to.equal('undefined');pm.expect(typeof globalThis.Buffer).to.equal('undefined');});pm.test('constructor',()=>pm.expect(()=>({}).constructor.constructor('return process')()).to.throw());`,
      {},
    );
    expect(result.testResults.every((t) => t.passed)).toBe(true);
  });
  it("bounds CPU execution and rejects oversized scripts", () => {
    const started = Date.now();
    const result = ScriptSandbox.execute("while(true){}", {}, undefined, {
      timeoutMs: 100,
    });
    expect(result.testResults.some((t) => !t.passed)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(
      ScriptSandbox.execute("x".repeat(1024 * 1024 + 1), {}).testResults[0]
        .error,
    ).toContain("1 MiB");
  });
  it("executes pm.sendRequest without exposing a host function or object", async () => {
    const result = await HttpExecutor.execute(
      request({
        preRequestScript: `pm.sendRequest('${origin}/echo', (err,res)=>{pm.test('nested',()=>pm.expect(res.code).to.equal(200));pm.environment.set('nested','yes');});`,
      }),
    );
    expect(result.status).toBe(200);
    expect(result.updatedEnvironment?.nested).toBe("yes");
    expect(result.testResults?.every((t) => t.passed)).toBe(true);
  });
  it("stops before network dispatch on pre-request failure", async () => {
    const before = calls;
    const result = await HttpExecutor.execute(
      request({ preRequestScript: 'throw new Error("broken setup")' }),
    );
    expect(result.error?.code).toBe("ERR_PREREQUEST");
    expect(calls).toBe(before);
  });
  it("keeps local, iteration, collection and environment scopes separate", async () => {
    const result = await HttpExecutor.execute(
      request({
        testScript: `pm.variables.set('token','local');pm.environment.set('envOnly','yes');pm.collectionVariables.set('collectionOnly','yes');pm.test('precedence',()=>pm.expect(pm.variables.get('priority')).to.equal('data'));`,
      }),
      [{ key: "token", value: "collection" }],
      [{ key: "token", value: "env" }],
      { iterationData: { priority: "data" } },
    );
    expect(getExecutionState(result)?.variables.token).toBe("local");
    expect(getExecutionState(result)?.environment.token).toBe("env");
    expect(result.updatedVariables?.token).toBe("*****");
    expect(result.updatedEnvironment?.token).toBe("***");
    expect(getExecutionState(result)?.environment.collectionOnly).toBeUndefined();
    expect(getExecutionState(result)?.collection.collectionOnly).toBe("yes");
  });
  it("keeps binary bytes intact and measures headers separately from body completion", async () => {
    const binary = await HttpExecutor.execute(
      request({ url: origin + "/binary" }),
    );
    expect(Buffer.from(binary.bodyBase64!, "base64")).toEqual(
      Buffer.from([0, 255, 128, 1]),
    );
    const slow = await HttpExecutor.execute(request({ url: origin + "/slow" }));
    expect(slow.timings.totalMs - slow.timings.firstByteMs).toBeGreaterThan(30);
  });
  it("handles response bounds, timeout, user cancellation and cookie redirects", async () => {
    const bounded = await HttpExecutor.execute(
      request({ maxResponseBytes: 1 }),
    );
    expect(bounded.error?.code).toBe("ERR_RESPONSE_LIMIT");
    const timed = await HttpExecutor.execute(
      request({ url: origin + "/slow", timeoutMs: 10 }),
    );
    expect(timed.error?.category).toBe("Request Timeout");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await HttpExecutor.execute(request(), [], [], {
      signal: controller.signal,
    });
    expect(cancelled.error?.code).toBe("ERR_ABORTED");
    const redirect = await HttpExecutor.execute(
      request({ url: origin + "/redirect" }),
    );
    expect(JSON.parse(redirect.body).cookie).toContain("session=packetlark");
  });
});
describe("Collection automation", () => {
  it("executes inherited scripts, data iterations, cookies and variable chaining", async () => {
    const col = collection(
      [
        request({
          id: "one",
          name: "Set",
          url: origin + "/redirect",
          testScript: `pm.environment.set('next','ready');pm.test('cookie',()=>pm.expect(pm.response.json().cookie).to.include('session=packetlark'));`,
        }),
        request({
          id: "two",
          name: "Use",
          url: origin + "/echo?data={{row}}&next={{next}}",
          testScript: `pm.test('chained',()=>pm.expect(pm.response.json().url).to.include('next=ready'));`,
        }),
      ],
      { preRequestScript: `pm.variables.set('inherited','yes');` },
    );
    const result = await CollectionRunner.run(col, {
      data: [{ row: "a" }, { row: "b" }],
    });
    expect(result.status).toBe("passed");
    expect(result.summary.requests).toBe(4);
    expect(result.summary.passed).toBe(4);
    expect(result.environment.values.find((v) => v.key === "next")?.value).toBe(
      "ready",
    );
  });
  it("bails on failure and escapes CI JUnit reports", async () => {
    const result = await CollectionRunner.run(
      collection([
        request({
          name: "<request>",
          testScript: `pm.test('<bad & assertion>',()=>pm.expect(1).to.equal(2));`,
        }),
        request({ id: "two" }),
      ]),
      { stopOnFailure: true },
    );
    expect(result.status).toBe("failed");
    expect(result.summary.requests).toBe(1);
    expect(junitReport(result)).toContain("&lt;bad &amp; assertion&gt;");
  });
  it("bounds request chaining loops and supports cancellation", async () => {
    const col = collection([
      request({ testScript: `pm.execution.setNextRequest('req');` }),
    ]);
    const result = await CollectionRunner.run(col, { maxRequests: 3 });
    expect(result.status).toBe("failed");
    expect(result.summary.requests).toBe(3);
    expect(result.error).toContain("budget");
    const abort = new AbortController();
    abort.abort();
    expect(
      (await CollectionRunner.run(col, { signal: abort.signal })).status,
    ).toBe("cancelled");
  });
  it("parses quoted CSV data and rejects malformed rows", () => {
    expect(parseCsv('name,note\r\n"Alex, A","line1\nline2"\r\n')).toEqual([
      { name: "Alex, A", note: "line1\nline2" },
    ]);
    expect(() => parseCsv("x,x\n1,2")).toThrow("unique");
    expect(() => parseCsv("x,y\n1")).toThrow("columns");
    expect(() => parseCsv('x\n"unfinished')).toThrow("Unterminated");
  });
});
