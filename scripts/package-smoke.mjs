import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const dir = await mkdtemp(path.join(tmpdir(), "packetlark-package-"));
function run(command, args, cwd = dir) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { cwd });
    let out = "",
      err = "";
    p.stdout.on("data", (x) => (out += x));
    p.stderr.on("data", (x) => (err += x));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err + "\n" + out)),
    );
  });
}
try {
  const archive = (
    await run(
      "npm",
      ["pack", "--ignore-scripts", "--silent", "--pack-destination", dir],
      process.cwd(),
    )
  ).trim();
  const tarball = path.join(dir, archive);
  await run("npm", ["install", "--omit=dev", "--ignore-scripts", tarball]);
  assert.match(
    await run(process.execPath, [
      "node_modules/packetlark/bin/packetlark.js",
      "--help",
    ]),
    /packetlark run/,
  );
  await writeFile(
    path.join(dir, "collection.json"),
    JSON.stringify({
      item: [
        {
          name: "Skip",
          request: { url: "http://127.0.0.1:1" },
          event: [
            {
              listen: "prerequest",
              script: { exec: ["pm.execution.skipRequest();"] },
            },
          ],
        },
      ],
    }),
  );
  const report = JSON.parse(
    await run(process.execPath, [
      "node_modules/packetlark/bin/packetlark.js",
      "run",
      "collection.json",
      "--reporter",
      "json",
    ]),
  );
  assert.equal(report.summary.skipped, 1);
  console.log(
    "PASS: fresh production-only tarball installation executes WASM scripts and CLI without source/dev dependencies",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
