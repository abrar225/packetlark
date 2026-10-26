import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { WorkspaceLease } from "./WorkspaceLease.js";
import { validWorkspaceResource } from "../models/WorkspaceValidation.js";
import type { ApiCollection, Environment } from "../models/types.js";
const workspaceLimits = {
  bytes: 32 * 1024 * 1024,
  documents: 1000,
  directoryEntries: 2048,
};
type WorkspaceBudget = { bytes: number; documents: number };

export class WorkspaceRepository {
  protected storageDir: string;
  protected collectionsDir: string;
  protected environmentsDir: string;
  protected collections = new Map<string, ApiCollection>();
  protected environments = new Map<string, Environment>();
  protected directoryIdentities = new Map<string, string>();
  protected lease?: WorkspaceLease;
  private readOnly: boolean;
  private manifestRaw?: string;
  constructor(workspaceDir: string, options: { readOnly?: boolean } = {}) {
    this.readOnly = !!options.readOnly;
    this.storageDir = workspaceDir;
    this.collectionsDir = path.join(workspaceDir, "collections");
    this.environmentsDir = path.join(workspaceDir, "environments");
    if (!this.readOnly) this.lease = WorkspaceLease.acquire(workspaceDir);
    this.storageDir = this.lease?.root || workspaceDir;
    try {
      this.ensureStorage();
      if (!this.workspaceFileExists(this.manifestFile) && this.workspaceFileExists(this.formatMarker)) throw this.workspaceError(this.manifestFile);
      if (!this.readOnly && !this.workspaceFileExists(this.manifestFile)) {
        this.loadInitialCollections();
        this.loadInitialEnvironments();
      }
      if (this.readOnly) {
        for (const directory of [this.collectionsDir, this.environmentsDir]) {
          const initialized = this.workspaceFileExists(path.join(directory, ".initialized"));
          if (!initialized && this.workspaceFileExists(path.join(directory, ".migration")))
            throw Object.assign(new Error("Pending legacy initialization recovery; start Studio with the writer lease first"), { code: "ERR_WORKSPACE_RECOVERY_REQUIRED", statusCode: 503 });
        }
      }
      this.refreshWorkspaceSnapshot();
      if (!this.readOnly && this.workspaceFileExists(this.manifestFile) && !this.workspaceFileExists(this.formatMarker)) this.atomicWrite(this.formatMarker, "1\n");
    } catch (error) {
      this.lease?.release();
      throw error;
    }
  }
  public snapshot() { return structuredClone(this.refreshWorkspaceSnapshot()); }
  public close() { this.lease?.release(); }
  protected ensureStorage() {
    if (!fs.existsSync(this.storageDir)) {
      if (this.readOnly) throw Object.assign(new Error("Workspace does not exist"), { code: "ENOENT" });
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    }
    this.assertDirectory(this.storageDir);
    // Bind paths once to the chosen root, resolving platform aliases such as /var.
    this.storageDir = fs.realpathSync(this.storageDir);
    this.collectionsDir = path.join(this.storageDir, "collections");
    this.environmentsDir = path.join(this.storageDir, "environments");
    for (const directory of [this.collectionsDir, this.environmentsDir]) {
      try { fs.lstatSync(directory); }
      catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        if (this.readOnly) continue;
        fs.mkdirSync(directory, { mode: 0o700 });
      }
      this.assertDirectory(directory);
    }
    for (const directory of [
      this.storageDir,
      this.collectionsDir,
      this.environmentsDir,
    ]) {
      try {
        const stat = fs.lstatSync(directory, { bigint: true });
        this.directoryIdentities.set(directory, `${stat.dev}:${stat.ino}`);
      } catch (error: any) { if (!this.readOnly || error.code !== "ENOENT") throw error; }
    }
  }

  protected assertDirectory(directory: string) {
    try {
      const stat = fs.lstatSync(directory, { bigint: true });
      const bound = this.directoryIdentities.get(directory);
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (!bound || bound === `${stat.dev}:${stat.ino}`) &&
        (!bound || fs.realpathSync(directory) === directory)
      )
        return;
    } catch {}
    throw Object.assign(
      new Error(
        "Unsafe workspace directory path. Restore the original directories before continuing.",
      ),
      { statusCode: 503, code: "ERR_WORKSPACE_UNSAFE" },
    );
  }

  protected assertWorkspaceDirectories() {
    for (const directory of [this.storageDir, this.collectionsDir, this.environmentsDir, this.objectsDir])
      if (this.directoryIdentities.has(directory)) this.assertDirectory(directory);
    this.lease?.assertOwned();
    if (fs.existsSync(this.objectsDir) && !this.directoryIdentities.has(this.objectsDir)) {
      this.assertDirectory(this.objectsDir);
      const stat = fs.lstatSync(this.objectsDir, { bigint: true });
      this.directoryIdentities.set(this.objectsDir, `${stat.dev}:${stat.ino}`);
    }
  }

  protected workspaceError(file: string) {
    return Object.assign(
      new Error(
        `Invalid workspace resource: ${path.basename(file)}. Repair or restore this file before continuing.`,
      ),
      { statusCode: 503, code: "ERR_WORKSPACE_INVALID" },
    );
  }

  protected workspaceFileExists(file: string) {
    this.assertWorkspaceDirectories();
    if (path.dirname(path.dirname(file)) === this.objectsDir) this.assertDirectory(path.dirname(file));
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > this.maximumFileBytes(file))
        throw this.workspaceError(file);
      return true;
    } catch (error: any) {
      if (error.code === "ENOENT") return false;
      throw this.workspaceError(file);
    }
  }

  protected readWorkspaceText(file: string) {
    this.assertWorkspaceDirectories();
    if (path.dirname(path.dirname(file)) === this.objectsDir) this.assertDirectory(path.dirname(file));
    let descriptor: number | undefined;
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error();
      descriptor = fs.openSync(
        file,
        fs.constants.O_RDONLY |
          (fs.constants.O_NOFOLLOW || 0) |
          (fs.constants.O_NONBLOCK || 0),
      );
      const stat = fs.fstatSync(descriptor);
      const maximum = this.maximumFileBytes(file);
      if (!stat.isFile() || stat.size > maximum) throw new Error();
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        const count = fs.readSync(
          descriptor,
          buffer,
          0,
          Math.min(buffer.length, maximum + 1 - bytes),
          null,
        );
        if (!count) break;
        bytes += count;
        if (bytes > maximum) throw new Error();
        chunks.push(Buffer.from(buffer.subarray(0, count)));
      }
      return Buffer.concat(chunks, bytes).toString("utf8");
    } catch {
      throw this.workspaceError(file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  protected workspaceLimitError(statusCode = 503) {
    return Object.assign(
      new Error(
        "Workspace exceeds the supported limit: 1000 collection/environment documents, 32 MiB combined, or 2048 directory entries. Files were preserved; reduce or split this workspace.",
      ),
      { statusCode, code: "ERR_WORKSPACE_LIMIT" },
    );
  }

  protected workspaceEntries(directory: string) {
    this.assertWorkspaceDirectories();
    this.assertDirectory(directory);
    const stream = fs.opendirSync(directory),
      names: string[] = [];
    let entries = 0;
    try {
      for (let entry; (entry = stream.readSync());) {
        if (++entries > workspaceLimits.directoryEntries)
          throw this.workspaceLimitError();
        names.push(entry.name);
      }
    } finally {
      stream.closeSync();
    }
    return names;
  }

  protected resourceFiles(directory: string) {
    const files = this.workspaceEntries(directory).filter((name) =>
      name.endsWith(".json"),
    );
    if (files.length > workspaceLimits.documents)
      throw this.workspaceLimitError();
    return files.sort();
  }

  protected readWorkspaceJson(
    file: string,
    includeRevision = false,
    budget?: WorkspaceBudget,
  ) {
    const raw = this.readWorkspaceText(file);
    if (budget) {
      budget.bytes += Buffer.byteLength(raw);
      budget.documents++;
      if (
        budget.bytes > workspaceLimits.bytes ||
        budget.documents > workspaceLimits.documents
      )
        throw this.workspaceLimitError();
    }
    try {
      const value = JSON.parse(raw);
      if (includeRevision && value && typeof value === "object")
        value.revision = this.revision(raw);
      return value;
    } catch {
      throw this.workspaceError(file);
    }
  }

  protected validateResource(
    value: any,
    kind: "collections" | "environments",
    file: string,
    statusCode = 503,
  ) {
    if (!validWorkspaceResource(value, kind)) {
      if (statusCode === 503) throw this.workspaceError(file);
      throw Object.assign(
        new Error(
          `Invalid ${kind} data. Check unique IDs, request structure, variables and value types.`,
        ),
        { statusCode, code: "ERR_RESOURCE_INVALID" },
      );
    }
  }

  protected readResourceDirectory<T>(
    directory: string,
    kind: "collections" | "environments",
    budget: WorkspaceBudget = { bytes: 0, documents: 0 },
  ): Map<string, T> {
    this.assertWorkspaceDirectories();
    const resources = new Map<string, T>();
    if (this.readOnly && !this.directoryIdentities.has(directory)) {
      // Sparse legacy workspaces can be inspected without creating the missing directory.
      try { fs.lstatSync(directory); this.assertDirectory(directory); }
      catch (error: any) { if (error.code === "ENOENT") return resources; throw error; }
    }
    for (const file of this.resourceFiles(directory)) {
      const fullPath = path.join(directory, file);
      const resource = this.readWorkspaceJson(fullPath, true, budget);
      this.validateResource(resource, kind, fullPath);
      if (file !== resource.id + ".json" || resources.has(resource.id))
        throw this.workspaceError(fullPath);
      resources.set(resource.id, resource);
    }
    return resources;
  }

  protected refreshWorkspaceSnapshot() {
    if (this.workspaceFileExists(this.manifestFile)) return this.readManifestSnapshot();
    if (this.workspaceFileExists(this.formatMarker)) throw this.workspaceError(this.manifestFile);
    const budget = { bytes: 0, documents: 0 };
    const collections = this.readResourceDirectory<ApiCollection>(
      this.collectionsDir,
      "collections",
      budget,
    );
    const environments = this.readResourceDirectory<Environment>(
      this.environmentsDir,
      "environments",
      budget,
    );
    const revision = this.revision(
      JSON.stringify([
        [...collections].map(([id, value]) => [id, value.revision]).sort(),
        [...environments].map(([id, value]) => [id, value.revision]).sort(),
      ]),
    );
    // Publish together only after both directories validate.
    this.collections = collections;
    this.environments = environments;
    return {
      format: 0,
      revision,
      collections: [...collections.values()],
      environments: [...environments.values()],
    };
  }

  protected migrateLegacy(
    kind: "collections" | "environments",
    canonicalCount: number,
  ) {
    const directory =
      kind === "collections" ? this.collectionsDir : this.environmentsDir;
    const journal = path.join(directory, ".migration");
    const legacy = path.join(this.storageDir, kind + ".json");
    if (
      !this.workspaceFileExists(journal) &&
      (canonicalCount > 0 || !this.workspaceFileExists(legacy))
    )
      return;
    const source = this.workspaceFileExists(journal) ? journal : legacy;
    const resources = this.readWorkspaceJson(source);
    if (!Array.isArray(resources)) throw this.workspaceError(source);
    const ids = new Set();
    for (const value of resources) {
      this.validateResource(value, kind, source);
      if (ids.has(value.id)) throw this.workspaceError(source);
      ids.add(value.id);
    }
    const records = resources.map((value) => ({
      value,
      data: this.serializeResource(value),
    }));
    // Preflight every canonical record before journaling or replacing any file.
    if (!this.workspaceFileExists(journal))
      this.atomicWrite(journal, JSON.stringify(resources));
    for (const { value, data } of records) {
      const file = this.resourceFile(kind, value.id);
      if (this.workspaceFileExists(file)) {
        if (
          JSON.stringify(this.readWorkspaceJson(file)) !==
          JSON.stringify(JSON.parse(data))
        )
          throw this.workspaceError(file);
      } else this.atomicWrite(file, data);
    }
  }

  protected finishInitialization(directory: string) {
    this.atomicWrite(path.join(directory, ".initialized"), "1\n");
    // Marker is the commit point. A leftover journal is ignored once committed.
    try {
      fs.unlinkSync(path.join(directory, ".migration"));
    } catch {}
  }

  protected loadInitialCollections() {
    if (this.workspaceFileExists(this.manifestFile) || this.workspaceFileExists(this.formatMarker)) {
      this.refreshWorkspaceSnapshot();
      return;
    }
    const marker = path.join(this.collectionsDir, ".initialized");
    const initialized = this.workspaceFileExists(marker);
    this.collections = this.readResourceDirectory<ApiCollection>(
      this.collectionsDir,
      "collections",
    );

    if (initialized) return;

    this.migrateLegacy("collections", this.collections.size);
    this.collections = this.readResourceDirectory<ApiCollection>(
      this.collectionsDir,
      "collections",
    );

    // 3. If empty, create starter sample collection
    if (
      this.collections.size === 0 &&
      !fs.existsSync(path.join(this.storageDir, "collections.json"))
    ) {
      const sampleCol: ApiCollection = {
        id: "col_sample_1",
        name: "GitHub Public API Sample",
        description: "Demonstration collection with variables and assertions.",
        schemaVersion: "2.1.0",
        variables: [
          { key: "baseUrl", value: "https://api.github.com", enabled: true },
          { key: "repo", value: "abrar225/packetlark", enabled: true },
        ],
        items: [
          {
            id: "req_1",
            name: "Get PacketLark repository",
            request: {
              id: "req_1",
              name: "Get PacketLark repository",
              method: "GET",
              url: "{{baseUrl}}/repos/{{repo}}",
              headers: [
                { key: "User-Agent", value: "PacketLark", enabled: true },
              ],
              queryParams: [],
              body: { mode: "none" },
              auth: { type: "none" },
              testScript: `pm.test("Status code is 200", function () {
    pm.expect(pm.response.code).to.equal(200);
    pm.response.to.have.status(200);
});

pm.test("Has valid repo name", function () {
    var data = pm.response.json();
    pm.expect(data.name).to.equal("packetlark");
});`,
            },
          },
          {
            id: "req_2",
            name: "HTTPBin Echo Test",
            request: {
              id: "req_2",
              name: "HTTPBin Echo Test",
              method: "POST",
              url: "https://httpbin.org/post",
              headers: [
                {
                  key: "Content-Type",
                  value: "application/json",
                  enabled: true,
                },
              ],
              queryParams: [
                { key: "traceId", value: "{{$guid}}", enabled: true },
              ],
              body: {
                mode: "raw-json",
                raw: JSON.stringify(
                  {
                    timestamp: "{{$timestamp}}",
                    client: "PacketLark",
                    message: "Hello from PacketLark",
                  },
                  null,
                  2,
                ),
              },
              auth: { type: "none" },
              testScript: `pm.test("Echo response received", function () {
    pm.expect(pm.response.code).to.equal(200);
    var json = pm.response.json();
    pm.expect(json.json.client).to.equal("PacketLark");
});`,
            },
          },
        ],
      };
      this.collections.set(sampleCol.id, sampleCol);
      this.persistCollection(sampleCol.id);
    }
    this.finishInitialization(this.collectionsDir);
  }

  protected loadInitialEnvironments() {
    if (this.workspaceFileExists(this.manifestFile) || this.workspaceFileExists(this.formatMarker)) {
      this.refreshWorkspaceSnapshot();
      return;
    }
    const marker = path.join(this.environmentsDir, ".initialized");
    const initialized = this.workspaceFileExists(marker);
    this.environments = this.readResourceDirectory<Environment>(
      this.environmentsDir,
      "environments",
    );

    if (initialized) return;

    this.migrateLegacy("environments", this.environments.size);
    this.environments = this.readResourceDirectory<Environment>(
      this.environmentsDir,
      "environments",
    );

    // 3. If empty, create default Development environment
    if (
      this.environments.size === 0 &&
      !fs.existsSync(path.join(this.storageDir, "environments.json"))
    ) {
      const devEnv: Environment = {
        id: "env_dev_1",
        name: "Development",
        values: [
          { key: "baseUrl", value: "https://httpbin.org", enabled: true },
          { key: "apiKey", value: "dev-secret-token-12345", enabled: true },
        ],
      };
      this.environments.set(devEnv.id, devEnv);
      this.persistEnvironment(devEnv.id);
    }
    this.finishInitialization(this.environmentsDir);
  }

  protected atomicWrite(file: string, data: string, syncDirectory = true) {
    if (this.readOnly) throw new Error("Read-only workspace");
    this.assertWorkspaceDirectories();
    this.workspaceFileExists(file); // Reject non-regular destinations, including dangling links.
    const directory = path.dirname(file);
    if (
      directory === this.storageDir || directory === this.collectionsDir ||
      directory === this.environmentsDir || directory === this.objectsDir || path.dirname(directory) === this.objectsDir
    ) {
      const entries = this.workspaceEntries(directory);
      if (
        !entries.includes(path.basename(file)) &&
        entries.length >= workspaceLimits.directoryEntries
      )
        throw this.workspaceLimitError(413);
    }
    const temporary = file + "." + crypto.randomUUID() + ".tmp";
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, data, "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, file);
      if (syncDirectory) {
        const directoryFd = fs.openSync(directory, "r");
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  protected revision(data: string) {
    return createHash("sha256").update(data).digest("hex");
  }

  protected resourceFile(kind: "collections" | "environments", id: string) {
    this.assertWorkspaceDirectories();
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))
      throw Object.assign(
        new Error(
          "Resource ID must contain only letters, numbers, underscores or hyphens",
        ),
        { statusCode: 400, code: "ERR_RESOURCE_ID" },
      );
    return path.join(
      kind === "collections" ? this.collectionsDir : this.environmentsDir,
      id + ".json",
    );
  }

  protected checkRevision(file: string, expected?: string | null) {
    if (this.workspaceFileExists(this.manifestFile)) {
      const snapshot = this.readManifestSnapshot();
      const values = path.dirname(file) === this.environmentsDir ? snapshot.environments : snapshot.collections;
      const current = values.find((value) => value.id === path.basename(file, ".json"));
      if ((expected === null && current) || (expected !== undefined && expected !== null && current?.revision !== expected)) this.conflict(expected);
      return;
    }
    if (expected === undefined) return; // Initial migration/creation has no prior revision.
    const exists = this.workspaceFileExists(file);
    if (
      (expected === null && exists) ||
      (expected !== null &&
        (!exists || this.revision(this.readWorkspaceText(file)) !== expected))
    )
      throw Object.assign(
        new Error(
          "Workspace changed. Reload and review your draft before saving again.",
        ),
        {
          statusCode: expected === null ? 409 : 412,
          code: "ERR_WORKSPACE_CONFLICT",
        },
      );
  }

  protected serializeResource(value: ApiCollection | Environment) {
    const canonical = { ...value };
    delete canonical.revision;
    let data = JSON.stringify(canonical, null, 2);
    // Formatting must not turn valid compact input into an unreadable resource.
    if (Buffer.byteLength(data) > 2 * 1024 * 1024)
      data = JSON.stringify(canonical);
    if (Buffer.byteLength(data) > 2 * 1024 * 1024)
      throw Object.assign(new Error("Resource exceeds 2 MiB"), {
        statusCode: 413,
      });
    return data;
  }

  protected commitResource(
    kind: "collections" | "environments",
    value: ApiCollection | Environment,
    expected?: string | null,
  ) {
    if (this.workspaceFileExists(this.manifestFile)) {
      this.commitManifestResource(kind, value, expected);
      return;
    }
    const file = this.resourceFile(kind, value.id);
    this.validateResource(value, kind, file, 400);
    const data = this.serializeResource(value);
    this.checkRevision(file, expected);
    this.checkWorkspaceWriteBudget(file, data);
    this.atomicWrite(file, data);
    value.revision = this.revision(data);
  }

  protected checkWorkspaceWriteBudget(target: string, data: string) {
    let bytes = Buffer.byteLength(data),
      documents = 1;
    for (const directory of [this.collectionsDir, this.environmentsDir]) {
      let files: string[];
      try {
        files = this.resourceFiles(directory);
      } catch (error: any) {
        if (error.code === "ERR_WORKSPACE_LIMIT")
          throw this.workspaceLimitError(413);
        throw error;
      }
      for (const name of files) {
        const file = path.join(directory, name);
        if (file === target) continue;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
          throw this.workspaceError(file);
        bytes += stat.size;
        documents++;
      }
    }
    if (bytes > workspaceLimits.bytes || documents > workspaceLimits.documents)
      throw this.workspaceLimitError(413);
  }

  public persistCollection(
    id: string,
    next?: ApiCollection,
    expected: string | null = this.collections.get(id)?.revision,
  ) {
    const value = next || this.collections.get(id);
    if (!value) return;
    this.commitResource("collections", value, expected);
    this.collections.set(id, value);
  }

  public persistCollections() {
    for (const id of this.collections.keys()) this.persistCollection(id);
  }

  public deleteCollection(
    id: string,
    expected = this.collections.get(id)?.revision,
  ) {
    this.assertWritable();
    if (this.workspaceFileExists(this.manifestFile)) {
      this.commitManifestResource("collections", undefined, expected, id);
      return;
    }
    const file = this.resourceFile("collections", id);
    this.checkRevision(file, expected);
    if (this.workspaceFileExists(file)) fs.unlinkSync(file);
    this.collections.delete(id);
  }

  public persistEnvironment(
    id: string,
    next?: Environment,
    expected: string | null = this.environments.get(id)?.revision,
  ) {
    const value = next || this.environments.get(id);
    if (!value) return;
    this.commitResource("environments", value, expected);
    this.environments.set(id, value);
  }

  public deleteEnvironment(
    id: string,
    expected = this.environments.get(id)?.revision,
  ) {
    this.assertWritable();
    if (this.workspaceFileExists(this.manifestFile)) {
      this.commitManifestResource("environments", undefined, expected, id);
      return;
    }
    const file = this.resourceFile("environments", id);
    this.checkRevision(file, expected);
    if (this.workspaceFileExists(file)) fs.unlinkSync(file);
    this.environments.delete(id);
  }

  private get formatMarker() { return path.join(this.storageDir, ".format-v1"); }
  private get manifestFile() { return path.join(this.storageDir, "workspace-v1.json"); }
  private get objectsDir() { return path.join(this.storageDir, "objects"); }
  private conflict(expected?: string | null): never {
    throw Object.assign(new Error("Workspace changed. Reload and review before saving."), {
      statusCode: expected === null ? 409 : 412, code: "ERR_WORKSPACE_CONFLICT",
    });
  }
  private readManifestSnapshot() {
    try { return this.readManifestSnapshotUnchecked(); }
    catch (error: any) { if (error.statusCode) throw error; throw this.workspaceError(this.manifestFile); }
  }
  private readManifestSnapshotUnchecked() {
    const raw = this.readWorkspaceText(this.manifestFile);
    const manifest = JSON.parse(raw);
    if (manifest.version !== 1 || !Array.isArray(manifest.collections) || !Array.isArray(manifest.environments))
      throw this.workspaceError(this.manifestFile);
    this.assertDirectory(this.objectsDir);
    this.objectFiles();
    if (manifest.collections.length + manifest.environments.length > workspaceLimits.documents) throw this.workspaceLimitError();
    const budget = { bytes: Buffer.byteLength(raw), documents: 1 };
    const load = (hash: string) => {
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw this.workspaceError(this.manifestFile);
      const file = this.objectFile(hash);
      const text = this.readWorkspaceText(file);
      budget.bytes += Buffer.byteLength(text); budget.documents++;
      if (budget.bytes > workspaceLimits.bytes) throw this.workspaceLimitError();
      if (this.revision(text) !== hash) throw this.workspaceError(file);
      return JSON.parse(text);
    };
    let hydratedNodes = 0;
    const hydrate = (items: any[], depth = 0): any[] => {
      if (!Array.isArray(items) || depth > 24) throw this.workspaceError(this.manifestFile);
      return items.map((item) => {
      if (++hydratedNodes > 10000 || !item || typeof item !== "object" || !item.value || typeof item.value !== "object" || Array.isArray(item.value)) throw this.workspaceError(this.manifestFile);
      const next = { ...item.value };
      if (item.requestRef) {
        const request = load(item.requestRef);
        if (request.version !== 1 || request.kind !== "request") throw this.workspaceError(this.manifestFile);
        next.request = request.value;
      }
      if (next.items !== undefined) next.items = hydrate(next.items, depth + 1);
      return next;
    }); };
    const read = <T extends ApiCollection | Environment>(refs: string[], kind: "collections" | "environments") => {
      const map = new Map<string, T>();
      for (const ref of refs) {
        const document = load(ref);
        if (document.version !== 1 || document.kind !== kind) throw this.workspaceError(this.manifestFile);
        const value = document.value;
        if (kind === "collections") { hydratedNodes = 0; value.items = hydrate(value.items); }
        this.validateResource(value, kind, this.manifestFile);
        if (map.has(value.id)) throw this.workspaceError(this.manifestFile);
        value.revision = this.revision(this.serializeResource(value));
        map.set(value.id, value);
      }
      return map;
    };
    const collections = read<ApiCollection>(manifest.collections, "collections");
    const environments = read<Environment>(manifest.environments, "environments");
    this.collections = collections; this.environments = environments; this.manifestRaw = raw;
    return { format: 1, revision: this.revision(raw), collections: [...collections.values()], environments: [...environments.values()] };
  }
  private prepareManifest(collections: ApiCollection[], environments: Environment[]) {
    const objects = new Map<string, string>();
    let references = 1, activeBytes = 0;
    const put = (value: unknown) => {
      let text = JSON.stringify(value, null, 2);
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw this.workspaceLimitError(413);
      references++; activeBytes += Buffer.byteLength(text);
      const hash = this.revision(text); objects.set(hash, text); return hash;
    };
    const dehydrate = (items: any[]): any[] => items.map((item) => {
      const next = { ...item };
      const requestRef = next.request ? put({ version: 1, kind: "request", value: next.request }) : undefined;
      delete next.request;
      if (next.items) next.items = dehydrate(next.items);
      return { value: next, ...(requestRef ? { requestRef } : {}) };
    });
    const refs = (values: (ApiCollection | Environment)[], kind: "collections" | "environments") => {
      if (new Set(values.map((value) => value.id)).size !== values.length) throw new Error("Duplicate resource IDs");
      return values.map((resource) => {
      this.validateResource(resource, kind, this.manifestFile, 400);
      this.serializeResource(resource); // Ensure reconstructed resources remain readable by every public adapter.
      const value = structuredClone(resource); delete value.revision;
      if (kind === "collections") (value as ApiCollection).items = dehydrate((value as ApiCollection).items);
      return put({ version: 1, kind, value });
    }); };
    const manifest = JSON.stringify({ version: 1, collections: refs(collections, "collections"), environments: refs(environments, "environments") }, null, 2);
    if (Buffer.byteLength(manifest) > 2 * 1024 * 1024 || collections.length + environments.length > workspaceLimits.documents || activeBytes + Buffer.byteLength(manifest) > workspaceLimits.bytes) throw this.workspaceLimitError(413);
    return { objects, manifest, documents: references, bytes: activeBytes + Buffer.byteLength(manifest) };
  }
  private objectFile(hash: string, create = false) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw this.workspaceError(this.manifestFile);
    const directory = path.join(this.objectsDir, hash.slice(0, 2));
    if (create && !fs.existsSync(directory)) {
      fs.mkdirSync(directory, { mode: 0o700 });
      const descriptor = fs.openSync(this.objectsDir, "r");
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
    this.assertDirectory(directory);
    if (!this.directoryIdentities.has(directory)) {
      const stat = fs.lstatSync(directory, { bigint: true });
      this.directoryIdentities.set(directory, `${stat.dev}:${stat.ino}`);
    }
    return path.join(directory, hash + ".json");
  }
  private objectFiles() {
    const files: string[] = [];
    for (const shard of this.workspaceEntries(this.objectsDir)) {
      if (!/^[a-f0-9]{2}$/.test(shard)) throw this.workspaceError(this.objectsDir);
      const directory = path.join(this.objectsDir, shard);
      this.assertDirectory(directory);
      if (!this.directoryIdentities.has(directory)) {
        const stat = fs.lstatSync(directory, { bigint: true });
        this.directoryIdentities.set(directory, `${stat.dev}:${stat.ino}`);
      }
      for (const name of this.workspaceEntries(directory)) files.push(path.join(shard, name));
    }
    return files;
  }
  private preflightObjectBudget(objects: Map<string, string>, manifest: string) {
    let entries: string[] = [];
    try {
      fs.lstatSync(this.objectsDir);
      this.assertDirectory(this.objectsDir);
      entries = this.objectFiles();
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    let bytes = Buffer.byteLength(manifest);
    for (const name of entries) bytes += Buffer.byteLength(this.readWorkspaceText(path.join(this.objectsDir, name)));
    const projected = new Set(entries);
    for (const [hash, text] of objects) {
      const name = path.join(hash.slice(0, 2), hash + ".json");
      if (!projected.has(name)) bytes += Buffer.byteLength(text);
      projected.add(name);
    }
    const counts = new Map<string, number>();
    for (const name of projected) counts.set(path.dirname(name), (counts.get(path.dirname(name)) || 0) + 1);
    if (bytes > workspaceLimits.bytes || [...counts.values()].some((count) => count > workspaceLimits.directoryEntries)) throw this.workspaceLimitError(413);
  }
  private publishManifest(collections: ApiCollection[], environments: Environment[], expectedRaw?: string, beforeCommit?: () => void) {
    this.assertWritable();
    const { objects, manifest } = this.prepareManifest(collections, environments);
    if (!fs.existsSync(this.objectsDir)) fs.mkdirSync(this.objectsDir, { mode: 0o700 });
    this.assertWorkspaceDirectories();
    this.preflightObjectBudget(objects, manifest);
    const stagedDirectories = new Set<string>();
    for (const [hash, text] of objects) {
      const file = this.objectFile(hash, true);
      if (this.workspaceFileExists(file)) { if (this.readWorkspaceText(file) !== text) throw this.workspaceError(file); }
      else { this.atomicWrite(file, text, false); stagedDirectories.add(path.dirname(file)); }
    }
    // Each file is fsynced individually; publish each shard's directory entries once per transaction.
    for (const directory of stagedDirectories) {
      this.assertDirectory(directory);
      const descriptor = fs.openSync(directory, "r");
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
    if (expectedRaw !== undefined) {
      if (!this.workspaceFileExists(this.manifestFile) || this.readWorkspaceText(this.manifestFile) !== expectedRaw) this.conflict();
    } else if (this.workspaceFileExists(this.manifestFile)) this.conflict(null);
    beforeCommit?.();
    this.atomicWrite(this.manifestFile, manifest); // Sole transaction commit point.
    // An advisory format guard prevents a later external manifest deletion from reviving retained legacy data.
    if (!this.workspaceFileExists(this.formatMarker)) this.atomicWrite(this.formatMarker, "1\n");
    return this.readManifestSnapshot();
  }
  private commitManifestResource(kind: "collections" | "environments", value: ApiCollection | Environment | undefined, expected?: string | null, id = value?.id) {
    const snapshot = this.readManifestSnapshot();
    const values = kind === "collections" ? snapshot.collections : snapshot.environments;
    const current = values.find((item) => item.id === id);
    if ((expected === null && current) || (expected !== undefined && expected !== null && current?.revision !== expected)) this.conflict(expected);
    const next = value
      ? (current ? values.map((item) => item.id === id ? value : item) : [...values, value])
      : values.filter((item) => item.id !== id);
    const result = this.publishManifest(kind === "collections" ? next as ApiCollection[] : snapshot.collections, kind === "environments" ? next as Environment[] : snapshot.environments, this.manifestRaw);
    if (value) value.revision = (kind === "collections" ? result.collections : result.environments).find((item) => item.id === id)?.revision;
  }
  public commitSnapshot(collections: ApiCollection[], environments: Environment[], expectedRevision: string) {
    if (!this.workspaceFileExists(this.manifestFile)) throw Object.assign(new Error("Explicit workspace migration is required for multi-resource transactions"), { statusCode: 409, code: "ERR_WORKSPACE_MIGRATION_REQUIRED" });
    const snapshot = this.readManifestSnapshot();
    if (snapshot.revision !== expectedRevision) this.conflict();
    return this.publishManifest(collections, environments, this.manifestRaw);
  }
  public migrationPlan() {
    const snapshot = this.snapshot();
    const prepared = this.prepareManifest(snapshot.collections, snapshot.environments);
    this.preflightObjectBudget(prepared.objects, prepared.manifest);
    return { version: 1, operation: "migrate", from: snapshot.format, to: 1, revision: snapshot.revision, collections: snapshot.collections.length, environments: snapshot.environments.length, documents: prepared.documents, bytes: prepared.bytes, checksum: this.revision(JSON.stringify(snapshot)) };
  }
  public backup() {
    const snapshot = this.snapshot();
    const payload = JSON.stringify({ version: 1, collections: snapshot.collections, environments: snapshot.environments });
    const backup = { version: 1, checksum: this.revision(payload), payload };
    if (Buffer.byteLength(JSON.stringify(backup)) > 64 * 1024 * 1024) throw new Error("Backup exceeds 64 MiB");
    return backup;
  }
  public migrate(reviewedChecksum: string) {
    const plan = this.migrationPlan();
    if (plan.from === 1) throw new Error("Workspace is already migrated");
    if (reviewedChecksum !== plan.checksum) this.conflict();
    const backup = this.backup();
    // Retain an exact logical backup before any new-format writes. Legacy files remain untouched.
    const backupFile = path.join(this.storageDir, "backup-" + backup.checksum + ".json");
    this.atomicWrite(backupFile, JSON.stringify(backup));
    const verified = WorkspaceRepository.readBackup(backupFile);
    if (verified.checksum !== backup.checksum || verified.payload !== backup.payload) throw new Error("Retained backup verification failed");
    const snapshot = this.snapshot();
    if (this.migrationPlan().checksum !== reviewedChecksum) this.conflict();
    const result = this.publishManifest(snapshot.collections, snapshot.environments, undefined, () => {
      if (this.migrationPlan().checksum !== reviewedChecksum) this.conflict();
    });
    return { revision: result.revision, backup: "backup-" + backup.checksum + ".json", checksum: backup.checksum };
  }
  public restore(backup: { version: number; checksum: string; payload: string }, reviewedChecksum: string, expectedRevision: string) {
    this.restorePlan(backup);
    if (backup.version !== 1 || this.revision(backup.payload) !== backup.checksum || reviewedChecksum !== backup.checksum) throw new Error("Backup checksum must match the reviewed backup");
    const parsed = this.parseBackupPayload(backup.payload);
    if (parsed.version !== 1 || !Array.isArray(parsed.collections) || !Array.isArray(parsed.environments)) throw new Error("Invalid backup schema");
    for (const value of parsed.collections) this.validateResource(value, "collections", "backup", 400);
    for (const value of parsed.environments) this.validateResource(value, "environments", "backup", 400);
    const snapshot = this.snapshot();
    if (snapshot.revision !== expectedRevision) this.conflict();
    if (snapshot.format !== 1) throw new Error("Migrate the workspace explicitly before restoring");
    const retained = this.backup();
    this.atomicWrite(path.join(this.storageDir, "backup-" + retained.checksum + ".json"), JSON.stringify(retained));
    return this.commitSnapshot(parsed.collections, parsed.environments, expectedRevision);
  }
  private assertWritable() {
    if (this.readOnly) throw new Error("Read-only workspace");
    this.assertWorkspaceDirectories();
  }
  private maximumFileBytes(file: string) {
    return /^backup-[a-f0-9]{64}\.json$/.test(path.basename(file)) && path.dirname(file) === this.storageDir ? 64 * 1024 * 1024 : 2 * 1024 * 1024;
  }
  static readBackup(file: string): { version: number; checksum: string; payload: string } {
    if (!fs.lstatSync(file).isFile()) throw new Error("Backup must be a regular file");
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const maximum = 64 * 1024 * 1024;
      if (!fs.fstatSync(descriptor).isFile() || fs.fstatSync(descriptor).size > maximum) throw new Error("Backup exceeds 64 MiB");
      const chunks: Buffer[] = []; let bytes = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(Math.min(65536, maximum + 1 - bytes));
        const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (!count) break;
        bytes += count; if (bytes > maximum) throw new Error("Backup exceeds 64 MiB");
        chunks.push(buffer.subarray(0, count));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new Error("Malformed JSON backup"); }
    } finally { fs.closeSync(descriptor); }
  }
  private parseBackupPayload(payload: string) {
    try { return JSON.parse(payload); } catch { throw new Error("Malformed backup payload"); }
  }
  public restorePlan(backup: { version: number; checksum: string; payload: string }) {
    if (backup.version !== 1 || typeof backup.payload !== "string" || this.revision(backup.payload) !== backup.checksum) throw new Error("Invalid backup checksum");
    const parsed = this.parseBackupPayload(backup.payload);
    if (parsed.version !== 1 || !Array.isArray(parsed.collections) || !Array.isArray(parsed.environments)) throw new Error("Invalid backup schema");
    for (const kind of ["collections", "environments"] as const) {
      if (new Set(parsed[kind].map((value: any) => value.id)).size !== parsed[kind].length) throw new Error("Duplicate backup IDs");
      for (const value of parsed[kind]) this.validateResource(value, kind, "backup", 400);
    }
    const prepared = this.prepareManifest(parsed.collections, parsed.environments);
    this.preflightObjectBudget(prepared.objects, prepared.manifest);
    return { operation: "restore", checksum: backup.checksum, revision: this.snapshot().revision, collections: parsed.collections.length, environments: parsed.environments.length };
  }
  public moveItem(command: { sourceCollectionId: string; destinationCollectionId: string; sourceRevision: string; destinationRevision: string; itemId: string; destinationFolderId?: string; index?: number }) {
    if (!command || typeof command !== "object") throw Object.assign(new Error("Invalid move command"), { statusCode: 400 });
    const snapshot = this.snapshot();
    if (snapshot.format !== 1) throw Object.assign(new Error("Explicit workspace migration is required for multi-resource transactions"), { statusCode: 409, code: "ERR_WORKSPACE_MIGRATION_REQUIRED" });
    const source = snapshot.collections.find((value) => value.id === command.sourceCollectionId);
    const destination = snapshot.collections.find((value) => value.id === command.destinationCollectionId);
    const invalid = () => Object.assign(new Error("Invalid move source, destination, item or index"), { statusCode: 400 });
    if (!source || !destination || source === destination || !command.sourceRevision || !command.destinationRevision) throw invalid();
    if (source.revision !== command.sourceRevision || destination.revision !== command.destinationRevision) this.conflict();
    const find = (items: ApiCollection["items"], id: string): { items: ApiCollection["items"]; index: number } | undefined => {
      for (let index = 0; index < items.length; index++) {
        if (items[index].id === id) return { items, index };
        const nested = items[index].items && find(items[index].items, id); if (nested) return nested;
      }
    };
    const located = find(source.items, command.itemId); if (!located) throw invalid();
    const folder = command.destinationFolderId ? find(destination.items, command.destinationFolderId) : undefined;
    if (command.destinationFolderId && (!folder || !folder.items[folder.index].isFolder)) throw invalid();
    const target = folder ? (folder.items[folder.index].items ||= []) : destination.items;
    const index = command.index === undefined ? target.length : command.index;
    if (!Number.isInteger(index) || index < 0 || index > target.length) throw invalid();
    target.splice(index, 0, located.items.splice(located.index, 1)[0]);
    return this.commitSnapshot(snapshot.collections, snapshot.environments, snapshot.revision);
  }
}
