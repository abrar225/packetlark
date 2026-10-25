// Loopback reference only: no external APIs, user workspaces, telemetry or competitor timing.
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TrafficSnifferProxy } from "../dist/core/sniffing/TrafficSnifferProxy.js";
import { StudioServer } from "../dist/server/StudioServer.js";
const samples = 200,
  warmup = 20;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rea-p0-bench-"));
const payload = JSON.stringify({ message: "x".repeat(1024) });
const target = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(payload);
});
const proxy = new TrafficSnifferProxy(0);
const studio = new StudioServer(0, 0, workspace);
let peakRss = process.memoryUsage().rss;
const observe = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const sampler = setInterval(observe, 10);
const percentile = (values, percentile) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * percentile) - 1];
const summary = (values) => ({
  samples: values.length,
  p50_ms: +percentile(values, 0.5).toFixed(3),
  p95_ms: +percentile(values, 0.95).toFixed(3),
});
try {
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${target.address().port}`;
  const proxyPort = await proxy.start();
  const start = performance.now();
  const studioPort = await studio.start();
  const startupMs = performance.now() - start;
  const urls = {
    direct: origin,
    capture: `http://127.0.0.1:${proxyPort}/${origin}`,
    workspace_list: `http://127.0.0.1:${studioPort}/api/collections`,
  };
  const timings = { direct: [], capture: [], workspace_list: [] };
  for (let i = 0; i < warmup + samples; i++) {
    const entries = Object.entries(urls);
    if (i % 2) entries.reverse();
    for (const [key, url] of entries) {
      const begin = performance.now();
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`Benchmark ${key} failed: ${response.status}`);
      await response.arrayBuffer();
      if (i >= warmup) timings[key].push(performance.now() - begin);
      observe();
    }
  }
  let dirty = false;
  try {
    execFileSync("git", ["diff", "--quiet"]);
  } catch {
    dirty = true;
  }
  console.log(
    JSON.stringify(
      {
        measured_at: new Date().toISOString(),
        source_commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        tracked_changes_present: dirty,
        runtime: {
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          cpu: os.cpus()[0].model,
          memory_gib: +(os.totalmem() / 1024 ** 3).toFixed(1),
        },
        methodology: {
          samples_per_path: samples,
          warmup_per_path: warmup,
          order: "alternating direct/capture/workspace sequence",
          transport:
            "sequential loopback HTTP, 1 KiB JSON response; timers include body consumption",
          startup:
            "one module-warm StudioServer.start; excludes module/process/browser startup",
          rss: "sampled process RSS across target, two proxies, studio and benchmark client; not isolated or guaranteed peak",
        },
        timings: Object.fromEntries(
          Object.entries(timings).map(([key, value]) => [key, summary(value)]),
        ),
        module_warm_studio_start_ms: +startupMs.toFixed(3),
        sampled_process_rss_max_mib: +(peakRss / 1024 ** 2).toFixed(2),
        retained_capture: proxy.getCaptureStats(),
        limitations: [
          "No Postman measurement or speed comparison.",
          "Not a cold-start, browser responsiveness, concurrency/load, large-payload or long-duration leak test.",
          "Single-machine observation; rerun before setting release performance gates.",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(sampler);
  await proxy.stop();
  await studio.stop();
  target.closeAllConnections();
  await new Promise((resolve) => target.close(resolve));
  fs.rmSync(workspace, { recursive: true, force: true });
}
