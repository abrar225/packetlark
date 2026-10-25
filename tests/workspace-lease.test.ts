import { it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StudioServer } from "../src/server/StudioServer.js";
import { spawn } from "node:child_process";
import net from "node:net";

function launch(
  args: string[],
  entry = "bin/rea-api.js",
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const child = spawn(
    process.execPath,
    [path.resolve(entry), ...args],
    options,
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 8000);
  let stdout = "",
    stderr = "";
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(deadline);
        resolve({ code, signal });
      });
    },
  );
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-8192);
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(deadline);
        resolve(match[0]);
      }
    });
    child.once("error", reject);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  return { child, ready, exited, output: () => ({ stdout, stderr }) };
}

async function terminate(
  process: ReturnType<typeof launch>,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (process.child.exitCode !== null || process.child.signalCode !== null)
    return;
  process.child.kill(signal);
  const timer = setTimeout(() => process.child.kill("SIGKILL"), 2000);
  try {
    await process.exited;
  } finally {
    clearTimeout(timer);
  }
}

async function command(args: string[]) {
  const process = launch(args);
  try {
    return { ...(await process.exited), ...process.output() };
  } finally {
    await terminate(process);
  }
}

it("refuses a second workspace writer and releases ownership after stopping", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-"));
  let first: StudioServer, second: StudioServer, replacement: StudioServer;
  try {
    first = new StudioServer(0, 0, root);
    const port = await first.start();
    let failure: any;
    try {
      second = new StudioServer(0, 0, root);
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe("ERR_WORKSPACE_LOCKED");
    expect((await fetch(`http://127.0.0.1:${port}/api/collections`)).ok).toBe(
      true,
    );
    await first.stop();
    replacement = new StudioServer(0, 0, root);
    const next = await replacement.start();
    expect((await fetch(`http://127.0.0.1:${next}/api/collections`)).ok).toBe(
      true,
    );
  } finally {
    await second?.stop();
    await first?.stop();
    await replacement?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("releases ownership when startup fails before the HTTP server can listen", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-start-"));
  const failed = new StudioServer(-1, 0, root);
  let replacement: StudioServer;
  try {
    await expect(failed.start()).rejects.toThrow();
    replacement = new StudioServer(0, 0, root);
    const port = await replacement.start();
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
  } finally {
    await failed.stop();
    await replacement?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("admits exactly one of two competing real CLI writers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-race-"));
  const args = [
    "studio",
    "--port",
    "0",
    "--sniffer-port",
    "0",
    "--workspace",
    root,
  ];
  const contenders = [launch(args), launch(args)];
  try {
    const outcomes = await Promise.all(
      contenders.map((item) =>
        Promise.race([
          item.ready.then((url) => ({ ready: true, url })),
          item.exited.then((result) => ({ ready: false, ...result })),
        ]),
      ),
    );
    expect(outcomes.filter((item) => item.ready)).toHaveLength(1);
    const loser = outcomes.findIndex((item) => !item.ready);
    expect(outcomes[loser]).toMatchObject({ code: 2 });
    expect(contenders[loser].output().stderr).toContain(
      "Workspace is owned by process",
    );
  } finally {
    await Promise.all(contenders.map((item) => terminate(item)));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);

it("cannot start after shutdown has begun and shares concurrent startup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-lifecycle-"));
  const stopped = new StudioServer(0, 0, root);
  let running: StudioServer;
  try {
    const stop = stopped.stop();
    const late = stopped.start();
    await stop;
    await expect(late).rejects.toMatchObject({ code: "ERR_STUDIO_STOPPED" });
    running = new StudioServer(0, 0, root);
    const [first, second] = await Promise.all([
      running.start(),
      running.start(),
    ]);
    expect(first).toBe(second);
    await running.stop();
    await expect(
      fetch(`http://127.0.0.1:${first}/api/health`),
    ).rejects.toThrow();
  } finally {
    await stopped.stop();
    await running?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("frees the writer slot even when retired-lock cleanup fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-cleanup-"));
  const first = new StudioServer(0, 0, root);
  const unlink = fs.unlinkSync,
    remove = fs.rmSync;
  let replacement: StudioServer;
  const unlinkFault = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
    if (String(file).endsWith("owner.json"))
      throw Object.assign(new Error("Injected cleanup failure"), {
        code: "EIO",
      });
    unlink(file);
  });
  const removeFault = vi
    .spyOn(fs, "rmSync")
    .mockImplementation((file, options) => {
      if (path.basename(String(file)).startsWith(".writer-released-"))
        throw Object.assign(new Error("Injected cleanup failure"), {
          code: "EIO",
        });
      remove(file, options);
    });
  try {
    await expect(first.stop()).resolves.toBeUndefined();
    replacement = new StudioServer(0, 0, root);
    expect(
      (await fetch(`http://127.0.0.1:${await replacement.start()}/api/health`))
        .ok,
    ).toBe(true);
  } finally {
    unlinkFault.mockRestore();
    removeFault.mockRestore();
    await Promise.allSettled([first.stop(), replacement?.stop()]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("cleans up ownership when the last TCP port is occupied", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-port-"));
  const holder = net.createServer();
  await new Promise<void>((resolve, reject) => {
    holder.once("error", (error) =>
      (error as any).code === "EADDRINUSE" ? resolve() : reject(error),
    );
    holder.listen(65535, "127.0.0.1", resolve);
  });
  let failed: ReturnType<typeof launch>, replacement: ReturnType<typeof launch>;
  try {
    failed = launch([
      "studio",
      "--port",
      "65535",
      "--sniffer-port",
      "0",
      "--workspace",
      root,
    ]);
    expect((await failed.exited).code).toBe(2);
    replacement = launch([
      "studio",
      "--port",
      "0",
      "--sniffer-port",
      "0",
      "--workspace",
      root,
    ]);
    const outcome = await Promise.race([replacement.ready, replacement.exited]);
    expect(typeof outcome).toBe("string");
  } finally {
    if (failed) await terminate(failed);
    if (replacement) await terminate(replacement);
    if (holder.listening)
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);

it("reports the live workspace owner through the CLI without permitting recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-status-"));
  const owner = launch([
    "studio",
    "--port",
    "0",
    "--sniffer-port",
    "0",
    "--workspace",
    root,
  ]);
  let status: ReturnType<typeof launch>;
  try {
    await Promise.race([
      owner.ready,
      owner.exited.then(() => {
        throw new Error(owner.output().stderr);
      }),
    ]);
    status = launch(["workspace", "status", "--workspace", root]);
    expect((await status.exited).code).toBe(0);
    const result = JSON.parse(status.output().stdout);
    expect(result).toMatchObject({
      state: "locked",
      recoverable: false,
      reason: "owner-running",
      owner: { pid: owner.child.pid },
    });
    expect(typeof result.owner.token).toBe("string");
    const refused = await command([
      "workspace",
      "recover",
      "--workspace",
      root,
      "--token",
      result.owner.token,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("Recovery refused");
  } finally {
    if (status) await terminate(status);
    await terminate(owner);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);

it("requires reviewed-token recovery after a killed owner and preserves saved collections", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-recovery-"));
  const args = [
    "studio",
    "--port",
    "0",
    "--sniffer-port",
    "0",
    "--workspace",
    root,
  ];
  const owner = launch(args);
  let replacement: ReturnType<typeof launch>;
  try {
    const url = await Promise.race([
      owner.ready,
      owner.exited.then(() => {
        throw new Error(owner.output().stderr);
      }),
    ]);
    const saved = await fetch(url + "/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "survivor",
        name: "Survives hard exit",
        variables: [],
        items: [],
      }),
    });
    expect(saved.ok).toBe(true);
    const initial = JSON.parse(
      (await command(["workspace", "status", "--workspace", root])).stdout,
    );
    await terminate(owner, "SIGKILL");
    expect((await command(args)).code).toBe(2); // No timeout-based automatic stealing.
    const status = JSON.parse(
      (await command(["workspace", "status", "--workspace", root])).stdout,
    );
    expect(status).toMatchObject({
      recoverable: true,
      reason: "owner-exited",
      owner: { token: initial.owner.token },
    });
    const recover = ["workspace", "recover", "--workspace", root];
    expect(
      (
        await command([
          ...recover,
          "--token",
          "00000000-0000-4000-8000-000000000000",
        ])
      ).code,
    ).toBe(2);
    const recovered = await command([
      ...recover,
      "--token",
      status.owner.token,
    ]);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout).state).toBe("recovered");
    replacement = launch(args);
    const next = await Promise.race([
      replacement.ready,
      replacement.exited.then(() => {
        throw new Error(replacement.output().stderr);
      }),
    ]);
    expect(
      (await (await fetch(next + "/api/collections/survivor")).json()).name,
    ).toBe("Survives hard exit");
    expect(
      (await command([...recover, "--token", status.owner.token])).code,
    ).toBe(2);
    expect((await fetch(next + "/api/health")).ok).toBe(true);
  } finally {
    await terminate(owner);
    if (replacement) await terminate(replacement);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);

it("a delayed recovery cannot rename a newly acquired writer's lease", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-delayed-"));
  const args = [
    "studio",
    "--port",
    "0",
    "--sniffer-port",
    "0",
    "--workspace",
    root,
  ];
  const owner = launch(args);
  let delayed: ReturnType<typeof launch>,
    replacement: ReturnType<typeof launch>;
  try {
    await Promise.race([
      owner.ready,
      owner.exited.then(() => {
        throw new Error(owner.output().stderr);
      }),
    ]);
    const status = JSON.parse(
      (await command(["workspace", "status", "--workspace", root])).stdout,
    );
    await terminate(owner, "SIGKILL");
    const ready = path.join(root, "recovery-ready"),
      release = path.join(root, "release-recovery");
    delayed = launch(
      [root, status.owner.token, ready, release],
      "tests/fixtures/lease-recovery-gate.mjs",
    );
    await new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        if (fs.existsSync(ready)) {
          clearInterval(interval);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
      const deadline = setTimeout(() => {
        clearInterval(interval);
        reject(new Error("Recovery gate was not reached"));
      }, 4000);
      delayed.exited.then(() => {
        clearInterval(interval);
        clearTimeout(deadline);
        reject(new Error("Delayed recovery exited before its gate"));
      });
    });
    expect(
      (
        await command([
          "workspace",
          "recover",
          "--workspace",
          root,
          "--token",
          status.owner.token,
        ])
      ).code,
    ).toBe(0);
    replacement = launch(args);
    const url = await Promise.race([
      replacement.ready,
      replacement.exited.then(() => {
        throw new Error(replacement.output().stderr);
      }),
    ]);
    fs.writeFileSync(release, "continue");
    expect((await delayed.exited).code).toBe(2);
    const current = JSON.parse(
      (await command(["workspace", "status", "--workspace", root])).stdout,
    );
    expect(current.owner.pid).toBe(replacement.child.pid);
    expect(current.owner.token).not.toBe(status.owner.token);
    expect((await fetch(url + "/api/collections")).ok).toBe(true);
  } finally {
    await terminate(owner);
    if (delayed) await terminate(delayed);
    if (replacement) await terminate(replacement);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);

it("the legacy dev entry uses the same graceful workspace lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-dev-"));
  const legacy = launch([], "dist/server/index.js", {
    cwd: root,
    env: { ...process.env, PORT: "0", SNIFFER_PORT: "0" },
  });
  let replacement: ReturnType<typeof launch>;
  try {
    await Promise.race([
      legacy.ready,
      legacy.exited.then(() => {
        throw new Error(legacy.output().stderr);
      }),
    ]);
    await terminate(legacy);
    replacement = launch([
      "studio",
      "--port",
      "0",
      "--sniffer-port",
      "0",
      "--workspace",
      root,
    ]);
    expect(
      typeof (await Promise.race([replacement.ready, replacement.exited])),
    ).toBe("string");
  } finally {
    await terminate(legacy);
    if (replacement) await terminate(replacement);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);

