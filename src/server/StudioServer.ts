import http from "node:http";
import { readIncomingBody } from "../core/engine/BodyBudget.js";
import { WorkspaceRepository } from "../core/workspace/WorkspaceRepository.js";
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
import { HttpExecutor, getExecutionState } from "../core/engine/HttpExecutor.js";
import { WorkspaceExecution } from "../core/engine/WorkspaceExecution.js";
import { P2Api } from "./P2Api.js";
import type { CredentialProvider } from "../core/security/CredentialStore.js";
import { SecretRedactor } from "../core/security/SecretRedactor.js";
import { secretReferencePattern } from "../core/security/CredentialStore.js";
import { sanitizeExample } from "../core/workspace/WorkbenchState.js";
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
export class StudioServer extends WorkspaceRepository {
  private server: http.Server | null = null;
  private port: number;
  private p2Context?: WorkspaceExecution;
  private p2Api?: P2Api;
  private executions = new Set<AbortController>();
  private runs = new Map<string, RunJob>();
  private knownSecrets = new SecretRedactor();
  private sniffer: TrafficSnifferProxy;
  private lifecycle:
    "created" | "starting" | "running" | "stopping" | "stopped" = "created";
  private startPromise: Promise<number>;
  private listeningPromise: Promise<number>;
  private stopPromise: Promise<void>;

  constructor(
    port: number = 4040,
    snifferPort: number = 8085,
    workspaceDir: string = storageDir,
    private p2Options: { credentialProvider?: CredentialProvider; allowInsecureOAuthForTests?: boolean } = {},
  ) {
    super(workspaceDir);
    this.port = port;
    this.sniffer = new TrafficSnifferProxy(snifferPort, { knownSecrets: this.knownSecrets });
  }

  private p2() {
    if (!this.p2Api) {
      const baseUrl = `http://127.0.0.1:${this.port}`;
      this.p2Context = new WorkspaceExecution(this.storageDir, { knownSecrets: this.knownSecrets, serverOwned: true, callbackUrl: baseUrl + '/api/oauth/callback', credentialProvider: this.p2Options.credentialProvider, allowInsecureLoopbackForTests: this.p2Options.allowInsecureOAuthForTests });
      this.p2Api = new P2Api(this.p2Context, baseUrl, {
        assertOwned: () => this.assertWorkspaceDirectories(),
        snapshot: () => this.snapshot(),
        commit: (kind, value, revision) => { if (kind === 'collections') this.persistCollection(value.id, value, revision); else this.persistEnvironment(value.id, value, revision); },
      });
    }
    return this.p2Api;
  }

