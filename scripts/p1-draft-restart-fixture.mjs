// Disposable parent owns the target/root; the real Studio CLI child can restart
// on the same origin without deleting the workspace. Never uses live .packetlark.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "packetlark-draft-restart-"));
const target = http.createServer((req, res) => res.end(JSON.stringify({ path: req.url })));
target.listen(0, "127.0.0.1");
await once(target, "listening");
let child, port = 0;
async function start() {
  child = spawn(process.execPath, ["bin/packetlark.js", "studio", "--workspace", root, "--port", String(port), "--sniffer-port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CLI startup timed out")), 10000);
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/studio/);
      if (match) { clearTimeout(timer); port = Number(match[1]); resolve(); }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`CLI exited before ready: ${code}`)); });
  });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/studio`, workspace: root, pid, parentPid: process.pid }));
}
async function stopChild() {
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
}
await start();
const response = await fetch(`http://127.0.0.1:${port}/api/collections`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "restart_fixture", name: "Restart fixture", variables: [], items: [{ id: "restart_request", name: "Restart request", request: { id: "restart_request", name: "Restart request", method: "GET", url: `http://127.0.0.1:${target.address().port}/restart`, headers: [], queryParams: [], body: { mode: "none" }, auth: { type: "none" } } }] }) });
if (!response.ok) throw new Error("Fixture creation failed");
let control = Promise.resolve();
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "restart") control = control.then(async () => { await stopChild(); await start(); }).catch((error) => console.error(error.message));
});
async function stop() {
  lines.close();
  await control;
  await stopChild();
  target.closeAllConnections();
  await new Promise((resolve) => target.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