it("an old instance cannot write or remove a replacement owner's lock after losing ownership", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-lost-"));
  const first = new StudioServer(0, 0, root);
  let replacement: StudioServer;
  try {
    const oldPort = await first.start();
    const original = (
      await (await fetch(`http://127.0.0.1:${oldPort}/api/collections`)).json()
    )[0];
    fs.renameSync(
      path.join(root, ".writer-lock"),
      path.join(root, "operator-removed-lock"),
    );
    const lost = await fetch(`http://127.0.0.1:${oldPort}/api/collections`);
    expect(lost.status).toBe(503);
    expect((await lost.json()).error.code).toBe("ERR_WORKSPACE_LEASE_LOST");
    replacement = new StudioServer(0, 0, root);
    const newPort = await replacement.start();
    const rejected = await fetch(
      `http://127.0.0.1:${oldPort}/api/collections/${original.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Must not commit" }),
      },
    );
    expect(rejected.status).toBe(503);
    await expect(first.stop()).rejects.toMatchObject({
      code: "ERR_WORKSPACE_LEASE_LOST",
    });
    expect(
      (
        await (
          await fetch(
            `http://127.0.0.1:${newPort}/api/collections/${original.id}`,
          )
        ).json()
      ).name,
    ).toBe(original.name);
  } finally {
    await Promise.allSettled([first.stop(), replacement?.stop()]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves malformed lease metadata and does not seed an unlocked replacement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-malformed-"));
  const lock = path.join(root, ".rea-api", ".writer-lock");
  fs.mkdirSync(lock, { recursive: true });
  const file = path.join(lock, "owner.json"),
    data = '{"pid":"seed-must-not-appear-in-errors"}';
  fs.writeFileSync(file, data);
  try {
    for (const args of [
      ["workspace", "status", "--workspace", root],
      [
        "workspace",
        "recover",
        "--workspace",
        root,
        "--token",
        "00000000-0000-4000-8000-000000000000",
      ],
      ["studio", "--port", "0", "--sniffer-port", "0", "--workspace", root],
    ]) {
      const result = await command(args);
      expect(result.code).toBe(2);
      expect(result.stderr).not.toContain("seed-must-not-appear-in-errors");
    }
    expect(fs.readFileSync(file, "utf8")).toBe(data);
    expect(fs.existsSync(path.join(root, ".rea-api", "collections"))).toBe(
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);

it("refuses to recover an exited owner recorded on another host", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rea-lease-host-"));
  const owner = launch([
    "studio",
    "--port",
    "0",
    "--sniffer-port",
    "0",
    "--workspace",
    root,
  ]);
  try {
    await Promise.race([
      owner.ready,
      owner.exited.then(() => {
        throw new Error(owner.output().stderr);
      }),
    ]);
    await terminate(owner, "SIGKILL");
    const file = path.join(root, ".rea-api", ".writer-lock", "owner.json");
    const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
    metadata.hostname = "different-host.invalid";
    const data = JSON.stringify(metadata);
    fs.writeFileSync(file, data);
    const status = JSON.parse(
      (await command(["workspace", "status", "--workspace", root])).stdout,
    );
    expect(status).toMatchObject({
      recoverable: false,
      reason: "foreign-host",
    });
    expect(
      (
        await command([
          "workspace",
          "recover",
          "--workspace",
          root,
          "--token",
          metadata.token,
        ])
      ).code,
    ).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toBe(data);
  } finally {
    await terminate(owner);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);
