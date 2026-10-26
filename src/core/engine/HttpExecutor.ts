import { OrderedHeaders, sendHttp, type Progress, type TransportResponse } from "./HttpTransport.js";
import type { SelectedFile } from "./SelectedFileStore.js";
import type { ResponseArtifactStore } from "./ResponseArtifactStore.js";
import { randomUUID } from "node:crypto";
import { BodyBudgetError } from "./BodyBudget.js";
import { SecretRedactor } from "../security/SecretRedactor.js";
import {
  HttpRequest,
  HttpResponse,
  TimingMetrics,
  KeyValueParam,
  ApiErrorDetail,
} from "../models/types.js";
import { VariableResolver } from "./VariableResolver.js";
import {
  ScriptSandbox,
  SandboxOptions,
  ResponseContext,
} from "./ScriptSandbox.js";
import { CookieJar } from "tough-cookie";

export function normalizeNetworkError(
  err: any,
  targetUrl?: string,
): ApiErrorDetail {
  const errCode = err?.code || (err?.cause as any)?.code || "";
  const errMsg = String(err?.message || err || "");
  const errName = err?.name || "";

  if (errCode === "ERR_ABORTED")
    return {
      category: "Request Cancelled",
      message: "Request cancelled",
      guidance: "Send the request again when ready.",
      code: "ERR_ABORTED",
    };
  // 1. DNS Resolution Failed
  if (errCode === "ENOTFOUND" || errMsg.includes("getaddrinfo ENOTFOUND")) {
    let hostname = "target";
    try {
      if (targetUrl) hostname = new URL(targetUrl).hostname;
    } catch {}
    return {
      category: "DNS Resolution Failed",
      message: `Cannot resolve host '${hostname}'`,
      guidance: "Verify hostname spelling and active internet connection.",
      code: "ENOTFOUND",
    };
  }

  // 2. Connection Refused
  if (errCode === "ECONNREFUSED" || errMsg.includes("ECONNREFUSED")) {
    let port = "";
    try {
      if (targetUrl)
        port =
          new URL(targetUrl).port ||
          (new URL(targetUrl).protocol === "https:" ? "443" : "80");
    } catch {}
    return {
      category: "Connection Refused",
      message: `Target server refused connection${port ? ` on port ${port}` : ""}`,
      guidance:
        "Verify target server is running and listening on the specified port.",
      code: "ECONNREFUSED",
    };
  }

  // 3. Timeout
  if (
    errCode === "ETIMEDOUT" ||
    errCode === "UND_ERR_CONNECT_TIMEOUT" ||
    (err?.cause as any)?.code === "UND_ERR_CONNECT_TIMEOUT" ||
    errName === "TimeoutError" ||
    errCode === "ABORT_ERR" ||
    errMsg.includes("timeout") ||
    errMsg.includes("timed out") ||
    errMsg.includes("CONNECT_TIMEOUT")
  ) {
    return {
      category: "Request Timeout",
      message: "Connection or request exceeded timeout limit",
      guidance:
        "Target server took too long to respond. Check server load, network latency, or increase timeout.",
      code: "ETIMEDOUT",
    };
  }

  // 4. SSL Expired
  if (errCode === "CERT_HAS_EXPIRED" || errMsg.includes("CERT_HAS_EXPIRED")) {
    return {
      category: "SSL Certificate Expired",
      message: "Remote TLS/SSL certificate has expired",
      guidance:
        "Upstream TLS certificate is invalid. Renew the server certificate or provide an approved CA certificate.",
      code: "CERT_HAS_EXPIRED",
    };
  }

  // 5. Self-Signed SSL
  if (
    errCode === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    errMsg.includes("DEPTH_ZERO_SELF_SIGNED_CERT") ||
    errMsg.includes("self-signed")
  ) {
    return {
      category: "Self-Signed SSL Certificate",
      message: "Self-signed SSL certificate rejected",
      guidance:
        "Common in local development. Configure SSL verification options.",
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    };
  }

  // 6. Invalid URL
  if (
    errCode === "ERR_INVALID_URL" ||
    (errName === "TypeError" && errMsg.includes("Invalid URL"))
  ) {
    return {
      category: "Invalid Request URL",
      message: `URL '${targetUrl || ""}' is malformed or invalid`,
      guidance:
        "Ensure URL starts with http:// or https:// and has a valid hostname.",
      code: "ERR_INVALID_URL",
    };
  }

  // 7. General Network Error fallback without stack trace leakage
  return {
    category: "Network Error",
    message:
      errMsg.replace(/^Error:\s*/, "") || "Failed to execute HTTP request",
    guidance:
      "Check target endpoint, network connectivity, and proxy settings.",
    code: errCode || "FETCH_ERROR",
  };
}

