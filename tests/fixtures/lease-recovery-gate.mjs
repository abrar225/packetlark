// Filesystem fault adapter for the public CLI seam. Never used by product code.
import fs from "node:fs";
const [workspace, token, readyFile, releaseFile] = process.argv.slice(2);
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (
    String(from).endsWith(".writer-lock") &&
    String(to).includes(".writer-recovered-")
  ) {
    fs.writeFileSync(readyFile, "ready");
    const deadline = Date.now() + 8000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(releaseFile)) {
      if (Date.now() > deadline) throw new Error("Recovery gate expired");
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  rename(from, to);
};
const { main } = await import("../../dist/cli.js");
try {
  process.exitCode = await main([
    "workspace",
    "recover",
    "--workspace",
    workspace,
    "--token",
    token,
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
