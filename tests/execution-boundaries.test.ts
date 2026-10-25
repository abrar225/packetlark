import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { once } from "node:events";
import {
  CollectionRunner,
  reportWithoutBodies,
} from "../src/core/runner/CollectionRunner.js";
import { HttpExecutor } from "../src/core/engine/HttpExecutor.js";
let source: http.Server,
  destination: http.Server,
  origin: string,
  other: string;
const request = (extra: any = {}) => ({
  method: "GET" as const,
  url: origin + "/echo",
  headers: [],
  queryParams: [],
  body: { mode: "none" as const },
  auth: { type: "none" as const },
  ...extra,
});
beforeAll(async () => {
  const echo = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.headers));
  };
  destination = http.createServer(echo);
  destination.listen(0, "127.0.0.1");
  await once(destination, "listening");
  other = `http://127.0.0.1:${(destination.address() as any).port}`;
  source = http.createServer((req, res) => {
    if (req.url === "/same" || req.url === "/cross") {
      res.writeHead(302, {
        Location: (req.url === "/same" ? origin : other) + "/echo",
      });
      res.end();
    } else echo(req, res);
  });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");
  origin = `http://127.0.0.1:${(source.address() as any).port}`;
});
afterAll(async () => {
  for (const server of [source, destination]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
describe("public execution trust boundaries", () => {
  it("preserves same-origin API-key authentication and strips it on cross-origin redirects", async () => {
    for (const header of ["X-API-Key", "X-Custom-Credential"]) {
      const auth = {
        type: "apikey",
        apiKeyName: header,
        apiKeyValue: "redirect-secret",
        apiKeyIn: "header",
      };
      const headers = [
        { key: "Proxy-Authorization", value: "proxy-secret" },
        { key: "X-Trace", value: "trace" },
      ];
      const same = await HttpExecutor.execute(
        request({ url: origin + "/same", auth, headers }),
      );
      expect(JSON.parse(same.body)[header.toLowerCase()]).toBe(
        "redirect-secret",
      );
      const cross = await HttpExecutor.execute(
        request({ url: origin + "/cross", auth, headers }),
      );
      const observed = JSON.parse(cross.body);
      expect(observed[header.toLowerCase()]).toBeUndefined();
      expect(observed["proxy-authorization"]).toBeUndefined();
      expect(observed["x-trace"]).toBe("trace");
    }
  });
  it("bounds complete run results including logs, assertions and scope snapshots", async () => {
    const result = await CollectionRunner.run(
      {
        id: "bounded",
        name: "Bounded",
        schemaVersion: "2.1.0",
        variables: [],
        items: [
          {
            id: "req",
            name: "Request",
            request: request({
              id: "req",
              testScript: `for(let i=0;i<40;i++)console.log("x".repeat(4096));pm.environment.set("largeScope","x".repeat(32768));pm.test("a".repeat(32768),()=>pm.expect(1).to.equal(1));`,
            }),
          },
        ],
      },
      { iterations: 20, maxResultBytes: 64 * 1024 },
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("retention");
    expect(result.summary.requests).toBe(1);
    expect(result.retention.stopped).toBe(true);
    expect(result.retention.omittedExecutions).toBe(1);
  });

  it("applies a request deadline to pre-request scripts as well as network I/O", async () => {
    const start = performance.now();
    const result = await HttpExecutor.execute(
      request({
        timeoutMs: 20,
        preRequestScript:
          'setTimeout(()=>pm.environment.set("late","yes"),80);',
      }),
    );
    expect(result.status).toBe(0);
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(performance.now() - start).toBeLessThan(300);
  });

  it("bounds outbound bodies after recursive variable expansion", async () => {
    const result = await HttpExecutor.execute(
      request({
        method: "POST",
        maxRequestBytes: 1024,
        body: { mode: "raw-text", raw: "{{large}}{{large}}{{large}}" },
      }),
      [],
      [{ key: "large", value: "x".repeat(400) }],
    );
    expect(result.status).toBe(0);
    expect(result.error?.code).toBe("ERR_REQUEST_LIMIT");
    expect(result.transportAttempted).toBe(false);
  });

  it("counts serialized multipart overhead against the outbound body limit", async () => {
    const result = await HttpExecutor.execute(
      request({
        method: "POST",
        maxRequestBytes: 100,
        body: {
          mode: "form-data",
          formData: [{ key: "field", value: "x".repeat(50) }],
        },
      }),
    );
    expect(result.status).toBe(0);
    expect(result.error?.code).toBe("ERR_REQUEST_LIMIT");
    expect(result.transportAttempted).toBe(false);
  });

  it("redacts known JSON-body credentials and their common encoded forms from reports", async () => {
    const secret = "literal/body+secret";
    const forms = [
      secret,
      "literal%2Fbody%2Bsecret",
      Buffer.from(secret).toString("base64"),
    ];
    const result = await CollectionRunner.run({
      id: "private",
      name: "Private",
      schemaVersion: "2.1.0",
      variables: [],
      items: [
        {
          id: "req",
          name: "Request",
          request: request({
            id: "req",
            method: "POST",
            body: {
              mode: "raw-json",
              raw: JSON.stringify({ password: secret }),
            },
            testScript: forms
              .map(
                (value) =>
                  `pm.test(${JSON.stringify(value)},()=>pm.expect(false).to.equal(true));`,
              )
              .join("\n"),
          }),
        },
      ],
    });
    expect(result.status).toBe("failed");
    const report = JSON.stringify(reportWithoutBodies(result));
    for (const form of forms) expect(report).not.toContain(form);
  });
  it("keeps sanitized report bytes bounded when a marked secret is one character", async () => {
    const result = await CollectionRunner.run(
      {
        id: "short",
        name: "Short",
        schemaVersion: "2.1.0",
        variables: [],
        items: [
          {
            id: "req",
            name: "Request",
            request: request({
              id: "req",
              testScript:
                'for(let i=0;i<100;i++)pm.test("1".repeat(100),()=>pm.expect(true).to.equal(true));',
            }),
          },
        ],
      },
      {
        maxResultBytes: 64 * 1024,
        environment: {
          id: "env",
          name: "Env",
          values: [{ key: "opaque", value: "1", secret: true }],
        },
      },
    );
    expect(result.status).toBe("passed");
    const report = reportWithoutBodies(result),
      size = Buffer.byteLength(JSON.stringify(report));
    expect(size).toBeLessThanOrEqual(64 * 1024);
    expect(report.retention.retainedBytes).toBe(size);
    expect(report.summary.passed).toBe(100);
  });
});