export interface ExecutionOptions {
  secrets?: SecretRedactor;
  resolveCredential?: (ref: string, origin: string) => Promise<string>;
  resolveOAuth?: (connectionId: string, origin: string) => Promise<string>;
  resolveFile?: (fileId: string) => Promise<SelectedFile>;
  artifactStore?: ResponseArtifactStore;
  previewBytes?: number;
  validateJsonBody?: (raw:string,schema:Record<string,unknown>|undefined,signal:AbortSignal)=>Promise<void>;
  onResponseHeaders?: (value: {status:number;statusText:string;headers:Record<string,string>;headerEntries:Array<[string,string]>}) => void | Promise<void>;
  onResponseChunk?: (chunk: Buffer) => void | Promise<void>;
  onProgress?: (progress: Progress) => void | Promise<void>;
  signal?: AbortSignal;
  forbiddenOrigins?: string[];
  cookieJar?: CookieJar;
  globals?: Record<string, string>;
  localVariables?: Record<string, string>;
  iterationData?: Record<string, string>;
  info?: Record<string, any>;
}
export interface ExecutionState {
  environment: Record<string, string>;
  collection: Record<string, string>;
  globals: Record<string, string>;
  local: Record<string, string>;
  variables: Record<string, string>;
  nextRequest?: string | null;
  skipRequest?: boolean;
}
const executionStates = new WeakMap<HttpResponse, ExecutionState>();
/** Trusted execution consumers only. This detached state is never a property of serialized responses. */
export function getExecutionState(response: HttpResponse): ExecutionState | undefined {
  const state = executionStates.get(response); return state ? structuredClone(state) : undefined;
}
const valueMap = (values: KeyValueParam[]) =>
  Object.fromEntries(
    values
      .filter((v) => v.enabled !== false)
      .map((v) => [v.key, String(v.value ?? "")]),
  );
