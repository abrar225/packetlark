// A controlled local capture soak. Run with node --expose-gc; no live workspace or external target.
import http from "node:http";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { TrafficSnifferProxy } from "../dist/core/sniffing/TrafficSnifferProxy.js";
const durationMs = 10 * 60 * 1000,
  intervalMs = 15000;
const proxy = new TrafficSnifferProxy(0, {
  maxHistoryBytes: 64 * 1024,
  maxRecordBytes: 4096,
  maxConcurrentRequests: 4,
  timeoutMs: 2000,
});
const payload = JSON.stringify({ message: "x".repeat(1024) });
const target = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(payload);
});
const observations = [];
const start = performance.now();
let requests = 0;
try {
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const endpoint = await proxy.start();
  const url = `http://127.0.0.1:${endpoint}/http://127.0.0.1:${target.address().port}/fixture`;
  do {
    const batchStart = performance.now();
    for (let index = 0; index < 1000; index += 4)
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(response.status, 200);
          await response.arrayBuffer();
          requests++;
        }),
      );
    globalThis.gc?.();
    const mem = process.memoryUsage(),
      capture = proxy.getCaptureStats();
    assert.equal(capture.activeRequests, 0);
    assert.ok(capture.retainedBytes <= 64 * 1024);
    assert.ok(capture.retainedRecords <= 500);
    observations.push({
      elapsed_ms: Math.round(performance.now() - start),
      requests,
      heap_used_mib: +(mem.heapUsed / 1024 ** 2).toFixed(3),
      rss_mib: +(mem.rss / 1024 ** 2).toFixed(3),
      capture,
    });
    process.stderr.write(
      `soak ${Math.round((performance.now() - start) / 1000)}s: ${requests} requests, ${capture.retainedBytes} retained bytes\n`,
    );
    if (performance.now() - start < durationMs)
      await delay(
        Math.min(
          Math.max(0, intervalMs - (performance.now() - batchStart)),
          durationMs - (performance.now() - start),
        ),
      );
  } while (performance.now() - start < durationMs);
  const median = (values) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const growth =
    median(observations.slice(-5).map((row) => row.heap_used_mib)) -
    median(observations.slice(0, 5).map((row) => row.heap_used_mib));
  assert.ok(
    growth <= 8,
    `Reference-machine post-GC median heap grew ${growth} MiB; investigate before closing P0`,
  );
  console.log(
    JSON.stringify(
      {
        measured_at: new Date().toISOString(),
        source_commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        node: process.version,
        platform: process.platform,
        cpu: os.cpus()[0].model,
        elapsed_ms: Math.round(performance.now() - start),
        requests,
        forced_gc_available: typeof globalThis.gc === "function",
        methodology:
          "10 minute loopback soak, 1000 requests per batch, four concurrent clients, 15 second batch cadence, 1 KiB JSON. Post-GC heap medians compare first/last five batches; 8 MiB is an investigation threshold for this fixture/reference machine, not a universal leak guarantee. RSS includes client, target and proxy; no browser or Postman comparison.",
        post_gc_median_heap_growth_mib: +growth.toFixed(3),
        verdict: "PASS",
        observations,
      },
      null,
      2,
    ),
  );
} finally {
  await proxy.stop();
  target.closeAllConnections();
  await new Promise((resolve) => target.close(resolve));
}
