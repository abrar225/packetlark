// Isolated fixture: never points at the user's .packetlark workspace.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StudioServer } from "../dist/server/StudioServer.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "packetlark-p0-browser-"));
const target = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  setTimeout(
    () => res.end(JSON.stringify({ owner: req.url, headers: req.headers })),
    req.url.startsWith("/slow") ? 800 : 0,
  );
});
await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
const targetPort = target.address().port;
const studio = new StudioServer(0, 0, root);
const port = await studio.start();
const req = (id, name, url) => ({
  id,
  name,
  method: "GET",
  url: `http://127.0.0.1:${targetPort}${url}`,
  headers: [],
  queryParams: [],
  body: { mode: "none" },
  auth: { type: "none" },
});
await fetch(`http://127.0.0.1:${port}/api/collections`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: "race_fixture",
    name: "Race fixture",
    schemaVersion: "2.1.0",
    variables: [],
    items: [
      {
        id: "race_a",
        name: "Race A",
        request: req("race_a", "Race A", "/slow-a"),
      },
      {
        id: "race_b",
        name: "Race B",
        request: req("race_b", "Race B", "/fast-b"),
      },
    ],
  }),
});
if (process.argv.includes("--manifest")) studio.migrate(studio.migrationPlan().checksum);
if (process.argv.includes("--large")) {
  for (let group = 0; group < 20; group++) {
    const collection = {
      id: `benchmark_${group}`,
      name: `Benchmark ${group}`,
      schemaVersion: "2.1.0",
      variables: [],
      items: Array.from({ length: 500 }, (_, index) => {
        const id = `benchmark_${group * 500 + index}`;
        return {
          id,
          name: `Benchmark request ${group * 500 + index}`,
          request: {
            ...req(id, `Benchmark request ${group * 500 + index}`, "/fast"),
            body: { mode: "none" },
          },
        };
      }),
    };
    const response = await fetch(`http://127.0.0.1:${port}/api/collections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collection),
    });
    if (!response.ok)
      throw new Error(`Large fixture creation failed: ${response.status}`);
  }
}
console.log(
  JSON.stringify({
    port,
    url: `http://127.0.0.1:${port}/studio`,
    workspace: root,
  }),
);
async function stop() {
  await studio.stop();
  target.closeAllConnections();
  await new Promise((resolve) => target.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