export class HttpExecutor {
  static async execute(
    request: HttpRequest,
    collectionVars: KeyValueParam[] = [],
    envVars: KeyValueParam[] = [],
    options: ExecutionOptions = {},
  ): Promise<HttpResponse> {
    options = {...options,secrets:options.secrets ?? new SecretRedactor()};
    const start = performance.now();
    let transportAttempted = false;
    options.secrets?.observeParameters(envVars);
    options.secrets?.observeParameters(collectionVars);
    options.secrets?.observeParameters(request.body?.formData);
    for (const scope of [
      options.iterationData,
      options.globals,
      options.localVariables,
    ])
      for (const [key, value] of Object.entries(scope || {}))
        options.secrets?.observe(key, value);
    let environment = valueMap(envVars),
      collection = valueMap(collectionVars),
      globals = { ...options.globals },
      local = { ...options.localVariables };
    const allLogs: string[] = [],
      testResults: any[] = [];
    let nextRequest: string | null | undefined,
      skipRequest = false;
    const context = () => ({
      ...globals,
      ...collection,
      ...environment,
      ...options.iterationData,
      ...local,
    });
    const rememberResponse = (response: HttpResponse): HttpResponse => {
      executionStates.set(response, structuredClone({ environment, collection, globals, local, variables: context(), nextRequest, skipRequest }));
      return response;
    };
    const diagnosticValue = <T>(value: T): T => {
      let visited = 0;
      const visit = (current: any, depth = 0): any => {
        if (++visited > 10000 || depth > 24) return "[Details withheld: diagnostic budget exceeded]";
        if (typeof current === "string") return current.split(/(\{\{secret:[0-9a-f-]{36}\}\})/g).map(part => /^\{\{secret:[0-9a-f-]{36}\}\}$/.test(part) ? part : options.secrets.text(part)).join("");
        if (Array.isArray(current)) return current.map(child => visit(child, depth + 1));
        if (current && typeof current === "object") return Object.fromEntries(Object.entries(current).map(([key, child]) => [options.secrets.text(key), visit(child, depth + 1)]));
        if (current !== undefined && current !== null && options.secrets.text(String(current)) !== String(current)) return "[REDACTED]";
        return current;
      };
      return visit(value);
    };
    const diagnosticText = (value: string) => {
      try { return JSON.stringify(diagnosticValue(JSON.parse(value))); }
      catch { return options.secrets.text(value); }
    };
    const updates = () => ({
      updatedVariables: diagnosticValue(context()),
      updatedEnvironment: diagnosticValue(environment),
      updatedCollectionVariables: diagnosticValue(collection),
      updatedGlobals: diagnosticValue(globals),
      updatedLocalVariables: diagnosticValue(local),
      nextRequest: diagnosticValue(nextRequest),
      skipRequest,
    });
    const failed = (
      category: string,
      message: string,
      code: string,
    ): HttpResponse => rememberResponse({
      status: 0,
      statusText: category,
      headers: {},
      body: JSON.stringify({ error: options.secrets.text(message) }),
      sizeBytes: 0,
      transportAttempted,
      timings: {
        firstByteMs: 0,
        totalMs: Math.round(performance.now() - start),
      },
      error: {
        category,
        message: options.secrets.text(message),
        guidance:
          "Review the request settings, scripts, and supported feature documentation.",
        code,
      },
      testResults: diagnosticValue(testResults),
      logs: allLogs.map(diagnosticText),
      ...updates(),
    });
    const timeout = request.timeoutMs ?? 30000;
    const maxBytes = request.maxResponseBytes ?? 10 * 1024 * 1024;
    const maxRequestBytes = request.maxRequestBytes ?? 4 * 1024 * 1024;
    if (
      !Number.isSafeInteger(maxRequestBytes) ||
      maxRequestBytes < 1 ||
      maxRequestBytes > 50 * 1024 * 1024
    )
      return failed(
        "Invalid Settings",
        "Request limit must be between 1 byte and 50 MiB",
        "ERR_SETTINGS",
      );
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000)
      return failed(
        "Invalid Settings",
        "Timeout must be 1–300000 ms",
        "ERR_SETTINGS",
      );
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 50 * 1024 * 1024
    )
      return failed(
        "Invalid Settings",
        "Response limit must be between 1 byte and 50 MiB",
        "ERR_SETTINGS",
      );
    if (
      !["none", "bearer", "basic", "apikey", "oauth2"].includes(request.auth?.type ?? "none") ||
      !["none", "binary", "raw-json", "raw-text", "form-data", "x-www-form-urlencoded"].includes(request.body?.mode ?? "none") ||
      (request.auth?.type === "apikey" && request.auth.apiKeyIn !== undefined && !["header", "query"].includes(request.auth.apiKeyIn))
    )
      return failed(
        "Unsupported Feature",
        "Resolve inherited authentication through a collection, or choose a supported auth/body mode. Imported unsupported data remains preserved for export.",
        "ERR_UNSUPPORTED",
      );
    const deadline = start + timeout;
    const timeoutSignal = AbortSignal.timeout(
      Math.max(1, Math.ceil(deadline - performance.now())),
    );
    const signal = options.signal
      ? AbortSignal.any([timeoutSignal, options.signal])
      : timeoutSignal;
    const abortable = async <T>(work:Promise<T>|T):Promise<T> => {
      signal.throwIfAborted();
      return await new Promise<T>((resolve,reject)=>{
        const abort=()=>reject(signal.reason);
        signal.addEventListener("abort",abort,{once:true});
        Promise.resolve(work).then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
      });
    };
    let scriptBudgetExceeded = false;
    const budgetFailure = () => {
      if (options.signal?.aborted)
        return failed(
          "Request Cancelled",
          "Execution cancelled. A previously attempted request may have completed; review before retrying.",
          "ERR_ABORTED",
        );
      if (
        scriptBudgetExceeded ||
        timeoutSignal.aborted ||
        performance.now() >= deadline
      )
        return failed(
          "Request Timeout",
          "Overall execution deadline exceeded. A previously attempted request may have completed; review before retrying.",
          "ETIMEDOUT",
        );
    };
    const jar = options.cookieJar ?? new CookieJar();
    const scripts = async (codes: string[], response?: ResponseContext) => {
      for (const code of codes.filter(Boolean)) {
        if (budgetFailure()) return false;
        const remaining = deadline - performance.now();
        const result = await ScriptSandbox.executeAsync(
          code,
          context(),
          response,
          {
            environment,
            collection,
            globals,
            local,
            data: options.iterationData,
            info: {
              ...options.info,
              eventName: response ? "test" : "prerequest",
            },
            request,
            signal,
            timeoutMs: Math.max(1, Math.ceil(Math.min(2000, remaining))),
            onSecret: options.secrets
              ? (key, value) => options.secrets.observe(key, value)
              : undefined,
            sendRequest: async (desc, signal) => {
              const configured =
                typeof desc === "string" ? { url: desc } : desc;
              if (!configured || typeof configured.url !== "string")
                throw new Error("pm.sendRequest requires a URL");
              const headers = Array.isArray(configured.header)
                ? configured.header
                : Object.entries(
                    configured.header || configured.headers || {},
                  ).map(([key, value]) => ({
                    key,
                    value: String(value),
                    enabled: true,
                  }));
              const child: HttpRequest = {
                method: (configured.method || "GET").toUpperCase(),
                url: VariableResolver.resolve(configured.url, context()),
                headers,
                queryParams: [],
                body:
                  configured.body?.raw !== undefined
                    ? { mode: "raw-text", raw: configured.body.raw }
                    : { mode: "none" },
                auth: { type: "none" },
                timeoutMs: Math.min(timeout, 2000),
                maxResponseBytes: 1024 * 1024,
              };
              const response = await this.execute(child, [], [], {
                ...options,
                artifactStore: undefined,
                onResponseHeaders: undefined,
                onResponseChunk: undefined,
                onProgress: undefined,
                signal,
                cookieJar: jar,
                secrets: options.secrets,
              });
              if (response.error) throw new Error(response.error.message);
              return {
                code: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
                responseTimeMs: response.timings.totalMs,
              };
            },
          },
        );
        if (result.budgetExceeded && remaining <= 2000)
          scriptBudgetExceeded = true;
        environment = result.updatedEnvironment;
        collection = result.updatedCollectionVariables;
        globals = result.updatedGlobals;
        local = result.updatedLocalVariables;
        testResults.push(...result.testResults);
        allLogs.push(...result.logs);
        if (result.nextRequest !== undefined) nextRequest = result.nextRequest;
        if (result.skipRequest) skipRequest = true;
        if (!response && result.testResults.some((t) => !t.passed))
          return false;
      }
      return true;
    };
    const prePassed = await scripts([
      ...(request.preRequestScripts || []),
      request.preRequestScript,
    ]);
    const preBudgetFailure = budgetFailure();
    if (preBudgetFailure) return preBudgetFailure;
    if (!prePassed)
      return failed(
        "Pre-request Script Failed",
        "A pre-request script failed. The request was not sent.",
        "ERR_PREREQUEST",
      );
    if (skipRequest)
      return rememberResponse({
        status: 0,
        statusText: "Skipped",
        headers: {},
        body: "",
        sizeBytes: 0,
        timings: { firstByteMs: 0, totalMs: 0 },
        testResults: diagnosticValue(testResults),
        logs: allLogs.map(diagnosticText),
        ...updates(),
      });
    if (!request.url?.trim())
      return failed(
        "Invalid Request URL",
        "Request URL cannot be empty",
        "ERR_EMPTY_URL",
      );
    const resolve = (text: string, budget = maxRequestBytes) =>
      VariableResolver.resolve(text, context(), budget);
    let url: URL;
    let bodyHasCredentials=false;
    const credential = async (text:string,budget=64*1024) => {
      let value=resolve(text,budget);
      for (const match of [...value.matchAll(/\{\{secret:([^{}]+)\}\}/g)]) {
        if (!options.resolveCredential) throw new Error("Credential resolver unavailable");
        const secret=await abortable(options.resolveCredential(match[1],url.origin));
        options.secrets.add(secret);
        options.secrets.add(JSON.stringify(secret).slice(1,-1));
        value=value.replace(match[0],()=>secret);
        if(Buffer.byteLength(value)>budget)throw new BodyBudgetError("Credential expansion exceeds limit","ERR_REQUEST_LIMIT",413);
      }
      return value;
    };
    const name = (text:string,budget=8192) => {
      const value=resolve(text,budget);
      if (/\{\{secret:/i.test(value)) throw new Error("Credential references cannot be used in field names");
      return value;
    };
    try {
      let raw = resolve(request.url, 8192).trim();
      if (/\{\{secret:|secret:\/\//i.test(raw)) throw new Error("Credential references cannot be used in URLs");
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "http://" + raw;
      url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Only HTTP and HTTPS are supported");
      if (options.forbiddenOrigins?.includes(url.origin)) throw new Error("Workbench service origin cannot be an outbound target");
      if(url.username || url.password) throw new Error("URL user information is unsupported; use explicit authentication");
      for (const param of request.queryParams || [])
        if (param.enabled !== false && param.key)
          url.searchParams.append(
            name(param.key, 8192),
            await credential(param.value ?? "", 8192),
          );
      if (Buffer.byteLength(url.href) > 8192)
        throw new BodyBudgetError(
          "Resolved URL exceeds 8 KiB",
          "ERR_REQUEST_LIMIT",
          413,
        );
    } catch (error) {
      const boundaryFailure=budgetFailure();if(boundaryFailure)return boundaryFailure;
      return failed(
        "Invalid Request URL",
        error.message,
        error instanceof BodyBudgetError ? error.code : "ERR_INVALID_URL",
      );
    }
    const headers = new OrderedHeaders();
    const credentialHeaders = new Set([
      "authorization",
      "proxy-authorization",
      "cookie",
    ]);
    let headerBytes = 0;
    const setHeader = (key: string, value: string) => {
      if (["content-length","transfer-encoding","connection","expect","upgrade","trailer"].includes(key.toLowerCase()))throw new Error("Transport framing headers are managed by the HTTP client");
      const next = headerBytes + Buffer.byteLength(key) + Buffer.byteLength(value) + 4;
      if (next > 64 * 1024) throw new BodyBudgetError("Request headers exceed 64 KiB", "ERR_REQUEST_LIMIT", 413);
      if (options.secrets.text(value)!==value) credentialHeaders.add(key.toLowerCase());
      options.secrets?.observeHeader(key, value);
      headers.append(key, value);
      headerBytes = next;
    };
    try {
      for (const header of request.headers || [])
        if (header.enabled !== false && header.key)
          setHeader(
            name(header.key, 64 * 1024),
            await credential(header.value ?? "", 64 * 1024),
          );
      if (headers.has("host") && headers.get("host") !== url.host) throw new Error("Host override must match target URL");
      if (request.auth?.type === "oauth2") {
        if (!options.resolveOAuth || !request.auth.oauthConnectionId) throw new Error("OAuth connection unavailable");
        const token = await abortable(options.resolveOAuth(request.auth.oauthConnectionId, url.origin));
        options.secrets?.add(token);
        setHeader("Authorization", "Bearer " + token);
      }
      if (request.auth?.type === "bearer")
        setHeader(
          "Authorization",
          "Bearer " + await credential(request.auth.bearerToken || "", 64 * 1024),
        );
      if (request.auth?.type === "basic")
        setHeader(
          "Authorization",
          "Basic " +
            Buffer.from(
              await credential(request.auth.basicUsername || "", 64 * 1024) +
                ":" +
                await credential(request.auth.basicPassword || "", 64 * 1024),
            ).toString("base64"),
        );
      if (request.auth?.type === "apikey") {
        const key = name(request.auth.apiKeyName || "", 8192),
          value = await credential(request.auth.apiKeyValue || "", 64 * 1024);
        options.secrets?.add(value);
        if (key) {
          if (request.auth.apiKeyIn === "query")
            url.searchParams.append(key, value);
          else {
            setHeader(key, value);
            credentialHeaders.add(key.toLowerCase());
          }
        }
      }
      for(const field of ["host","authorization","proxy-authorization","cookie"])
        if(headers.entries.filter(([key])=>key.toLowerCase()===field).length>1)throw new Error("Duplicate credential or Host headers are ambiguous");
      if (Buffer.byteLength(url.href) > 8192)
        throw new BodyBudgetError("Resolved URL exceeds 8 KiB","ERR_REQUEST_LIMIT",413);
    } catch (error) {
      const boundaryFailure=budgetFailure();if(boundaryFailure)return boundaryFailure;
      return failed(
        "Invalid Headers or Authentication",
        error instanceof BodyBudgetError
          ? error.message
          : "Invalid request header name or value",
        error instanceof BodyBudgetError ? error.code : "ERR_HEADERS",
      );
    }
    options.secrets?.observeUrl(url);
    let method = (request.method || "GET").toUpperCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Z-]{1,64}$/.test(method) || ["CONNECT", "TRACE", "TRACK"].includes(method))
      return failed("Unsupported Method", "Invalid or unsafe HTTP method", "ERR_METHOD");
    const fileChunks = async function* (file:SelectedFile) {
      const source=file.open();
      const abort=()=>source.destroy(signal.reason);
      signal.addEventListener("abort",abort,{once:true});
      try { signal.throwIfAborted();yield* source; }
      finally {signal.removeEventListener("abort",abort);source.destroy();}
    };
    let body: any;
    let formBytes = 0,
      formFields = 0;
    const resolveField = async (key: string, value: string) => {
      if (++formFields > 1000)
        throw new BodyBudgetError(
          "Request exceeds 1000 form fields",
          "ERR_REQUEST_LIMIT",
          413,
        );
      const resolvedKey = name(key),
        resolvedValue = await credential(value,maxRequestBytes);
      if (options.secrets.text(resolvedValue)!==resolvedValue) bodyHasCredentials=true;
      formBytes +=
        Buffer.byteLength(resolvedKey) + Buffer.byteLength(resolvedValue);
      if (formBytes > maxRequestBytes)
        throw new BodyBudgetError(
          "Request fields exceed configured limit",
          "ERR_REQUEST_LIMIT",
          413,
        );
      options.secrets?.observe(resolvedKey, resolvedValue);
      return [resolvedKey, resolvedValue] as const;
    };
    try {
      if (!["GET", "HEAD"].includes(method)) {
        if (
          request.body?.mode === "raw-json" ||
          request.body?.mode === "raw-text"
        ) {
          const raw = resolve(request.body.raw || "", maxRequestBytes);
          if (request.body.mode === "raw-json") {
            const parsed = JSON.parse(raw);
            // Inspect parsed strings too: JSON unicode escapes must not bypass reference/name rules.
            let references = false, inspected = 0;
            const pending = [parsed];
            while (pending.length) {
              if (++inspected > 100000) throw new BodyBudgetError("JSON inspection exceeds structural limit", "ERR_REQUEST_LIMIT", 413);
              const current = pending.pop();
              if (typeof current === "string" && /\{\{secret:/i.test(current)) references = true;
              else if (current && typeof current === "object") for (const [key, child] of Object.entries(current)) {
                if (/\{\{secret:/i.test(key)) throw new Error("Credential references cannot be used in JSON property names");
                pending.push(child);
              }
            }
            let visited = 0, expansionBytes = 0;
            const charge = (bytes: number) => { expansionBytes += bytes; if (expansionBytes > maxRequestBytes) throw new BodyBudgetError("Expanded JSON exceeds request limit", "ERR_REQUEST_LIMIT", 413); };
            const expand = async (value: any, depth = 0): Promise<any> => {
              if (++visited > 10000 || depth > 48) throw new BodyBudgetError("JSON credential expansion exceeds structural limit", "ERR_REQUEST_LIMIT", 413);
              charge(2);
              if (typeof value === "string") { const expanded = await credential(value, maxRequestBytes); charge(Buffer.byteLength(JSON.stringify(expanded))); return expanded; }
              if (Array.isArray(value)) { const out: any[] = []; for (const child of value) out.push(await expand(child, depth + 1)); return out; }
              if (value && typeof value === "object") {
                const out = Object.create(null);
                for (const [key, child] of Object.entries(value)) {
                  if (/\{\{secret:/i.test(key)) throw new Error("Credential references cannot be used in JSON property names");
                  charge(Buffer.byteLength(JSON.stringify(key)) + 1);
                  out[key] = await expand(child, depth + 1);
                }
                return out;
              }
              return value;
            };
            body = references ? JSON.stringify(await expand(parsed)) : raw;
          } else body = await credential(raw,maxRequestBytes);
          bodyHasCredentials=options.secrets.text(body)!==body;
          if(request.body.mode === "raw-json") {
            if(options.validateJsonBody) await abortable(options.validateJsonBody(body,request.body.schema,signal));
            else { JSON.parse(body); if(request.body.schema)throw new Error("JSON Schema validator unavailable"); }
          }
          if (request.body.mode === "raw-json" && !headers.has("content-type"))
            headers.set("content-type", "application/json");
        } else if (request.body?.mode === "x-www-form-urlencoded") {
          const params = new URLSearchParams();
          for (const field of request.body.formData || [])
            if (field.enabled !== false && field.key)
              params.append(...await resolveField(field.key, field.value));
          body = request.body.formData?.length
            ? params.toString()
            : await credential(request.body.raw || "",maxRequestBytes);
          headers.set("content-type", "application/x-www-form-urlencoded");
        } else if (request.body?.mode === "binary") {
          if (!request.body.fileId || !options.resolveFile) throw new Error("Select an upload file first");
          const file = await abortable(options.resolveFile(request.body.fileId));
          if (file.size > maxRequestBytes) throw new BodyBudgetError("Selected file exceeds request limit", "ERR_REQUEST_LIMIT", 413);
          body = { [Symbol.asyncIterator]: async function* () { yield* fileChunks(file); } };
          if (!headers.has("content-type")) headers.set("content-type",file.contentType);
        } else if (request.body?.mode === "form-data") {
          const boundary = "packetlark-" + randomUUID();
          const parts: Array<Buffer | SelectedFile> = [];
          let serialized = 0;
          const add = (text:string) => { const chunk=Buffer.from(text);serialized+=chunk.length;parts.push(chunk); };
          const quoted = (value:string) => value.replace(/[\r\n"\\]/g,"_");
          for (const field of request.body.formData || []) {
            if (field.enabled === false || !field.key) continue;
            const [key,value] = await resolveField(field.key,field.value || "");
            add(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(key)}"`);
            if (field.fileId) {
              if (!options.resolveFile) throw new Error("Selected file unavailable");
              const file = await abortable(options.resolveFile(field.fileId));
              add(`; filename="${quoted(field.fileName || file.name)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`);
              serialized += file.size; parts.push(file);
            } else add(`\r\n\r\n${value}`);
            add("\r\n");
          }
          add(`--${boundary}--\r\n`);
          if (serialized > maxRequestBytes) throw new BodyBudgetError("Serialized multipart body exceeds configured limit", "ERR_REQUEST_LIMIT", 413);
          headers.set("content-type", `multipart/form-data; boundary=${boundary}`);
          body = { [Symbol.asyncIterator]: async function* () { for (const part of parts) { if (Buffer.isBuffer(part)) yield part; else yield* fileChunks(part); } } };
        }
      }
      if (typeof body === "string" && Buffer.byteLength(body) > maxRequestBytes)
        throw new BodyBudgetError(
          "Request body exceeds configured limit",
          "ERR_REQUEST_LIMIT",
          413,
        );
      if (typeof body === "string")
        options.secrets?.observeBody(body, headers.get("content-type") || "");
    } catch (error) {
      const boundaryFailure = budgetFailure();
      if (boundaryFailure) return boundaryFailure;
      return failed(
        "Request Body Limit",
        error instanceof BodyBudgetError
          ? error.message
          : "Invalid request body",
        error instanceof BodyBudgetError ? error.code : "ERR_BODY",
      );
    }
    const bodyBudgetFailure = budgetFailure();
    if (bodyBudgetFailure) return bodyBudgetFailure;
    let firstByteMs = 0;
    try {
      let response: TransportResponse;
      const initialOrigin = url.origin;
      let tls: {ca?:string;cert?:string;key?:string;passphrase?:string} | undefined;
      if (request.tls) {
        if (typeof request.tls !== "object" || Array.isArray(request.tls) || Object.keys(request.tls).some(key=>!["ca","cert","keyRef","passphraseRef"].includes(key)) || Object.values(request.tls).some(value=>value!==undefined && typeof value!=="string")) throw new Error("Unsupported TLS settings; verification cannot be disabled");
        if (url.protocol !== "https:") throw new Error("TLS settings require HTTPS");
        const {ca,cert,keyRef,passphraseRef} = request.tls;
        if ([ca,cert].some(value => value && Buffer.byteLength(value)>256*1024)) throw new Error("TLS public material exceeds limit");
        const secret = async (ref?:string) => {
          if (!ref) return undefined;
          if (!options.resolveCredential) throw new Error("TLS credential resolver unavailable");
          const value=await abortable(options.resolveCredential(ref,url.origin)); options.secrets?.add(value);return value;
        };
        tls={ca,cert,key:await secret(keyRef),passphrase:await secret(passphraseRef)};
      }
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        const outgoing = new OrderedHeaders(headers);
        if (!headers.has("cookie")) {
          const cookie = await jar.getCookieString(url.href);
          if (cookie) outgoing.set("cookie", cookie);
        }
        if (
          [...outgoing].reduce(
            (size, [key, value]) =>
              size + Buffer.byteLength(key) + Buffer.byteLength(value) + 4,
            0,
          ) >
          64 * 1024
        )
          throw new BodyBudgetError(
            "Outgoing headers exceed 64 KiB",
            "ERR_REQUEST_LIMIT",
            413,
          );
        transportAttempted = true;
        response = await sendHttp(url, {method,headers:outgoing,body,signal,maxRequestBytes,tls:url.origin===initialOrigin?tls:undefined,onProgress:options.onProgress});
        for (const [name,value] of response.headerEntries) options.secrets.observeHeader(name,value);
        for (const [name,cookie] of response.headerEntries)
          if (name.toLowerCase()==="set-cookie") await jar.setCookie(cookie,url.href,{ignoreError:true});
        const location = response.headers.get("location");
        if (
          ![301, 302, 303, 307, 308].includes(response.status) ||
          !location ||
          request.followRedirects === false
        )
          break;
        response.cancel();
        if (redirects >= 10)
          throw Object.assign(new Error("Maximum 10 redirects exceeded"), {
            code: "ERR_REDIRECTS",
          });
        const next = new URL(location, url);
        if(options.forbiddenOrigins?.includes(next.origin))throw new Error("Workbench service origin cannot be an outbound target");
        if(next.username || next.password)throw new Error("Redirect user information is unsupported");
        if (!["http:", "https:"].includes(next.protocol))
          throw new Error("Redirect target must use HTTP or HTTPS");
        if (next.origin !== url.origin) {
          if(bodyHasCredentials && !((response.status===303 && method!=="HEAD") || ([301,302].includes(response.status) && method==="POST")))throw new Error("Cross-origin redirect cannot forward credential body");
          for (const name of credentialHeaders) headers.delete(name);
          headers.delete("host");
        }
        if (
          (response.status === 303 && method !== "HEAD") ||
          ([301, 302].includes(response.status) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
          headers.delete("content-length");
        }
        url = next;
      }
      firstByteMs = Math.round(performance.now() - start);
      const resHeaders = Object.fromEntries(response.headers);
      try { await abortable(options.onResponseHeaders?.({status:response.status,statusText:response.statusText,headers:resHeaders,headerEntries:response.headerEntries})); } catch(error) {response.cancel();throw error;}
      const previewLimit=options.artifactStore ? Math.max(0,Math.min(options.previewBytes ?? 256*1024,maxBytes)) : maxBytes;
      let writer: Awaited<ReturnType<ResponseArtifactStore["create"]>> | undefined;
      try { writer=await options.artifactStore?.create(); } catch(error) {response.cancel();throw error;}
      const chunks:Buffer[]=[];
      const scriptChunks:Buffer[]|undefined = (request.testScript || request.testScripts?.some(Boolean)) && previewLimit < maxBytes ? [] : undefined;
      let size=0,previewSize=0;let artifactId:string|undefined;
      try {
        for await (const value of response.body) {
          signal.throwIfAborted();const chunk=Buffer.from(value);size+=chunk.length;
          if(size>maxBytes) throw new BodyBudgetError("Response body exceeds configured limit","ERR_RESPONSE_LIMIT",502);
          await writer?.append(chunk);
          scriptChunks?.push(chunk);
          const keep=chunk.subarray(0,Math.max(0,previewLimit-previewSize));if(keep.length){chunks.push(keep);previewSize+=keep.length;}
          await abortable(options.onResponseChunk?.(chunk));
          await abortable(options.onProgress?.({phase:"download",bytes:size}));
        }
        signal.throwIfAborted();artifactId=await writer?.complete();
      } catch(error) {response.cancel();await writer?.abort();throw error;}
      const bytes=Buffer.concat(chunks,previewSize);
      const mime = response.headers.get("content-type") || "";
      const binary =
        !!mime &&
        !/^(text\/)|json|xml|javascript|x-www-form-urlencoded/i.test(mime);
      const text = binary
        ? `Binary response (${bytes.length} bytes). Use Download to save the original bytes.`
        : bytes.toString("utf8");
      const totalMs = Math.round(performance.now() - start);
      await scripts([...(request.testScripts || []), request.testScript], {
        code: response.status,
        statusText: response.statusText,
        headers: resHeaders,
        body: scriptChunks && !binary ? Buffer.concat(scriptChunks,size).toString("utf8") : text,
        responseTimeMs: totalMs,
      });
      const postBudgetFailure = budgetFailure();
      if (postBudgetFailure) {if(artifactId)await options.artifactStore?.remove(artifactId);return postBudgetFailure;}
      return rememberResponse({
        transportAttempted,
        status: response.status,
        statusText: response.statusText,
        headers: resHeaders,
        body: text,
        bodyEncoding: binary ? "base64" : "utf8",
        ...(binary ? { bodyBase64: bytes.toString("base64") } : {}),
        sizeBytes: size,
        headerEntries: response.headerEntries,
        artifactId,
        previewTruncated: size > previewSize,
        timings: {
          firstByteMs,
          totalMs: Math.round(performance.now() - start),
        },
        testResults: diagnosticValue(testResults),
        logs: allLogs.map(diagnosticText),
        ...updates(),
      });
    } catch (error) {
      const detail = options.signal?.aborted
        ? normalizeNetworkError({ code: "ERR_ABORTED" })
        : normalizeNetworkError(error, url.href);
      return rememberResponse({
        ...failed(detail.category, detail.message, detail.code),
        error: options.secrets.redact(detail),
        timings: {
          firstByteMs,
          totalMs: Math.round(performance.now() - start),
        },
      });
    }
  }
}
