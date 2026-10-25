import { afterAll, beforeAll, describe, it, expect } from "vitest";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { OpenApiGenerator } from "../src/core/sniffing/OpenApiGenerator.js";
import { SdkGenerator } from "../src/core/sniffing/SdkGenerator.js";
import { TrafficSnifferProxy } from "../src/core/sniffing/TrafficSnifferProxy.js";

describe("public capture transport boundaries", () => {
  let target: http.Server,
    origin: string,
    proxy: TrafficSnifferProxy,
    port: number;
  beforeAll(async () => {
    target = http.createServer(async (req, res) => {
      if (req.url === "/cookie-secrets") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Set-Cookie", [
          "first=cookie-first-secret; Path=/",
          "second=cookie-second-secret; Path=/",
        ]);
        res.setHeader("Location", origin + "/?token=location-secret");
        res.end(
          JSON.stringify({
            echo: [
              "cookie-first-secret",
              "cookie-second-secret",
              "location-secret",
            ],
          }),
        );
        return;
      }
      if (req.url?.startsWith("/secrets")) {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Set-Cookie", "session=cookie-secret");
        res.end(
          JSON.stringify({
            echo: req.headers.authorization,
            password: "body-secret",
          }),
        );
        return;
      }
      if (req.url === "/downstream") {
        res.end(Buffer.alloc(16 * 1024 * 1024));
        return;
      }
      if (req.url === "/head") {
        res.setHeader("Content-Length", "1234");
        res.end();
        return;
      }
      if (req.url === "/large") {
        res.end(Buffer.alloc(65));
        return;
      }
      if (req.url === "/compressed") {
        res.writeHead(200, { "Content-Encoding": "gzip" });
        res.end(gzipSync(Buffer.alloc(1000)));
        return;
      }
      if (req.url === "/slow") {
        res.writeHead(200);
        res.flushHeaders();
        const timer = setInterval(() => res.write("x"), 40);
        res.once("close", () => clearInterval(timer));
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: origin + "/echo" });
        res.end();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(Buffer.concat(chunks));
      } catch {
        res.destroy();
      }
    });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    origin = `http://127.0.0.1:${(target.address() as any).port}`;
    proxy = new TrafficSnifferProxy(0, {
      maxRequestBytes: 32,
      maxResponseBytes: 64,
      timeoutMs: 300,
    });
    port = await proxy.start();
  });
  afterAll(async () => {
    await proxy.stop();
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });
  it("forwards a selected binary upload and response byte for byte", async () => {
    const bytes = Buffer.from([0, 255, 128, 192, 65, 13, 10, 0, 254]);
    const response = await fetch(`http://127.0.0.1:${port}/${origin}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
  it("rejects oversized uploads explicitly before forwarding", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/${origin}/echo`, {
      method: "POST",
      body: Buffer.alloc(33),
    });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("ERR_REQUEST_LIMIT");
  });

  it("bounds decoded upstream bytes including compressed expansion", async () => {
    for (const endpoint of ["/large", "/compressed"]) {
      const r = await fetch(`http://127.0.0.1:${port}/${origin}${endpoint}`);
      expect(r.status).toBe(502);
      expect((await r.json()).error.code).toBe("ERR_RESPONSE_LIMIT");
    }
  });
  it("times out slow bodies and leaves the proxy usable", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/${origin}/slow`);
    expect(r.status).toBe(504);
    expect((await r.json()).error.code).toBe("ERR_TIMEOUT");
    expect(
      (await fetch(`http://127.0.0.1:${port}/${origin}/echo`)).status,
    ).toBe(200);
  });
  it("preserves redirects as responses instead of silently following them", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/${origin}/redirect`, {
      redirect: "manual",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(origin + "/echo");
    await r.arrayBuffer();
  });
  it("shuts down active forwards and can restart", async () => {
    const active = fetch(`http://127.0.0.1:${port}/${origin}/slow`).catch(
      () => null,
    );
    await new Promise((r) => setTimeout(r, 30));
    const start = Date.now();
    await proxy.stop();
    expect(Date.now() - start).toBeLessThan(1000);
    await active;
    port = await proxy.start();
    expect(
      (await fetch(`http://127.0.0.1:${port}/${origin}/echo`)).status,
    ).toBe(200);
  });

  it("retains and publishes sanitized observations while forwarding original credentials", async () => {
    const secure = new TrafficSnifferProxy(0);
    const securePort = await secure.start();
    const published: any[] = [];
    const unsubscribe = secure.subscribe((item) => published.push(item));
    try {
      const r = await fetch(
        `http://127.0.0.1:${securePort}/${origin}/secrets?token=query-secret&tag=a&tag=b`,
        { headers: { Authorization: "Bearer header-secret" } },
      );
      expect((await r.json()).echo).toBe("Bearer header-secret");
      const observed = secure.getCapturedItems();
      expect(observed.length).toBe(1);
      const specification = OpenApiGenerator.generate(
        observed,
        "Safe capture",
        "1.0.0",
      );
      for (const values of [
        observed,
        published,
        specification,
        SdkGenerator.generateTypeScript(specification),
      ]) {
        const retained = JSON.stringify(values);
        for (const secret of [
          "header-secret",
          "query-secret",
          "body-secret",
          "cookie-secret",
        ])
          expect(retained).not.toContain(secret);
      }
      expect(observed[0].queryParamEntries[0]).toEqual(["token", "[REDACTED]"]);
      expect(
        observed[0].queryParamEntries.filter(([key]) => key === "tag"),
      ).toEqual([
        ["tag", "a"],
        ["tag", "b"],
      ]);
    } finally {
      unsubscribe();
      await secure.stop();
    }
  });

  it("bounds retained bytes and isolates nested subscriber/snapshot mutations", async () => {
    const bounded = new TrafficSnifferProxy(0, {
      maxHistoryBytes: 2048,
      maxRecordBytes: 1024,
    });
    let other: any;
    bounded.subscribe((item) => {
      item.responseBody.nested.value = "changed";
    });
    bounded.subscribe((item) => {
      other = item;
    });
    for (let i = 0; i < 10; i++)
      bounded.recordTraffic({
        id: String(i),
        timestamp: "2026-10-25T00:00:00Z",
        method: "GET",
        url: "http://example.test/",
        pathname: "/",
        queryParams: {},
        requestHeaders: {},
        responseHeaders: { "content-type": "application/json" },
        responseBody: { nested: { value: "original" }, text: "z".repeat(300) },
        responseStatus: 200,
        durationMs: 1,
      });
    expect(bounded.getCaptureStats().retainedBytes).toBeLessThanOrEqual(2048);
    expect(bounded.getCapturedItems().length).toBeLessThan(10);
    expect(other.responseBody.nested.value).toBe("original");
    const snapshot = bounded.getCapturedItems();
    snapshot[0].responseBody.nested.value = "tampered";
    expect(bounded.getCapturedItems()[0].responseBody.nested.value).toBe(
      "original",
    );
    bounded.clearCapturedItems();
    expect(bounded.getCaptureStats().retainedBytes).toBe(0);
  });
  it("rejects oversized chunked uploads without needing a Content-Length header", async () => {
    const result = await new Promise<{ status: number; body: any }>(
      (resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/${origin}/echo`,
          { method: "POST" },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode!, body: JSON.parse(body) }),
            );
          },
        );
        req.on("error", reject);
        req.write(Buffer.alloc(16));
        req.end(Buffer.alloc(17));
      },
    );
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe("ERR_REQUEST_LIMIT");
  });
  it("times out an unfinished incoming upload explicitly", async () => {
    const result = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}/${origin}/echo`,
        { method: "POST" },
        (res) => {
          res.resume();
          res.on("end", () => {
            resolve(res.statusCode!);
            req.destroy();
          });
        },
      );
      req.on("error", reject);
      req.write("x");
    });
    expect(result).toBe(504);
  });
  it("enforces concurrent-forward admission and releases it after client cancellation", async () => {
    const isolated = new TrafficSnifferProxy(0, {
      maxConcurrentRequests: 1,
      timeoutMs: 1000,
    });
    const endpoint = await isolated.start();
    const abort = new AbortController();
    try {
      const running = fetch(`http://127.0.0.1:${endpoint}/${origin}/slow`, {
        signal: abort.signal,
      }).catch(() => null);
      for (
        let i = 0;
        i < 50 && isolated.getCaptureStats().activeRequests !== 1;
        i++
      )
        await new Promise((r) => setTimeout(r, 5));
      const rejected = await fetch(
        `http://127.0.0.1:${endpoint}/${origin}/echo`,
      );
      expect(rejected.status).toBe(503);
      expect((await rejected.json()).error.code).toBe("ERR_CONCURRENCY");
      abort.abort();
      await running;
      for (let i = 0; i < 50 && isolated.getCaptureStats().activeRequests; i++)
        await new Promise((r) => setTimeout(r, 5));
      expect(isolated.getCaptureStats().activeRequests).toBe(0);
      expect(
        (await fetch(`http://127.0.0.1:${endpoint}/${origin}/echo`)).status,
      ).toBe(200);
    } finally {
      abort.abort();
      await isolated.stop();
    }
  });

  it("redacts every repeated form secret and nested sensitive leaf before publishing", () => {
    for (const body of [
      "password=first-secret&password=last-secret&echo=first-secret",
      {
        credentials: { value: "nested-secret", list: ["array-secret", 123456] },
        echo: ["nested-secret", "array-secret", "123456", 123456],
      },
    ]) {
      const isolated = new TrafficSnifferProxy(0);
      const published: any[] = [];
      isolated.subscribe((item) => published.push(item));
      isolated.recordTraffic({
        id: "secret-case",
        timestamp: "2026-10-25T00:00:00Z",
        method: "POST",
        url: "http://example.test/",
        pathname: "/",
        queryParams: {},
        requestHeaders: {
          "content-type":
            typeof body === "string"
              ? "application/x-www-form-urlencoded"
              : "application/json",
        },
        requestBody: body,
        responseStatus: 200,
        responseHeaders: { "content-type": "application/json" },
        responseBody: {
          echo: typeof body === "string" ? "first-secret" : "nested-secret",
        },
        durationMs: 1,
      });
      expect(isolated.getCapturedItems()).toHaveLength(1);
      for (const values of [published, isolated.getCapturedItems()])
        for (const secret of [
          "first-secret",
          "last-secret",
          "nested-secret",
          "array-secret",
          "123456",
        ])
          expect(JSON.stringify(values)).not.toContain(secret);
    }
  });

  it("releases a blocked downstream response at the total deadline", async () => {
    const isolated = new TrafficSnifferProxy(0, {
      maxResponseBytes: 20 * 1024 * 1024,
      timeoutMs: 500,
      maxConcurrentRequests: 1,
    });
    const endpoint = await isolated.start();
    let client: http.ClientRequest;
    try {
      await new Promise<void>((resolve, reject) => {
        client = http.get(
          `http://127.0.0.1:${endpoint}/${origin}/downstream`,
          (response) => {
            response.on("error", () => {});
            response.pause();
            if (response.statusCode !== 200)
              reject(
                new Error("Fixture did not reach the downstream write phase"),
              );
            else resolve();
          },
        );
        client.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 800));
      expect(isolated.getCaptureStats().activeRequests).toBe(0);
      expect(
        (await fetch(`http://127.0.0.1:${endpoint}/${origin}/echo`)).status,
      ).toBe(200);
    } finally {
      client?.destroy();
      await isolated.stop();
    }
  });

  it("preserves representation length on HEAD responses", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/${origin}/head`, {
      method: "HEAD",
    });
    expect(r.headers.get("content-length")).toBe("1234");
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  });

  it("caps open sockets including clients that never finish HTTP headers", async () => {
    const isolated = new TrafficSnifferProxy(0, {
      maxConnections: 2,
      timeoutMs: 1000,
    });
    const endpoint = await isolated.start();
    const sockets: net.Socket[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const socket = net.connect(endpoint, "127.0.0.1");
        sockets.push(socket);
        socket.on("error", () => {});
        await once(socket, "connect");
        socket.write("GET /");
      }
      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        fetch(`http://127.0.0.1:${endpoint}/${origin}/echo`, {
          signal: AbortSignal.timeout(500),
        }),
      ).rejects.toThrow();
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await isolated.stop();
    }
  });

  it("omits observations when complete redaction exceeds its traversal budget", () => {
    const isolated = new TrafficSnifferProxy(0);
    const published: unknown[] = [];
    isolated.subscribe((item) => published.push(item));
    const sensitive = Object.fromEntries(
      Array.from({ length: 129 }, (_, i) => [`secret${i}`, `seed-${i}`]),
    );
    isolated.recordTraffic({
      id: "too-many-secrets",
      timestamp: "2026-10-25T00:00:00Z",
      method: "POST",
      url: "http://example.test/",
      pathname: "/",
      queryParams: {},
      requestHeaders: {},
      requestBody: sensitive,
      responseStatus: 200,
      responseHeaders: {},
      responseBody: { echo: "seed-128" },
      durationMs: 1,
    });
    expect(isolated.getCapturedItems()).toEqual([]);
    expect(published).toEqual([]);
    expect(isolated.getCaptureStats().omittedRecords).toBe(1);
  });
  it("redacts echoed values from every response cookie and redirect query", async () => {
    const isolated = new TrafficSnifferProxy(0);
    const endpoint = await isolated.start();
    try {
      const response = await fetch(
        `http://127.0.0.1:${endpoint}/${origin}/cookie-secrets`,
      );
      expect((await response.json()).echo).toHaveLength(3);
      const retained = JSON.stringify(isolated.getCapturedItems());
      for (const secret of [
        "cookie-first-secret",
        "cookie-second-secret",
        "location-secret",
      ])
        expect(retained).not.toContain(secret);
    } finally {
      await isolated.stop();
    }
  });
});
