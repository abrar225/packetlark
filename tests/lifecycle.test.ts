import { it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StudioServer } from "../src/server/StudioServer.js";
it("stopping Studio cancels an active direct execution and closes its upstream connection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "packetlark-stop-"));
  let received: () => void, closed: () => void;
  const started = new Promise<void>((resolve) => (received = resolve)),
    upstreamClosed = new Promise<void>((resolve) => (closed = resolve));
  const target = http.createServer((_req, res) => {
    res.once("close", closed);
    received();
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const studio = new StudioServer(0, 0, root);
  const port = await studio.start();
  try {
    const running = fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          method: "GET",
          url: `http://127.0.0.1:${(target.address() as any).port}`,
          headers: [],
          queryParams: [],
          body: { mode: "none" },
          auth: { type: "none" },
          timeoutMs: 2000,
        },
      }),
    }).catch(() => null);
    await started;
    const start = performance.now();
    await studio.stop();
    expect(performance.now() - start).toBeLessThan(500);
    await running;
    await upstreamClosed;
  } finally {
    await studio.stop();
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("admits at most two direct executions while keeping cancellation available", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "packetlark-admission-"));
  let count = 0,
    received: () => void;
  const started = new Promise<void>((resolve) => (received = resolve));
  const target = http.createServer((_req, res) => {
    if (++count === 2) received();
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const studio = new StudioServer(0, 0, root);
  const port = await studio.start();
  const execute = (url: string) =>
    fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          method: "GET",
          url,
          headers: [],
          queryParams: [],
          body: { mode: "none" },
          auth: { type: "none" },
          timeoutMs: 2000,
        },
      }),
    }).catch(() => null);
  const running = [
    execute(`http://127.0.0.1:${(target.address() as any).port}`),
    execute(`http://127.0.0.1:${(target.address() as any).port}`),
  ];
  try {
    await started;
    const rejected = await execute(`http://127.0.0.1:${port}/api/health`);
    expect(rejected?.status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(
      200,
    );
  } finally {
    await studio.stop();
    await Promise.all(running);
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it("rejects an oversized declared API body before waiting for its bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "packetlark-body-"));
  const studio = new StudioServer(0, 0, root);
  const port = await studio.start();
  let request: http.ClientRequest;
  try {
    const response = new Promise<number>((resolve) => {
      request = http.request(
        `http://127.0.0.1:${port}/api/execute`,
        {
          method: "POST",
          headers: {
            "Content-Length": String(2 * 1024 * 1024 + 1),
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode!));
        },
      );
      request.on("error", () => {});
      request.end();
    });
    expect(
      await Promise.race([
        response,
        new Promise((resolve) => setTimeout(() => resolve(0), 300)),
      ]),
    ).toBe(413);
  } finally {
    request?.destroy();
    await studio.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
