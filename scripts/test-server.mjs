import { StudioServer } from "../dist/server/StudioServer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "rea-browser-"));
const server = new StudioServer(4050, 8095, dir);
await server.start();
console.log("Isolated browser test studio: http://localhost:4050/studio");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
