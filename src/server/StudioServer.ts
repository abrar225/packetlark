import http from "node:http";
import { readIncomingBody } from "../core/engine/BodyBudget.js";
import { createHash } from "node:crypto";
import { validWorkspaceResource } from "../core/models/WorkspaceValidation.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CollectionRunner,
  RunReport,
  reportWithoutBodies,
} from "../core/runner/CollectionRunner.js";
import { resolveCollectionRequest } from "../core/models/CollectionContext.js";
import { CookieJar } from "tough-cookie";
import { HttpExecutor } from "../core/engine/HttpExecutor.js";
import { PostmanConverter } from "../core/models/PostmanConverter.js";
import { TrafficSnifferProxy } from "../core/sniffing/TrafficSnifferProxy.js";
import { OpenApiGenerator } from "../core/sniffing/OpenApiGenerator.js";
import { SdkGenerator } from "../core/sniffing/SdkGenerator.js";
import {
  ApiCollection,
  CollectionItem,
  Environment,
  HttpRequest,
} from "../core/models/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../");
const publicDir = path.resolve(projectRoot, "public");
const storageDir = path.resolve(projectRoot, ".rea-api");

function findAndUpdateRequest(
  items: CollectionItem[],
  req: HttpRequest,
): boolean {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.request && (item.request.id === req.id || item.id === req.id)) {
      item.request = req;
      item.name = req.name || item.name;
      return true;
    }
    if (item.isFolder && item.items) {
      if (findAndUpdateRequest(item.items, req)) return true;
    }
  }
  return false;
}

function findAndDeleteRequest(items: CollectionItem[], reqId: string): boolean {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if ((item.request && item.request.id === reqId) || item.id === reqId) {
      items.splice(i, 1);
      return true;
    }
    if (item.isFolder && item.items) {
      if (findAndDeleteRequest(item.items, reqId)) return true;
    }
  }
  return false;
}

interface RunJob {
  controller: AbortController;
  state: "running" | "completed";
  result?: RunReport;
  error?: string;
  progress?: any;
  retainedBytes?: number;
}
const maxRunHistoryBytes = 32 * 1024 * 1024;

export class StudioServer {
  private server: http.Server | null = null;
  private port: number;
  private cookieJar = new CookieJar();
  private executions = new Set<AbortController>();
  private runs = new Map<string, RunJob>();
  private storageDir: string;
  private collectionsDir: string;
  private environmentsDir: string;
  private sniffer: TrafficSnifferProxy;
  private collections: Map<string, ApiCollection> = new Map();
  private environments: Map<string, Environment> = new Map();
  private directoryIdentities = new Map<string, string>();

  constructor(
    port: number = 4040,
    snifferPort: number = 8085,
    workspaceDir: string = storageDir,
  ) {
    this.storageDir = workspaceDir;
    this.collectionsDir = path.join(workspaceDir, "collections");
    this.environmentsDir = path.join(workspaceDir, "environments");
    this.port = port;
    this.sniffer = new TrafficSnifferProxy(snifferPort);
    this.ensureStorage();
    this.loadInitialCollections();
    this.loadInitialEnvironments();
  }

