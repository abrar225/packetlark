import http from "node:http";
import { sanitizeCapture } from "./CaptureSanitizer.js";
import { SniffedTrafficItem, HttpMethod } from "../models/types.js";
import {
  BodyBudgetError,
  readIncomingBody,
  readResponseBody,
} from "../engine/BodyBudget.js";
export type TrafficListener = (item: SniffedTrafficItem) => void;
export type CaptureOptions = Partial<CaptureLimits> & {
  sensitiveFields?: string[];
};
export interface CaptureLimits {
  maxConnections: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
  maxConcurrentRequests: number;
  maxHistoryBytes: number;
  maxRecordBytes: number;
}
const defaults: CaptureLimits = {
  maxConnections: 32,
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 10 * 1024 * 1024,
  timeoutMs: 30000,
  maxConcurrentRequests: 8,
  maxHistoryBytes: 32 * 1024 * 1024,
  maxRecordBytes: 1024 * 1024,
};
const hopByHop = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
];
function forwardedHeaders(
  entries: Iterable<[string, string]>,
  connection: string,
  decoded = false,
): Headers {
  const blocked = new Set([
    ...hopByHop,
    ...connection.split(",").map((v) => v.trim().toLowerCase()),
    "x-target-url",
    ...(decoded ? ["content-encoding"] : []),
  ]);
  const result = new Headers();
  for (const [key, value] of entries)
    if (!blocked.has(key.toLowerCase())) result.append(key, value);
  return result;
}
function inspect(bytes: Buffer, mime: string): unknown {
  if (!bytes.length) return undefined;
  if (mime && !/text|json|xml|javascript|urlencoded/i.test(mime))
    return `[Binary Data: ${bytes.length} bytes]`;
  const value = bytes.toString("utf8");
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
export class TrafficSnifferProxy {
  private server: http.Server | null = null;
  private port: number;
  private isCapturing = false;
  private capturedItems: SniffedTrafficItem[] = [];
  private recordSizes: number[] = [];
  private retainedBytes = 0;
  private omittedRecords = 0;
  private listeners = new Set<TrafficListener>();
  private active = new Set<AbortController>();
  private starting: Promise<number> | null = null;
  private closing: Promise<void> | null = null;
  private readonly limits: CaptureLimits;
  private readonly sensitiveFields: string[];
  constructor(port = 8085, options: CaptureOptions = {}) {
    const { sensitiveFields = [], ...limits } = options;
    if (
      !Array.isArray(sensitiveFields) ||
      sensitiveFields.length > 100 ||
      sensitiveFields.some((key) => typeof key !== "string" || key.length > 128)
    )
      throw new Error("Invalid sensitive field configuration");
    this.sensitiveFields = [...sensitiveFields];
    this.port = port;
    this.limits = { ...defaults, ...limits };
    for (const [key, value] of Object.entries(this.limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`Invalid capture limit ${key}`);
  }
  public getPort() {
    return this.port;
  }
  public isRunning() {
    return this.isCapturing;
  }
  public getCapturedItems() {
    return structuredClone(this.capturedItems);
  }
  public clearCapturedItems() {
    this.capturedItems = [];
    this.recordSizes = [];
    this.retainedBytes = 0;
    this.omittedRecords = 0;
  }
  public getCaptureStats() {
    return {
      retainedRecords: this.capturedItems.length,
      retainedBytes: this.retainedBytes,
      omittedRecords: this.omittedRecords,
      activeRequests: this.active.size,
      limits: { ...this.limits },
      redactionVersion: 1,
    };
  }
  public recordTraffic(item: SniffedTrafficItem) {
    let safe: SniffedTrafficItem;
    try {
      safe = sanitizeCapture(item, this.sensitiveFields);
    } catch {
      this.omittedRecords++;
      return;
    }
    let size = Buffer.byteLength(JSON.stringify(safe));
    if (size > this.limits.maxRecordBytes) {
      delete safe.requestBody;
      delete safe.responseBody;
      safe.redaction.bodyOmitted = true;
      size = Buffer.byteLength(JSON.stringify(safe));
    }
    if (
      size > Math.min(this.limits.maxRecordBytes, this.limits.maxHistoryBytes)
    ) {
      this.omittedRecords++;
      return;
    }
    while (
      this.capturedItems.length &&
      (this.capturedItems.length >= 500 ||
        this.retainedBytes + size > this.limits.maxHistoryBytes)
    ) {
      this.capturedItems.shift();
      this.retainedBytes -= this.recordSizes.shift();
    }
    this.capturedItems.push(safe);
    this.recordSizes.push(size);
    this.retainedBytes += size;
    for (const listener of this.listeners)
      try {
        listener(structuredClone(safe));
      } catch {}
  }
  public subscribe(listener: TrafficListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    req.on("error", () => {});
    res.on("error", () => {});
    const fail = (status: number, code: string, message: string) => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.shouldKeepAlive = false;
      res.writeHead(status, {
        "Content-Type": "application/json",
        Connection: "close",
      });
      res.end(JSON.stringify({ error: { code, message } }));
      res.once("finish", () => {
        if (!req.complete) req.destroy();
      });
    };
    let absolute = false,
      target: URL;
    try {
      const parsed = new URL(req.url || "");
      absolute =
        ["http:", "https:"].includes(parsed.protocol) &&
        req.headers.host === parsed.host;
    } catch {}
    if (
      (![`localhost:${this.port}`, `127.0.0.1:${this.port}`].includes(
        req.headers.host || "",
      ) &&
        !absolute) ||
      req.headers.origin
    ) {
      fail(403, "ERR_ORIGIN", "Use the local proxy from a trusted HTTP client");
      return;
    }
    const targetText =
      req.headers["x-target-url"] ||
      req.url?.replace(/^\/(?=https?:\/\/)/i, "");
    try {
      if (typeof targetText !== "string") throw new Error();
      target = new URL(targetText);
      if (
        !["http:", "https:"].includes(target.protocol) ||
        target.username ||
        target.password
      )
        throw new Error();
    } catch {
      fail(
        400,
        "ERR_TARGET",
        "Specify an HTTP(S) target without embedded credentials",
      );
      return;
    }
    if (
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        req.method || "GET",
      )
    ) {
      fail(405, "ERR_METHOD", "Unsupported proxy method");
      return;
    }
    if (this.active.size >= this.limits.maxConcurrentRequests) {
      fail(503, "ERR_CONCURRENCY", "Capture concurrency limit reached");
      return;
    }
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(
      () =>
        controller.abort(
          new BodyBudgetError("Capture request timed out", "ERR_TIMEOUT", 504),
        ),
      this.limits.timeoutMs,
    );
    const disconnect = () => {
      if (!res.writableFinished)
        controller.abort(
          new BodyBudgetError("Client disconnected", "ERR_ABORTED", 499),
        );
    };
    res.once("close", disconnect);
    const start = performance.now();
    try {
      const requestBytes = await readIncomingBody(
        req,
        this.limits.maxRequestBytes,
        controller.signal,
      );
      if (["GET", "HEAD"].includes(req.method || "GET") && requestBytes.length)
        throw new BodyBudgetError(
          "GET/HEAD bodies are unsupported",
          "ERR_BODY",
          400,
        );
      const requestEntries: Array<[string, string]> = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        requestEntries.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      const headers = forwardedHeaders(
        requestEntries,
        String(req.headers.connection || ""),
      );
      const upstream = await fetch(target.href, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method || "GET")
          ? undefined
          : new Uint8Array(requestBytes),
        signal: controller.signal,
        redirect: "manual",
      });
      const responseBytes = await readResponseBody(
        upstream,
        this.limits.maxResponseBytes,
        controller.signal,
      );
      const responseHeaders = forwardedHeaders(
        upstream.headers,
        upstream.headers.get("connection") || "",
        req.method !== "HEAD",
      );
      const length = upstream.headers.get("content-length");
      if (req.method === "HEAD" && length && /^\d+$/.test(length))
        responseHeaders.set("content-length", length);
      const outgoing: Record<string, string | string[]> =
        Object.fromEntries(responseHeaders);
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length) outgoing["set-cookie"] = cookies;
      res.writeHead(upstream.status, outgoing);
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          res.off("finish", finish);
          res.off("close", close);
          res.off("error", error);
          controller.signal.removeEventListener("abort", abort);
        };
        const finish = () => {
          cleanup();
          resolve();
        };
        const close = () => {
          cleanup();
          reject(
            new BodyBudgetError("Client disconnected", "ERR_ABORTED", 499),
          );
        };
        const error = (e: Error) => {
          cleanup();
          reject(e);
        };
        const abort = () => {
          cleanup();
          res.destroy();
          reject(controller.signal.reason);
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) {
          abort();
          return;
        }
        res.once("finish", finish);
        res.once("close", close);
        res.once("error", error);
        res.end(responseBytes);
      });
      if (this.isCapturing)
        this.recordTraffic({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          method: (req.method || "GET") as HttpMethod,
          url: target.href,
          pathname: target.pathname,
          queryParams: Object.fromEntries(target.searchParams),
          requestHeaders: Object.fromEntries(headers),
          requestBody:
            requestBytes.length > this.limits.maxRecordBytes / 2
              ? "[Omitted: inspection byte limit]"
              : inspect(requestBytes, headers.get("content-type") || ""),
          responseStatus: upstream.status,
          responseHeaders: Object.fromEntries(responseHeaders),
          responseBody:
            responseBytes.length > this.limits.maxRecordBytes / 2
              ? "[Omitted: inspection byte limit]"
              : inspect(
                  responseBytes,
                  upstream.headers.get("content-type") || "",
                ),
          durationMs: Math.round(performance.now() - start),
        });
    } catch (error) {
      const reason = controller.signal.aborted
        ? controller.signal.reason
        : error;
      fail(
        reason?.statusCode || 502,
        reason?.code === "ERR_TIMEOUT"
          ? "ERR_TIMEOUT"
          : reason instanceof BodyBudgetError
            ? reason.code
            : "ERR_UPSTREAM",
        reason instanceof BodyBudgetError
          ? reason.message
          : "Upstream request failed",
      );
    } finally {
      clearTimeout(timer);
      res.off("close", disconnect);
      this.active.delete(controller);
    }
  }
  public start(): Promise<number> {
    if (this.closing) return this.closing.then(() => this.start());
    if (this.starting) return this.starting;
    if (this.server?.listening) return Promise.resolve(this.port);
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer(
        { connectionsCheckingInterval: Math.min(1000, this.limits.timeoutMs) },
        (req, res) => {
          void this.handle(req, res);
        },
      );
      this.server = server;
      server.maxConnections = this.limits.maxConnections;
      server.requestTimeout = this.limits.timeoutMs;
      server.headersTimeout = this.limits.timeoutMs;
      server.setTimeout(this.limits.timeoutMs + 1000, (socket) =>
        socket.destroy(),
      );
      server.on("connect", (_req, socket) =>
        socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n"),
      );
      server.on("upgrade", (_req, socket) =>
        socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n"),
      );
      server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && this.port < 65535) {
          this.port++;
          server.listen(this.port, "127.0.0.1");
        } else {
          this.server = null;
          reject(error);
        }
      });
      server.listen(this.port, "127.0.0.1", () => {
        this.port = (server.address() as { port: number }).port;
        this.isCapturing = true;
        resolve(this.port);
      });
    });
    this.starting = this.starting.finally(() => (this.starting = null));
    return this.starting;
  }
  public stop(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.starting)
      return this.starting.then(
        () => this.stop(),
        () => {},
      );
    this.isCapturing = false;
    for (const active of this.active)
      active.abort(new BodyBudgetError("Capture stopped", "ERR_STOPPED", 503));
    const server = this.server;
    if (!server) return Promise.resolve();
    this.server = null;
    this.closing = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }).finally(() => (this.closing = null));
    return this.closing;
  }
}
