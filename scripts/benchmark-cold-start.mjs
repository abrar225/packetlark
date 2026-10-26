// Fresh CLI processes, disposable workspaces, installed dependencies; OS file caches are not flushed.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const samples = 30;
const measurements = [];
for (let i = 0; i < samples; i++) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "packetlark-cold-"));
  const start = performance.now();
  const child = spawn(
    process.execPath,
    [
      path.resolve("bin/packetlark.js"),
      "studio",
      "--port",
      "0",
      "--sniffer-port",
      "0",
      "--workspace",
      workspace,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  let output = "",
    errors = "";
  child.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-4096);
  });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CLI startup exceeded 10 seconds")),
        10000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`CLI exited before ready: ${errors}`));
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve({ url: match[0], readyMs: performance.now() - start });
        }
      });
    });
    const response = await fetch(ready.url + "/api/health", {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error("Cold fixture health failed");
    const health = await response.json();
    measurements.push({
      ready_ms: +ready.readyMs.toFixed(3),
      backend_rss_mib: +health.memoryRssMb,
    });
  } finally {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(kill);
    await rm(workspace, { recursive: true, force: true });
  }
}
const percentile = (key, fraction) =>
  [...measurements].map((row) => row[key]).sort((a, b) => a - b)[
    Math.ceil(samples * fraction) - 1
  ];
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
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpu: os.cpus()[0].model,
      methodology:
        "30 fresh CLI processes and fresh temporary workspaces; readiness includes module initialization and fsync-backed workspace seeding; installed dependencies and warm OS file caches; RSS from first health response, not guaranteed process peak or combined browser cost",
      summary: {
        ready_p50_ms: percentile("ready_ms", 0.5),
        ready_p95_ms: percentile("ready_ms", 0.95),
        backend_rss_p50_mib: percentile("backend_rss_mib", 0.5),
        backend_rss_p95_mib: percentile("backend_rss_mib", 0.95),
      },
      observations: measurements,
    },
    null,
    2,
  ),
);
