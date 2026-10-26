import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRepository } from "../src/core/workspace/WorkspaceRepository.js";
import { StudioServer } from "../src/server/StudioServer.js";
import { main } from "../src/cli.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const roots: string[] = [];
const owners: WorkspaceRepository[] = [];
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rea-repository-")); roots.push(base);
  const root = path.join(base, ".rea-api");
  const repo = new WorkspaceRepository(root); owners.push(repo);
  return { base, root, repo };
}
function reopen(root: string, readOnly = false) {
  const repo = new WorkspaceRepository(root, { readOnly }); owners.push(repo); return repo;
}
function files(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  function scan(directory: string) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isDirectory()) scan(file);
      else entries[path.relative(root, file)] = fs.readFileSync(file).toString("hex");
    }
  }
  scan(root); return entries;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const repo of owners.splice(0)) repo.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("canonical workspace repository", () => {
  it("serves manifest collections and environments through list endpoints without reviving retained legacy files", async () => {
    const { repo, root } = fixture(); repo.migrate(repo.migrationPlan().checksum); repo.close();
    const server = new StudioServer(0, 0, root);
    try {
      const port = await server.start();
      const list = async (kind: string) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/${kind}`);
        expect(response.status).toBe(200); return response.json();
      };
      for (const kind of ["collections", "environments"]) {
        const original = (await list(kind))[0];
        const response = await fetch(`http://127.0.0.1:${port}/api/${kind}/${original.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json", "If-Match": `"${original.revision}"` },
          body: JSON.stringify({ ...original, name: "Manifest-only change" }),
        });
        expect(response.status).toBe(200);
        const saved = await response.json();
        expect(await list(kind)).toEqual([saved]);
        const deleted = await fetch(`http://127.0.0.1:${port}/api/${kind}/${saved.id}`, { method: "DELETE", headers: { "If-Match": `"${saved.revision}"` } });
        expect(deleted.status).toBe(200); expect(await list(kind)).toEqual([]);
      }
      fs.unlinkSync(path.join(root, "workspace-v1.json"));
      expect((await fetch(`http://127.0.0.1:${port}/api/collections`)).status).toBe(503);
    } finally { await server.stop(); }
  });
  it("extracts the persistence owner and makes readonly migration inspection byte-for-byte inert", () => {
    const { repo, root } = fixture(); repo.close();
    const before = files(root);
    const reader = reopen(root, true);
    expect(reader.migrationPlan()).toMatchObject({ from: 0, to: 1, collections: 1, environments: 1 });
    reader.close(); expect(files(root)).toEqual(before);
  });
  it("requires a current reviewed checksum and keeps old files plus a verified retained backup", () => {
    const { repo, root } = fixture();
    const original = repo.snapshot(); const plan = repo.migrationPlan();
    expect(() => repo.migrate("not-reviewed")).toThrow(/changed/i);
    const before = files(root);
    const result = repo.migrate(plan.checksum);
    expect(repo.snapshot()).toMatchObject({ format: 1, collections: original.collections, environments: original.environments });
    for (const [file, text] of Object.entries(before)) expect(files(root)[file]).toBe(text);
    const retained = WorkspaceRepository.readBackup(path.join(root, result.backup));
    expect(repo.restorePlan(retained).checksum).toBe(result.checksum);
    repo.close(); expect(reopen(root).snapshot().format).toBe(1);
  });
  it("preserves IDs, inherited metadata and opaque fields while isolating a request edit", () => {
    const { repo, root } = fixture();
    const collection = repo.snapshot().collections[0];
    collection.postman = { vendor: { opaque: [1, "x"] } } as any;
    collection.items[0].postman = { extra: "kept" } as any;
    repo.persistCollection(collection.id, collection, collection.revision);
    repo.migrate(repo.migrationPlan().checksum);
    const before = files(path.join(root, "objects"));
    const next = repo.snapshot().collections[0];
    next.items[0].request!.url = "https://example.test/edited";
    repo.persistCollection(next.id, next, next.revision);
    const added = Object.keys(files(path.join(root, "objects"))).filter((file) => !(file in before));
    expect(added).toHaveLength(2); // one request and its collection skeleton; other request unchanged
    repo.close(); const restored = reopen(root).snapshot().collections[0];
    expect(restored.items[0].id).toBe(collection.items[0].id);
    expect(restored.items[0].postman).toEqual({ extra: "kept" });
    expect(restored.postman).toEqual(collection.postman);
    expect(restored.items[0].request!.url).toBe("https://example.test/edited");
  });
  it.each(["migration", "edit"])("recovers a failed %s manifest replacement to the preceding complete snapshot", (operation) => {
    const { repo, root } = fixture();
    if (operation === "edit") repo.migrate(repo.migrationPlan().checksum);
    const original = repo.snapshot();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("workspace-v1.json")) throw new Error("Injected commit fault");
      rename(from, to);
    });
    expect(() => {
      if (operation === "migration") repo.migrate(repo.migrationPlan().checksum);
      else { const next = structuredClone(original.collections[0]); next.name = "Uncommitted"; repo.persistCollection(next.id, next, next.revision); }
    }).toThrow(/Injected/);
    vi.restoreAllMocks(); repo.close();
    expect(reopen(root).snapshot()).toEqual(original);
  });
  it("refuses stale writes, missing documents and altered hash-addressed objects without hiding them", () => {
    const { repo, root } = fixture(); repo.migrate(repo.migrationPlan().checksum);
    const original = repo.snapshot().collections[0];
    const next = structuredClone(original); next.name = "New";
    repo.persistCollection(next.id, next, next.revision);
    expect(() => repo.persistCollection(original.id, original, original.revision)).toThrow(/changed/i);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "workspace-v1.json"), "utf8"));
    const file = path.join(root, "objects", manifest.collections[0].slice(0, 2), manifest.collections[0] + ".json");
    fs.writeFileSync(file, "{}");
    expect(() => repo.snapshot()).toThrow(/Invalid workspace/);
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
    fs.unlinkSync(file); expect(() => repo.snapshot()).toThrow(/Invalid workspace/);
  });
  it("requires reviewed restore checksum and current workspace revision, retaining a pre-restore backup", () => {
    const { repo, root } = fixture(); repo.migrate(repo.migrationPlan().checksum);
    const backup = repo.backup(); const original = repo.snapshot();
    const next = original.collections[0]; next.name = "Newer"; repo.persistCollection(next.id, next, next.revision);
    expect(() => repo.restore(backup, backup.checksum, original.revision)).toThrow(/changed/i);
    expect(() => repo.restore(backup, "unreviewed", repo.snapshot().revision)).toThrow(/reviewed/);
    const previous = repo.backup();
    const restored = repo.restore(backup, backup.checksum, repo.snapshot().revision);
    expect(restored.collections[0].name).not.toBe("Newer");
    expect(fs.existsSync(path.join(root, "backup-" + previous.checksum + ".json"))).toBe(true);
  });
  it("reconciles an externally committed valid manifest and rejects stale aggregate transactions", () => {
    const { repo, root } = fixture(); repo.migrate(repo.migrationPlan().checksum);
    const original = repo.snapshot();
    const file = path.join(root, "workspace-v1.json"); const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.collections = []; fs.writeFileSync(file, JSON.stringify(manifest));
    expect(repo.snapshot().collections).toEqual([]);
    expect(() => repo.commitSnapshot(original.collections, original.environments, original.revision)).toThrow(/changed/);
  });
  it.skipIf(process.platform === "win32")("refuses redirected object directories and symlinked objects", () => {
    const { repo, root } = fixture(); repo.migrate(repo.migrationPlan().checksum);
    const objects = path.join(root, "objects"); fs.renameSync(objects, objects + "-retained");
    fs.symlinkSync(objects + "-retained", objects, "dir");
    expect(() => repo.snapshot()).toThrow(/workspace directory/i);
    fs.unlinkSync(objects); fs.renameSync(objects + "-retained", objects);
    const shard = fs.readdirSync(objects)[0];
    const name = fs.readdirSync(path.join(objects, shard))[0], file = path.join(objects, shard, name);
    fs.renameSync(file, file + "-retained"); fs.symlinkSync(file + "-retained", file);
    expect(() => repo.snapshot()).toThrow(/Invalid workspace/);
  });
  it("moves across collections through the public API as one conditional manifest commit", async () => {
    const { repo, root } = fixture();
    repo.persistCollection("destination", { id: "destination", name: "Destination", items: [], variables: [], schemaVersion: "2.1.0" }, null);
    repo.migrate(repo.migrationPlan().checksum); repo.close();
    const server = new StudioServer(0, 0, root);
    try {
      const port = await server.start(); const snapshot = server.snapshot();
      const [source, destination] = [snapshot.collections.find((value) => value.id !== "destination")!, snapshot.collections.find((value) => value.id === "destination")!];
      const body = { sourceCollectionId: source.id, destinationCollectionId: destination.id, sourceRevision: source.revision, destinationRevision: destination.revision, itemId: source.items[0].id };
      const request = () => fetch(`http://127.0.0.1:${port}/api/workspace/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await request(); expect(result.status).toBe(200);
      const moved = await result.json(); expect(moved.collections.find((value: any) => value.id === destination.id).items[0].id).toBe(body.itemId);
      expect((await request()).status).toBe(412);
    } finally { await server.stop(); }
    expect(reopen(root).snapshot().collections.find((value) => value.id === "destination")!.items).toHaveLength(1);
  });
  it("provides readonly CLI previews and explicit migration/restore commands", async () => {
    const { repo, base, root } = fixture(); repo.close(); const before = files(root);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["workspace", "migrate", "--workspace", base])).toBe(0);
    const plan = JSON.parse(String(logs.mock.calls.at(-1)![0])); expect(files(root)).toEqual(before);
    await main(["workspace", "migrate", "--workspace", base, "--apply", "--consent", "plaintext", "--checksum", plan.checksum]);
    const reader = reopen(root, true); expect(reader.snapshot().format).toBe(1); reader.close();
  });
  it.each(["backup", "object", "postcommit"])("restarts safely at the %s migration boundary", (boundary) => {
    const { repo, root } = fixture(); const original = repo.snapshot(); const plan = repo.migrationPlan();
    const rename = fs.renameSync; let injected = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const destination = String(to);
      if (!injected && ((boundary === "backup" && destination.includes("backup-")) || (boundary === "object" && destination.includes("/objects/")))) {
        injected = true; throw Object.assign(new Error("Injected disk-full fault"), { code: "ENOSPC" });
      }
      rename(from, to);
      if (boundary === "postcommit" && destination.endsWith("workspace-v1.json")) throw new Error("Injected interruption after commit");
    });
    expect(() => repo.migrate(plan.checksum)).toThrow(/Injected/);
    vi.restoreAllMocks(); repo.close(); const restarted = reopen(root);
    expect(restarted.snapshot().collections).toEqual(original.collections);
    expect(restarted.snapshot().format).toBe(boundary === "postcommit" ? 1 : 0);
    if (boundary !== "postcommit") expect(restarted.migrate(restarted.migrationPlan().checksum).revision).toBeTruthy();
  });
  it("never permits readonly deletes or silently recovers a pending legacy journal", () => {
    const { repo, root } = fixture(); const snapshot = repo.snapshot(); repo.close();
    const reader = reopen(root, true); const before = files(root);
    expect(() => reader.deleteCollection(snapshot.collections[0].id)).toThrow(/Read-only/);
    expect(() => reader.deleteEnvironment(snapshot.environments[0].id)).toThrow(/Read-only/);
    expect(files(root)).toEqual(before); reader.close();
    fs.unlinkSync(path.join(root, "collections", ".initialized"));
    fs.writeFileSync(path.join(root, "collections", ".migration"), "[]");
    const pending = files(root);
    expect(() => reopen(root, true)).toThrow(/Pending legacy/);
    expect(files(root)).toEqual(pending);
  });
  it("migrates and restarts a supported 10,004-request workspace without weakening resource quotas", () => {
    const { repo, root } = fixture();
    repo.deleteCollection(repo.snapshot().collections[0].id);
    for (const [id, count] of [["large", 10000], ["small", 4]] as const) {
      repo.persistCollection(id, { id, name: id, variables: [], schemaVersion: "2.1.0", items: Array.from({ length: count }, (_, i) => ({ id: "i" + i, name: "R", request: { method: "GET", url: "https://example.test/" + i } })) }, null);
    }
    const plan = repo.migrationPlan(); expect(plan.documents).toBeGreaterThan(10000);
    repo.migrate(plan.checksum); repo.close();
    const restarted = reopen(root); expect(restarted.snapshot().collections.find((value) => value.id === "large")!.items).toHaveLength(10000);
    const shards = fs.readdirSync(path.join(root, "objects")); expect(shards.length).toBeGreaterThan(1);
    for (const shard of shards) expect(fs.readdirSync(path.join(root, "objects", shard)).length).toBeLessThanOrEqual(2048);
  }, 180000);
  it("uses the migrated owner through real CLI processes and stdio MCP instead of retained legacy files", async () => {
    const { repo, base, root } = fixture(); repo.close();
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, ["bin/rea-api.js", "workspace", ...args, "--workspace", base], { encoding: "utf8" });
      expect(result.stderr).toBe(""); expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    };
    const plan = cli("migrate"); cli("migrate", "--apply", "--consent", "plaintext", "--checksum", plan.checksum);
    const writer = reopen(root); const next = writer.snapshot().collections[0]; next.name = "Manifest owner";
    writer.persistCollection(next.id, next, next.revision); writer.close();
    const snapshot = cli("snapshot"); expect(snapshot.collections[0].name).toBe("Manifest owner");
    const backupFile = path.join(base, "exported-backup.json");
    const saved = cli("backup", "--backup-file", backupFile);
    const restorePlan = cli("restore", "--backup-file", backupFile);
    expect(restorePlan.checksum).toBe(saved.checksum);
    cli("restore", "--backup-file", backupFile, "--apply", "--consent", "plaintext", "--checksum", saved.checksum, "--revision", restorePlan.revision);
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("bin/rea-api.js"), "mcp", "--workspace", base], stderr: "pipe" });
    const client = new Client({ name: "repository-test", version: "1" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "list_collections", arguments: {} });
      expect(JSON.parse((result.content as any)[0].text).collections[0].name).toBe("Manifest owner");
    } finally { await client.close(); }
  });

  it.each(["wrapper", "depth", "nodes"])("bounds untrusted %s trees before hydration and preserves invalid external data", (variant) => {
    const { repo, root } = fixture(); repo.migrate(repo.migrationPlan().checksum);
    const manifestFile = path.join(root, "workspace-v1.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const oldHash = manifest.collections[0];
    const document = JSON.parse(fs.readFileSync(path.join(root, "objects", oldHash.slice(0, 2), oldHash + ".json"), "utf8"));
    const folder = (id: number, items: any[]) => ({ value: { id: "f" + id, name: "Folder", isFolder: true, items } });
    if (variant === "wrapper") document.value.items = [null];
    if (variant === "nodes") document.value.items = Array.from({ length: 10001 }, (_, index) => folder(index, []));
    if (variant === "depth") { let tree: any[] = []; for (let index = 0; index < 50; index++) tree = [folder(index, tree)]; document.value.items = tree; }
    const text = JSON.stringify(document), hash = createHash("sha256").update(text).digest("hex");
    const directory = path.join(root, "objects", hash.slice(0, 2)); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, hash + ".json"); fs.writeFileSync(file, text);
    manifest.collections[0] = hash; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    expect(() => repo.snapshot()).toThrow(/Invalid workspace/);
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });

  it("does not revive retained legacy resources when an external editor deletes the active manifest", () => {
    const { repo, root } = fixture(); repo.migrate(repo.migrationPlan().checksum);
    const file = path.join(root, "workspace-v1.json"); fs.unlinkSync(file);
    expect(() => repo.snapshot()).toThrow(/Invalid workspace/); repo.close();
    expect(() => reopen(root)).toThrow(/Invalid workspace/);
    expect(fs.existsSync(file)).toBe(false);
  });

});
