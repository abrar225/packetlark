import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { ScriptSandbox } from "../src/core/engine/ScriptSandbox.js";
const collection = (url: string, script: string) => ({
  info: {
    name: "Integration",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item: [
    {
      name: "Probe",
      request: { method: "GET", url },
      event: [{ listen: "test", script: { exec: [script] } }],
    },
  ],
});
async function cli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const p = spawn(process.execPath, ["bin/rea-api.js", ...args]);
      let stdout = "",
        stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", reject);
      p.on("exit", (code) => resolve({ code, stdout, stderr }));
    },
  );
}
describe("packaged entry points", () => {
  it("preserves scopes when a script times out", async () => {
    const result = await ScriptSandbox.executeAsync(
      "while(true) {}",
      {},
      undefined,
      {
        environment: { token: "keep" },
        collection: { root: "keep" },
        timeoutMs: 50,
      },
    );
    expect(result.updatedEnvironment).toEqual({ token: "keep" });
    expect(result.updatedCollectionVariables).toEqual({ root: "keep" });
    expect(result.testResults[0].passed).toBe(false);
  });
  it("runs real CLI subprocesses with JSON/JUnit and useful exit codes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rea-cli-"));
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address() as { port: number };
    try {
      const file = path.join(root, "collection.json");
      await writeFile(
        file,
        JSON.stringify(
          collection(
            `http://127.0.0.1:${address.port}`,
            'pm.test("ok",()=>pm.response.to.have.status(200));',
          ),
        ),
      );
      const pass = await cli(["run", file, "--reporter", "json"]);
      expect(pass.stderr).toBe("");
      expect(pass.code).toBe(0);
      expect(JSON.parse(pass.stdout).summary.passed).toBe(1);
      expect(
        JSON.parse(pass.stdout).executions[0].response.body,
      ).toBeUndefined();
      await writeFile(
        file,
        JSON.stringify(
          collection(
            `http://127.0.0.1:${address.port}`,
            'pm.test("bad",()=>pm.expect(1).to.equal(2));',
          ),
        ),
      );
      const fail = await cli(["run", file, "--reporter", "junit"]);
      expect(fail.code).toBe(1);
      expect(fail.stdout).toContain("<failure");
      expect((await cli(["invalid-command"])).code).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  });
  it("negotiates actual stdio MCP, lists collections and rejects path traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rea-mcp-"));
    await mkdir(path.join(root, ".rea-api/collections"), { recursive: true });
    await writeFile(
      path.join(root, ".rea-api/collections/demo.json"),
      JSON.stringify({ id: "demo", name: "Demo", variables: [], items: [] }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("bin/rea-api.js"), "mcp", "--workspace", root],
      stderr: "pipe",
    });
    const client = new Client({ name: "rea-test", version: "1" });
    try {
      await client.connect(transport);
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name).sort()).toEqual([
        "list_collections",
        "run_collection",
        "send_request",
      ]);
      const result = await client.callTool({
        name: "list_collections",
        arguments: {},
      });
      expect(
        JSON.parse((result.content as any)[0].text).collections[0],
      ).toEqual({ id: "demo", name: "Demo", requests: 0 });
      const denied = await client.callTool({
        name: "run_collection",
        arguments: { collectionId: "../outside" },
      });
      expect(denied.isError).toBe(true);
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