  private checkExecutionRevisions(body: any) {
    for (const [label, revision, current] of [
      [
        "Collection",
        body.collectionRevision,
        this.collections.get(body.collectionId)?.revision,
      ],
      [
        "Environment",
        body.environmentRevision,
        this.environments.get(body.environmentId)?.revision,
      ],
    ])
      if (revision && revision !== current)
        throw Object.assign(
          new Error(
            `${label} changed before execution. Review its current settings before sending or running.`,
          ),
          { statusCode: 412, code: "ERR_WORKSPACE_CONFLICT" },
        );
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

  public start(): Promise<number> {
    if (this.lifecycle === "starting" || this.lifecycle === "running")
      return this.startPromise;
    if (this.lifecycle !== "created")
      return Promise.reject(
        Object.assign(
          new Error(
            "This Studio has stopped. Create a new instance to reopen it.",
          ),
          { code: "ERR_STUDIO_STOPPED" },
        ),
      );
    this.lifecycle = "starting";
    this.listeningPromise = this.startListening();
    this.startPromise = this.listeningPromise
      .then((port) => {
        this.assertStarting();
        this.lifecycle = "running";
        return port;
      })
      .catch(async (error) => {
        await this.stop();
        throw error;
      });
    return this.startPromise;
  }

  private assertStarting() {
    if (this.lifecycle !== "starting")
      throw Object.assign(
        new Error("Studio startup was cancelled by shutdown."),
        { code: "ERR_STUDIO_STOPPED" },
      );
    this.lease?.assertOwned();
  }

  private async startListening(): Promise<number> {
    this.assertStarting();
    await this.sniffer.start();
    this.assertStarting();

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
          // Provider redirects are top-level GET navigations. Only this fixed
          // callback bypasses the fetch-site restriction; OAuthService still
          // verifies its owned callback URL and consumes an unguessable state.
          const oauthNavigation = req.method === 'GET' &&
            new URL(req.url || '/', `http://${allowedHosts[1]}`).pathname === '/api/oauth/callback' &&
            req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' && !origin;
          if (
            !allowedHosts.includes(host) ||
            (req.headers["sec-fetch-site"] && !oauthNavigation &&
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
        if (this.lifecycle !== "starting") {
          reject(err);
          return;
        }
        if (err.code === "EADDRINUSE" && this.port < 65535) {
          this.port += 1;
          try {
            this.server?.listen(this.port, "127.0.0.1");
          } catch (error) {
            reject(error);
          }
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
      /^\/api\/(workspace|collections|environments)(\/|$)/.test(pathname) ||
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

    if (/^\/api\/(credentials|oauth|files|responses|cookies|validate\/json)(\/|$)/.test(pathname) && await this.p2().handle(req, res, urlObj, readBody)) return;

    if (pathname === "/api/workspace/move" && req.method === "POST") {
      sendJson(this.moveItem(await readBody()));
      return;
    }

    if (pathname === "/api/workspace/identity" && req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");
      sendJson({ id: this.revision(JSON.stringify([this.storageDir, this.directoryIdentities.get(this.storageDir)])) });
      return;
    }

    if (pathname === "/api/workspace" && req.method === "GET") {
      const snapshot = this.refreshWorkspaceSnapshot();
      const tag = `"${snapshot.revision}"`;
      res.setHeader("ETag", tag);
      res.setHeader("Cache-Control", "no-store");
      if (req.headers["if-none-match"] === tag) {
        res.writeHead(304);
        res.end();
      } else sendJson(snapshot);
      return;
    }

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
    if (["/api/execute", "/api/execute/stream"].includes(pathname) && req.method === "POST") {
      const streaming = pathname.endsWith('/stream');
      const body = await readBody();
      this.refreshWorkspaceSnapshot();
      this.checkExecutionRevisions(body);
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
      let executionOptions;
      const emit = async (event: any) => {
        if (controller.signal.aborted || res.destroyed) throw new Error('Execution stream closed');
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        if (!res.write(JSON.stringify(event) + '\n')) {
          await new Promise<void>((resolve, reject) => {
            const done = () => { res.off('drain', drained); controller.signal.removeEventListener('abort', aborted); };
            const drained = () => { done(); resolve(); }, aborted = () => { done(); reject(new Error('Execution stream cancelled')); };
            res.once('drain', drained); controller.signal.addEventListener('abort', aborted, { once: true });
            if (controller.signal.aborted) aborted();
          });
        }
      };
      try {
        executionOptions = await this.p2().executionOptions(streaming);
        let lastProgress = 0;
        response = await HttpExecutor.execute(
          httpRequest,
          collectionVars,
          envVars,
          { ...executionOptions, signal: controller.signal,
            ...(streaming ? {
              onResponseHeaders: (headers) => emit({ type: 'headers', ...headers }),
              onProgress: async (progress) => { if (Date.now() - lastProgress >= 100 || (progress.total !== undefined && progress.bytes === progress.total)) { lastProgress = Date.now(); await emit({ type: 'progress', ...progress }); } },
            } : {}),
          },
        );
        try { await this.p2().saveCookies(); } catch { response.cookieWarning = 'Response completed, but cookies could not be saved securely. Session cookies remain available; review persistence before relying on restart recovery.'; }
        response.example = sanitizeExample(httpRequest, response, [...envVars, ...collectionVars], executionOptions.secrets);
      } catch (error) {
        res.off('close', onClose); this.executions.delete(controller); throw error;
      }
      if (res.destroyed) { this.executions.delete(controller); res.off('close', onClose); return; }

      let environmentChanges = getExecutionState(response)?.environment;
      if (environmentChanges && executionOptions.secrets && Object.entries(environmentChanges).some(([key, value]) => executionOptions.secrets.text(key) !== key || (initialEnvironment[key] !== value && !secretReferencePattern.test(String(value)) && executionOptions.secrets.text(String(value)) !== String(value)))) {
        environmentChanges = undefined;
        response.persistence = { environment: { status: 'failed', code: 'ERR_SECRET_PERSISTENCE', message: 'Secret-bearing script changes were not written to workspace files. Store a credential reference explicitly.' } };
      }

      // Auto-sync script mutations back to active environment file on disk
      if (
        envId &&
        environmentSnapshot &&
        environmentChanges &&
        [
          ...new Set([
            ...Object.keys(initialEnvironment),
            ...Object.keys(environmentChanges),
          ]),
        ].some(
          (key) => initialEnvironment[key] !== environmentChanges[key],
        )
      ) {
        const env = structuredClone(environmentSnapshot);
        const original = new Map(env.values.map((value) => [value.key, value]));
        env.values = [
          ...env.values.filter(
            (v) =>
              v.enabled === false &&
              !Object.hasOwn(environmentChanges, v.key),
          ),
          ...Object.entries(environmentChanges).map(
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

      for (const field of ['updatedVariables', 'updatedEnvironment', 'updatedLocalVariables', 'updatedCollectionVariables', 'updatedGlobals']) if (response[field] && executionOptions.secrets)
        response[field] = Object.fromEntries(Object.entries(response[field]).map(([key, value]) => [key, secretReferencePattern.test(String(value)) ? value : executionOptions.secrets.text(String(value))]));
      try { if (streaming) {
        if (Buffer.byteLength(JSON.stringify(response)) > 1800 * 1024) {
          response.example = undefined;
          for (const field of ['logs', 'testResults', 'updatedVariables', 'updatedEnvironment', 'updatedLocalVariables', 'updatedCollectionVariables', 'updatedGlobals']) response[field] = undefined;
          response.diagnosticWarning = 'Diagnostic retention limit reached. Full response bytes remain available through Download.';
        }
        await emit({ type: 'complete', response }); res.end();
      } else sendJson(response); }
      finally { res.off('close', onClose); this.executions.delete(controller); }
      return;
    }

    if (pathname === "/api/runs" && req.method === "POST") {
      const body = await readBody();
      this.refreshWorkspaceSnapshot();
      this.checkExecutionRevisions(body);
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
      const runExecutionOptions = await this.p2().executionOptions();
      if (this.lifecycle !== "running") throw new Error("Studio is stopping");
      if (this.activeWorkCount() >= 2) { sendJson({ error: 'Two executions or runs are already active' }, 429); return; }
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
        executionOptions: runExecutionOptions,
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
        .then(async (result) => {
          job.result = reportWithoutBodies(result);
          try { await this.p2().saveCookies(); }
          catch { (job.result as any).cookieWarning = 'Run completed, but cookies could not be saved securely. Session cookies remain available.'; }
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
        const includeSecrets = urlObj.searchParams.get('includeSecrets') === 'true';
        const postmanJson = PostmanConverter.toPostman(this.p2().exportResource(collection, includeSecrets, urlObj.searchParams.get('consent') === 'plaintext'));
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

  public stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.lifecycle = "stopping";
    for (const run of this.runs.values()) run.controller.abort();
    for (const execution of this.executions) execution.abort();
    this.stopPromise = (async () => {
      // Wait for the raw listener attempt, never the startup wrapper that awaits stop.
      await this.listeningPromise?.catch(() => {});
      await this.sniffer.stop();
      if (this.server)
        await new Promise<void>((resolve) => {
          this.server?.close(() => resolve());
          this.server?.closeAllConnections();
        });
      await this.p2Api?.idle();
      await this.p2Context?.close();
      this.lease?.release();
      this.lifecycle = "stopped";
    })();
    return this.stopPromise;
  }
}
