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
      const p = spawn(process.execPath, ["bin/packetlark.js", ...args]);
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
    const root = await mkdtemp(path.join(tmpdir(), "packetlark-cli-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "packetlark-mcp-"));
    await mkdir(path.join(root, ".packetlark/collections"), { recursive: true });
    await writeFile(
      path.join(root, ".packetlark/collections/demo.json"),
      JSON.stringify({ id: "demo", name: "Demo", variables: [], items: [] }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("bin/packetlark.js"), "mcp", "--workspace", root],
      stderr: "pipe",
    });
    const client = new Client({ name: "packetlark-test", version: "1" });
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
  it("redacts initial and intermediate rotated marked secrets in real CLI JSON and JUnit reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "packetlark-cli-rotations-"));
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const file = path.join(root, "collection.json"),
        environment = path.join(root, "environment.json");
      await writeFile(
        environment,
        JSON.stringify({
          id: "env",
          name: "Env",
          values: [{ key: "opaque", value: "initial-secret", secret: true }],
        }),
      );
      await writeFile(
        file,
        JSON.stringify(
          collection(
            `http://127.0.0.1:${(server.address() as any).port}`,
            `
        pm.environment.set("opaque", "rotation-one-secret");
        pm.test("rotation-one-secret", () => pm.expect("rotation-one-secret").to.equal("different"));
        pm.environment.set("opaque", "rotation-two-secret");
        pm.test("rotation-two-secret", () => pm.expect("rotation-two-secret").to.equal("different"));
      `,
          ),
        ),
      );
      for (const reporter of ["json", "junit"]) {
        const result = await cli([
          "run",
          file,
          "--environment",
          environment,
          "--reporter",
          reporter,
        ]);
        expect(result.code).toBe(1);
        for (const secret of [
          "initial-secret",
          "rotation-one-secret",
          "rotation-two-secret",
        ])
          expect(result.stdout + result.stderr).not.toContain(secret);
        if (reporter === "json")
          expect(JSON.parse(result.stdout).status).toBe("failed");
        else expect(result.stdout).toContain("<failure");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns valid MCP reports for short secrets and redacts intermediate rotations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "packetlark-mcp-secrets-"));
    await mkdir(path.join(root, ".packetlark/collections"), { recursive: true });
    await mkdir(path.join(root, ".packetlark/environments"), { recursive: true });
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("bin/packetlark.js"), "mcp", "--workspace", root],
      stderr: "pipe",
    });
    const client = new Client({ name: "packetlark-secret-test", version: "1" });
    try {
      await writeFile(
        path.join(root, ".packetlark/collections/demo.json"),
        JSON.stringify({
          id: "demo",
          name: "Demo",
          variables: [],
          items: [
            {
              id: "req",
              name: "Request",
              request: {
                id: "req",
                method: "GET",
                url: `http://127.0.0.1:${(server.address() as any).port}`,
                headers: [],
                queryParams: [],
                body: { mode: "none" },
                auth: { type: "none" },
                testScript: `pm.environment.set("opaque","mcp-rotation-one");pm.test("mcp-rotation-one",()=>pm.expect(false).to.equal(true));pm.environment.set("opaque","mcp-rotation-two");`,
              },
            },
          ],
        }),
      );
      await client.connect(transport);
      for (const value of ["1", ":", "[edge]+(secret)\\path"]) {
        await writeFile(
          path.join(root, ".packetlark/environments/private.json"),
          JSON.stringify({
            id: "private",
            name: "Private",
            values: [{ key: "opaque", value, secret: true }],
          }),
        );
        const result = await client.callTool({
          name: "run_collection",
          arguments: { collectionId: "demo", environmentId: "private" },
        });
        const serialized = (result.content as any)[0].text,
          report = JSON.parse(serialized);
        expect(report.status).toBe("failed");
        expect(report.summary.requests).toBe(1);
        expect(serialized).not.toContain("mcp-rotation-one");
        expect(serialized).not.toContain("mcp-rotation-two");
      }
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not echo malformed input contents through CLI diagnostics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "packetlark-json-errors-"));
    try {
      const file = path.join(root, "invalid.json");
      await writeFile(file, "KEYSEED");
      const result = await cli(["run", file]);
      expect(result.code).toBe(2);
      expect(result.stdout + result.stderr).not.toContain("KEYSEED");
      expect(result.stderr).toContain("Malformed JSON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
