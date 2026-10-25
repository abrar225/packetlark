// Isolated fixture: never points at the user's .rea-api workspace.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StudioServer } from "../dist/server/StudioServer.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-p0-browser-"));
const target = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  setTimeout(
    () => res.end(JSON.stringify({ owner: req.url })),
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