  private ensureStorage() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    }
    this.assertDirectory(this.storageDir);
    // Bind paths once to the chosen root, resolving platform aliases such as /var.
    this.storageDir = fs.realpathSync(this.storageDir);
    this.collectionsDir = path.join(this.storageDir, "collections");
    this.environmentsDir = path.join(this.storageDir, "environments");
    for (const directory of [this.collectionsDir, this.environmentsDir]) {
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
      this.assertDirectory(directory);
    }
    for (const directory of [
      this.storageDir,
      this.collectionsDir,
      this.environmentsDir,
    ]) {
      const stat = fs.lstatSync(directory, { bigint: true });
      this.directoryIdentities.set(directory, `${stat.dev}:${stat.ino}`);
    }
  }

  private assertDirectory(directory: string) {
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

  private assertWorkspaceDirectories() {
    for (const directory of [
      this.storageDir,
      this.collectionsDir,
      this.environmentsDir,
    ])
      this.assertDirectory(directory);
  }

  private workspaceError(file: string) {
    return Object.assign(
      new Error(
        `Invalid workspace resource: ${path.basename(file)}. Repair or restore this file before continuing.`,
      ),
      { statusCode: 503, code: "ERR_WORKSPACE_INVALID" },
    );
  }

  private workspaceFileExists(file: string) {
    this.assertWorkspaceDirectories();
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
        throw this.workspaceError(file);
      return true;
    } catch (error: any) {
      if (error.code === "ENOENT") return false;
      throw this.workspaceError(file);
    }
  }

  private readWorkspaceText(file: string) {
    this.assertWorkspaceDirectories();
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
      const maximum = 2 * 1024 * 1024;
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

  private readWorkspaceJson(file: string, includeRevision = false) {
    const raw = this.readWorkspaceText(file);
    try {
      const value = JSON.parse(raw);
      if (includeRevision && value && typeof value === "object")
        value.revision = this.revision(raw);
      return value;
    } catch {
      throw this.workspaceError(file);
    }
  }

  private validateResource(
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

  private readResourceDirectory<T>(
    directory: string,
    kind: "collections" | "environments",
  ): Map<string, T> {
    this.assertWorkspaceDirectories();
    const resources = new Map<string, T>();
    for (const file of fs
      .readdirSync(directory)
      .filter((file) => file.endsWith(".json"))) {
      const fullPath = path.join(directory, file);
      const resource = this.readWorkspaceJson(fullPath, true);
      this.validateResource(resource, kind, fullPath);
      if (file !== resource.id + ".json" || resources.has(resource.id))
        throw this.workspaceError(fullPath);
      resources.set(resource.id, resource);
    }
    return resources;
  }

  private migrateLegacy(
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

  private finishInitialization(directory: string) {
    this.atomicWrite(path.join(directory, ".initialized"), "1\n");
    // Marker is the commit point. A leftover journal is ignored once committed.
    try {
      fs.unlinkSync(path.join(directory, ".migration"));
    } catch {}
  }

  private loadInitialCollections() {
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
          { key: "repo", value: "abrar225/rea-api-studio", enabled: true },
        ],
        items: [
          {
            id: "req_1",
            name: "Get Rea repository",
            request: {
              id: "req_1",
              name: "Get Rea repository",
              method: "GET",
              url: "{{baseUrl}}/repos/{{repo}}",
              headers: [
                { key: "User-Agent", value: "ReaAPI-Studio", enabled: true },
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
    pm.expect(data.name).to.equal("rea-api-studio");
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
                    client: "ReaAPI Studio",
                    message: "Hello from Rea",
                  },
                  null,
                  2,
                ),
              },
              auth: { type: "none" },
              testScript: `pm.test("Echo response received", function () {
    pm.expect(pm.response.code).to.equal(200);
    var json = pm.response.json();
    pm.expect(json.json.client).to.equal("ReaAPI Studio");
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

  private loadInitialEnvironments() {
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

  private atomicWrite(file: string, data: string) {
    this.assertWorkspaceDirectories();
    this.workspaceFileExists(file); // Reject non-regular destinations, including dangling links.
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
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private revision(data: string) {
    return createHash("sha256").update(data).digest("hex");
  }

  private resourceFile(kind: "collections" | "environments", id: string) {
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

  private checkRevision(file: string, expected?: string | null) {
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

  private serializeResource(value: ApiCollection | Environment) {
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

  private commitResource(
    kind: "collections" | "environments",
    value: ApiCollection | Environment,
    expected?: string | null,
  ) {
    const file = this.resourceFile(kind, value.id);
    this.validateResource(value, kind, file, 400);
    const data = this.serializeResource(value);
    this.checkRevision(file, expected);
    this.atomicWrite(file, data);
    value.revision = this.revision(data);
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
    const file = this.resourceFile("environments", id);
    this.checkRevision(file, expected);
    if (this.workspaceFileExists(file)) fs.unlinkSync(file);
    this.environments.delete(id);
  }

  private activeWorkCount() {
    return (
      this.executions.size +
      [...this.runs.values()].filter((job) => job.state === "running").length
    );
  }

  private runHistoryStats() {
    let retainedBytes = 0,
      completedRuns = 0;
    for (const job of this.runs.values())
      if (job.state === "completed") {
        retainedBytes += job.retainedBytes || 0;
        completedRuns++;
      }
    return {
      retainedBytes,
      completedRuns,
      limitBytes: maxRunHistoryBytes,
      maxRuns: 20,
    };
  }

  private completeRun(id: string, job: RunJob) {
    job.state = "completed";
    job.retainedBytes =
      (job.result ? Buffer.byteLength(JSON.stringify(job.result)) : 0) +
      Buffer.byteLength(
        JSON.stringify({
          id,
          state: job.state,
          error: job.error,
          progress: job.progress,
        }),
      );
    while (
      this.runHistoryStats().retainedBytes > maxRunHistoryBytes ||
      this.runs.size > 20
    ) {
      const oldest = [...this.runs].find(
        ([, entry]) => entry.state === "completed",
      );
      if (!oldest) break;
      this.runs.delete(oldest[0]);
    }
  }

  public async start(): Promise<number> {
    // Start sniffer proxy in parallel
    await this.sniffer.start();

    return new Promise((resolve, reject) => {
      this.server = http.createServer(
        {
          headersTimeout: 10000,
          requestTimeout: 10000,
          connectionsCheckingInterval: 1000,
        },
        async (req, res) => {
          req.on("error", () => {});
          res.on("error", () => {});
          // Only the local studio may use this API from a browser. Check Host too,
          // so a foreign hostname resolving to loopback cannot bypass the origin check.
          const host = req.headers.host || "";
          const allowedHosts = [
            `localhost:${this.port}`,
            `127.0.0.1:${this.port}`,
          ];
          const origin = req.headers.origin;
          if (
            !allowedHosts.includes(host) ||
            (req.headers["sec-fetch-site"] &&
              !["same-origin", "none"].includes(
                String(req.headers["sec-fetch-site"]),
              )) ||
            (origin && !allowedHosts.some((h) => origin === `http://${h}`))
          ) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Only the local studio origin is allowed",
              }),
            );
            return;
          }
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Referrer-Policy", "no-referrer");
          if (origin) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
          }
          if (req.method === "OPTIONS") {
            res.setHeader(
              "Access-Control-Allow-Methods",
              "GET, POST, PUT, DELETE, OPTIONS",
            );
            res.setHeader(
              "Access-Control-Allow-Headers",
              "Content-Type, Authorization, X-Requested-With",
            );
            res.writeHead(204);
            res.end();
            return;
          }
          const urlObj = new URL(
            req.url || "/",
            `http://localhost:${this.port}`,
          );
          const pathname = urlObj.pathname;

          // REST API routes with top-level error isolation
          if (pathname.startsWith("/api/")) {
            try {
              await this.handleApi(req, res, pathname, urlObj);
            } catch (err: any) {
              if (res.destroyed || res.headersSent) {
                if (!res.destroyed) res.destroy();
                return;
              }
              res.shouldKeepAlive = false;
              res.setHeader("Connection", "close");
              res.once("finish", () => {
                if (!req.complete) req.destroy();
              });
              res.writeHead(err.statusCode || 500, {
                "Content-Type": "application/json",
              });
              res.end(
                JSON.stringify({
                  error: {
                    category: "Internal Server Error",
                    message:
                      err.message || "An unhandled server exception occurred",
                    guidance:
                      "Please inspect the request payload or server diagnostics.",
                    code: err.code || "INTERNAL_ERROR",
                  },
                }),
              );
            }
            return;
          }

          // Static files from public/
          this.serveStatic(req, res, pathname);
        },
      );

      this.server.maxConnections = 64;
      this.server.listen(this.port, "127.0.0.1", () => {
        this.port = (this.server.address() as { port: number }).port;
        resolve(this.port);
      });

      this.server.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          this.port += 1;
          this.server?.listen(this.port, "127.0.0.1");
        } else {
          reject(err);
        }
      });
    });
  }

  private async handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    urlObj: URL,
  ) {
    const workspacePath =
      /^\/api\/(collections|environments)(\/|$)/.test(pathname) ||
      pathname === "/api/execute" ||
      pathname === "/api/import/postman" ||
      (pathname === "/api/runs" && req.method === "POST");
    if (workspacePath) this.assertWorkspaceDirectories();
    const clientRevision =
      typeof req.headers["if-match"] === "string"
        ? req.headers["if-match"].replace(/^"|"$/g, "")
        : undefined;
    const sendJson = (data: any, statusCode = 200) => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    const readBody = async (): Promise<any> => {
      const bytes = await readIncomingBody(
        req,
        2 * 1024 * 1024,
        AbortSignal.timeout(10000),
      );
      if (workspacePath) this.assertWorkspaceDirectories();
      const str = bytes.toString("utf8");
      if (!str.trim()) return {};
      try {
        return JSON.parse(str);
      } catch {
        throw Object.assign(new Error("Malformed JSON request body"), {
          statusCode: 400,
        });
      }
    };

    // 1. Health check & memory footprint
    if (pathname === "/api/health") {
      const mem = process.memoryUsage();
      sendJson({
        status: "healthy",
        uptimeSec: Math.floor(process.uptime()),
        product: "rea-api-studio",
        version: "1.1.0",
        memoryRssMb: (mem.rss / 1024 / 1024).toFixed(2),
        memoryHeapUsedMb: (mem.heapUsed / 1024 / 1024).toFixed(2),
        snifferActive: this.sniffer.isRunning(),
        snifferPort: this.sniffer.getPort(),
        collectionsCount: this.collections.size,
        environmentsCount: this.environments.size,
        runHistory: this.runHistoryStats(),
        activeWork: this.activeWorkCount(),
        maxActiveWork: 2,
      });
      return;
    }

    // 2. Dispatch Request Execution with environment sync
    if (pathname === "/api/execute" && req.method === "POST") {
      const body = await readBody();
      let httpRequest = body.request;
      let collectionVars = body.collectionVariables || [];
      const envId = body.environmentId;
      let envVars = body.environmentVariables || [];
      const environmentSnapshot =
        envId && this.environments.has(envId)
          ? structuredClone(this.environments.get(envId))
          : undefined;

      if (!httpRequest || !httpRequest.url) {
        sendJson({ error: "Invalid request: url is required" }, 400);
        return;
      }

      if (
        body.environmentRevision &&
        environmentSnapshot?.revision !== body.environmentRevision
      )
        throw Object.assign(
          new Error(
            "Environment changed before execution. Reload and review it before sending.",
          ),
          { statusCode: 412, code: "ERR_WORKSPACE_CONFLICT" },
        );
      if (environmentSnapshot)
        this.checkRevision(
          this.resourceFile("environments", envId),
          environmentSnapshot.revision,
        );

      if (envId && this.environments.has(envId)) {
        const env = this.environments.get(envId)!;
        if (
          !body.environmentVariables ||
          body.environmentVariables.length === 0
        ) {
          envVars = env.values;
        }
      }

      const initialEnvironment = Object.fromEntries(
        envVars
          .filter((value) => value.enabled !== false)
          .map((value) => [value.key, String(value.value)]),
      );
      if (body.collectionId) {
        const collection = this.collections.get(body.collectionId);
        if (!collection) {
          sendJson({ error: "Collection not found" }, 404);
          return;
        }
        const resolved = resolveCollectionRequest(collection, httpRequest);
        httpRequest = resolved.request;
        collectionVars = resolved.variables;
      }
      if (this.activeWorkCount() >= 2) {
        sendJson(
          {
            error: {
              code: "ERR_CONCURRENCY",
              message:
                "Two executions or runs are active. Cancel or wait for one.",
            },
          },
          503,
        );
        return;
      }
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", onClose);
      this.executions.add(controller);
      let response;
      try {
        response = await HttpExecutor.execute(
          httpRequest,
          collectionVars,
          envVars,
          { cookieJar: this.cookieJar, signal: controller.signal },
        );
      } finally {
        res.off("close", onClose);
        this.executions.delete(controller);
      }
      if (res.destroyed) return;

      // Auto-sync script mutations back to active environment file on disk
      if (
        envId &&
        environmentSnapshot &&
        response.updatedEnvironment &&
        [
          ...new Set([
            ...Object.keys(initialEnvironment),
            ...Object.keys(response.updatedEnvironment),
          ]),
        ].some(
          (key) => initialEnvironment[key] !== response.updatedEnvironment[key],
        )
      ) {
        const env = structuredClone(environmentSnapshot);
        const original = new Map(env.values.map((value) => [value.key, value]));
        env.values = [
          ...env.values.filter(
            (v) =>
              v.enabled === false &&
              !Object.hasOwn(response.updatedEnvironment, v.key),
          ),
          ...Object.entries(response.updatedEnvironment).map(
            ([key, value]) => ({
              ...original.get(key),
              key,
              value: String(value),
              enabled: original.get(key)?.enabled !== false,
            }),
          ),
        ];
        try {
          this.persistEnvironment(env.id, env, environmentSnapshot.revision);
          response.persistence = {
            environment: { status: "saved", revision: env.revision },
          };
        } catch (error: any) {
          response.persistence = {
            environment: {
              status:
                error.code === "ERR_WORKSPACE_CONFLICT" ? "conflict" : "failed",
              code: error.code || "ERR_ENVIRONMENT_SAVE",
              message:
                error.code === "ERR_WORKSPACE_CONFLICT"
                  ? error.message
                  : "Request completed, but environment changes could not be saved. Review them before retrying.",
            },
          };
        }
      }

      sendJson(response);
      return;
    }

    if (pathname === "/api/runs" && req.method === "POST") {
      const body = await readBody();
      if (this.activeWorkCount() >= 2) {
        sendJson(
          {
            error:
              "Two executions or runs are already active. Cancel or wait for one.",
          },
          429,
        );
        return;
      }
      const collection = this.collections.get(body.collectionId);
      if (!collection) {
        sendJson({ error: "Collection not found" }, 404);
        return;
      }
      const controller = new AbortController(),
        id = crypto.randomUUID();
      while (this.runs.size >= 20) {
        const completed = [...this.runs].find(
          ([, run]) => run.state === "completed",
        );
        if (!completed) break;
        this.runs.delete(completed[0]);
      }
      const job: RunJob = { controller, state: "running" };
      this.runs.set(id, job);
      CollectionRunner.run(collection, {
        environment: body.environmentId
          ? this.environments.get(body.environmentId)
          : undefined,
        data: body.data,
        iterations: body.iterations,
        folder: body.folder,
        delayMs: body.delayMs,
        stopOnFailure: body.stopOnFailure,
        timeoutMs: body.timeoutMs,
        signal: controller.signal,
        onProgress: (progress) =>
          (job.progress = { ...progress, name: progress.name.slice(0, 512) }),
      })
        .then((result) => {
          job.result = reportWithoutBodies(result);
          this.completeRun(id, job);
        })
        .catch((error) => {
          job.error = String(error.message).slice(0, 512);
          this.completeRun(id, job);
        });
      sendJson({ id, state: job.state }, 202);
      return;
    }
    const runMatch = pathname.match(/^\/api\/runs\/([a-f0-9-]+)(\/cancel)?$/);
    if (runMatch) {
      const job = this.runs.get(runMatch[1]);
      if (!job) {
        sendJson({ error: "Run not found" }, 404);
        return;
      }
      if (runMatch[2] && req.method === "POST") {
        job.controller.abort();
        sendJson({ ok: true });
        return;
      }
      if (req.method === "GET") {
        sendJson({
          id: runMatch[1],
          state: job.state,
          progress: job.progress,
          result: job.result,
          error: job.error,
        });
        return;
      }
    }

    // 3. Environments CRUD & Variable Sync
    if (pathname === "/api/environments") {
      if (req.method === "GET") {
        this.loadInitialEnvironments();
        sendJson(Array.from(this.environments.values()));
        return;
      }
      if (req.method === "POST") {
        const newEnv: Environment = await readBody();
        if (!newEnv.id) newEnv.id = crypto.randomUUID();
        if (!newEnv.name) newEnv.name = "New Environment";
        if (!Array.isArray(newEnv.values)) newEnv.values = [];

        this.persistEnvironment(newEnv.id, newEnv, null);
        sendJson(newEnv);
        return;
      }
    }

    const envMatch = pathname.match(/^\/api\/environments\/([a-zA-Z0-9_-]+)/);
    if (envMatch) {
      const envId = envMatch[1];
      if (req.method === "GET" && pathname === `/api/environments/${envId}`) {
        const env = this.environments.get(envId);
        if (!env) {
          sendJson({ error: "Environment not found" }, 404);
          return;
        }
        sendJson(env);
        return;
      }
      if (req.method === "PUT" && pathname === `/api/environments/${envId}`) {
        const body = await readBody();
        const existing = this.environments.get(envId);
        if (!existing) {
          sendJson({ error: "Environment not found" }, 404);
          return;
        }
        const updatedEnv: Environment = {
          ...existing,
          ...body,
          id: envId,
        };
        this.persistEnvironment(
          envId,
          updatedEnv,
          clientRevision || existing.revision,
        );
        sendJson(updatedEnv);
        return;
      }
      if (
        req.method === "DELETE" &&
        pathname === `/api/environments/${envId}`
      ) {
        this.deleteEnvironment(
          envId,
          clientRevision || this.environments.get(envId)?.revision,
        );
        sendJson({ ok: true, deleted: envId });
        return;
      }
      if (req.method === "POST" && pathname.endsWith("/sync")) {
        const { variables } = await readBody();
        if (variables && this.environments.has(envId)) {
          const env = structuredClone(this.environments.get(envId)!);
          for (const [k, v] of Object.entries(
            variables as Record<string, string>,
          )) {
            const existing = env.values.find((p) => p.key === k);
            if (existing) existing.value = v;
            else env.values.push({ key: k, value: v, enabled: true });
          }
          this.persistEnvironment(envId, env, clientRevision || env.revision);
          sendJson(env);
          return;
        }
      }
    }

    // 4. Collections CRUD & Request Save/Update/Delete
    if (pathname === "/api/collections") {
      if (req.method === "GET") {
        this.loadInitialCollections();
        sendJson(Array.from(this.collections.values()));
        return;
      }
      if (req.method === "POST") {
        const newCol: ApiCollection = await readBody();
        if (!newCol.id) newCol.id = crypto.randomUUID();
        if (!newCol.name) newCol.name = "New Collection";
        if (!Array.isArray(newCol.items)) newCol.items = [];
        if (!Array.isArray(newCol.variables)) newCol.variables = [];

        this.persistCollection(newCol.id, newCol, null);
        sendJson(newCol);
        return;
      }
    }

    const colMatch = pathname.match(/^\/api\/collections\/([a-zA-Z0-9_-]+)/);
    if (colMatch) {
      const colId = colMatch[1];
      const collection = this.collections.get(colId);

      if (req.method === "GET" && pathname === `/api/collections/${colId}`) {
        if (!collection) {
          sendJson({ error: "Collection not found" }, 404);
          return;
        }
        sendJson(collection);
        return;
      }

      if (req.method === "PUT" && pathname === `/api/collections/${colId}`) {
        const body = await readBody();
        if (!collection) {
          sendJson({ error: "Collection not found" }, 404);
          return;
        }
        const updatedCol: ApiCollection = {
          ...collection,
          ...body,
          id: colId,
        };
        this.persistCollection(
          colId,
          updatedCol,
          clientRevision || collection.revision,
        );
        sendJson(updatedCol);
        return;
      }

      if (
        req.method === "GET" &&
        pathname === `/api/collections/${colId}/export/postman`
      ) {
        if (!collection) {
          sendJson({ error: "Collection not found" }, 404);
          return;
        }
        const postmanJson = PostmanConverter.toPostman(collection);
        sendJson(postmanJson);
        return;
      }

      if (req.method === "DELETE" && pathname === `/api/collections/${colId}`) {
        this.deleteCollection(
          colId,
          clientRevision || this.collections.get(colId)?.revision,
        );
        sendJson({ ok: true, deleted: colId });
        return;
      }

      // Save/Update request inside collection
      if (
        pathname === `/api/collections/${colId}/requests` &&
        req.method === "POST"
      ) {
        if (!collection) {
          sendJson({ error: "Collection not found" }, 404);
          return;
        }
        const body = await readBody();
        const reqToSave: HttpRequest = body.request || body;
        if (!reqToSave.id) reqToSave.id = crypto.randomUUID();

        const next = structuredClone(collection);
        const updated = findAndUpdateRequest(next.items, reqToSave);
        if (!updated) {
          next.items.push({
            id: reqToSave.id,
            name: reqToSave.name || "New Request",
            isFolder: false,
            request: reqToSave,
          });
        }
        this.persistCollection(
          colId,
          next,
          clientRevision || collection.revision,
        );
        sendJson({ ok: true, request: reqToSave, collection: next });
        return;
      }

      // Delete request inside collection
      const delReqMatch = pathname.match(
        /^\/api\/collections\/([a-zA-Z0-9_-]+)\/requests\/([a-zA-Z0-9_-]+)/,
      );
      if (delReqMatch && req.method === "DELETE") {
        const reqId = delReqMatch[2];
        if (collection) {
          const next = structuredClone(collection);
          findAndDeleteRequest(next.items, reqId);
          this.persistCollection(
            colId,
            next,
            clientRevision || collection.revision,
          );
          sendJson({ ok: true, deleted: reqId, collection: next });
          return;
        }
      }
    }

    // 5. Import Postman Collection
    if (pathname === "/api/import/postman" && req.method === "POST") {
      const postmanJson = await readBody();
      let collection: ApiCollection;
      try {
        collection = PostmanConverter.fromPostman(postmanJson);
      } catch (error) {
        throw Object.assign(error, { statusCode: 400 });
      }
      this.persistCollection(collection.id, collection, null);
      sendJson(collection);
      return;
    }

    // 6. Import cURL
    if (pathname === "/api/import/curl" && req.method === "POST") {
      const { curl } = await readBody();
      let request;
      try {
        request = PostmanConverter.fromCurl(curl || "");
      } catch (error) {
        throw Object.assign(error, { statusCode: 400 });
      }
      sendJson(request);
      return;
    }

    // 7. Sniffer Proxy Controls
    if (pathname === "/api/sniff/status") {
      sendJson({
        active: this.sniffer.isRunning(),
        port: this.sniffer.getPort(),
        capturedCount: this.sniffer.getCaptureStats().retainedRecords,
        capture: this.sniffer.getCaptureStats(),
      });
      return;
    }

    if (pathname === "/api/sniff/toggle" && req.method === "POST") {
      if (this.sniffer.isRunning()) {
        await this.sniffer.stop();
      } else {
        await this.sniffer.start();
      }
      sendJson({
        active: this.sniffer.isRunning(),
        port: this.sniffer.getPort(),
      });
      return;
    }

    if (pathname === "/api/sniff/traffic") {
      sendJson(this.sniffer.getCapturedItems());
      return;
    }

    if (pathname === "/api/sniff/clear" && req.method === "POST") {
      this.sniffer.clearCapturedItems();
      sendJson({ ok: true });
      return;
    }

    // 8. Auto-generate OpenAPI 3.1 from captured traffic
    if (pathname === "/api/sniff/export/openapi") {
      const traffic = this.sniffer.getCapturedItems();
      const spec = OpenApiGenerator.generate(
        traffic,
        "Captured API",
        "1.0.0",
        urlObj.searchParams.get("origin") || undefined,
      );
      sendJson(spec);
      return;
    }

    // 9. Auto-generate Client SDK
    if (pathname === "/api/sniff/export/sdk") {
      const traffic = this.sniffer.getCapturedItems();
      const spec = OpenApiGenerator.generate(
        traffic,
        "Captured API",
        "1.0.0",
        urlObj.searchParams.get("origin") || undefined,
      );
      const sdkCode = SdkGenerator.generateTypeScript(spec);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(sdkCode);
      return;
    }

    sendJson({ error: "Endpoint not found" }, 404);
  }

  private serveStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ) {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400);
      res.end("Invalid path");
      return;
    }
    const relativePath =
      decodedPath === "/"
        ? "index.html"
        : decodedPath === "/studio"
          ? "studio.html"
          : decodedPath.replace(/^\/+/, "");
    const filePath = path.resolve(publicDir, relativePath);
    if (
      !filePath.startsWith(publicDir + path.sep) ||
      !fs.existsSync(filePath) ||
      !fs.statSync(filePath).isFile()
    ) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
    };

    const contentType = mimeTypes[ext] || "application/octet-stream";

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    });
  }

  public async stop(): Promise<void> {
    for (const run of this.runs.values()) run.controller.abort();
    for (const execution of this.executions) execution.abort();
    await this.sniffer.stop();
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server?.close(() => resolve());
      this.server?.closeAllConnections();
    });
  }
}
