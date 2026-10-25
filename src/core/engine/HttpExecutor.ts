import { BodyBudgetError, readResponseBody } from "./BodyBudget.js";
import type { SecretRedactor } from "../security/SecretRedactor.js";
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
        "Upstream TLS certificate is invalid. Renew server certificate or configure TLS bypass.",
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
  signal?: AbortSignal;
  cookieJar?: CookieJar;
  globals?: Record<string, string>;
  localVariables?: Record<string, string>;
  iterationData?: Record<string, string>;
  info?: Record<string, any>;
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
    const updates = () => ({
      updatedVariables: context(),
      updatedEnvironment: environment,
      updatedCollectionVariables: collection,
      updatedGlobals: globals,
      updatedLocalVariables: local,
      nextRequest,
      skipRequest,
    });
    const failed = (
      category: string,
      message: string,
      code: string,
    ): HttpResponse => ({
      status: 0,
      statusText: category,
      headers: {},
      body: JSON.stringify({ error: message }),
      sizeBytes: 0,
      transportAttempted,
      timings: {
        firstByteMs: 0,
        totalMs: Math.round(performance.now() - start),
      },
      error: {
        category,
        message,
        guidance:
          "Review the request settings, scripts, and supported feature documentation.",
        code,
      },
      testResults,
      logs: allLogs,
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
      request.auth?.type === "unsupported" ||
      request.auth?.type === "inherit" ||
      request.body?.mode === "unsupported"
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
      return {
        status: 0,
        statusText: "Skipped",
        headers: {},
        body: "",
        sizeBytes: 0,
        timings: { firstByteMs: 0, totalMs: 0 },
        testResults,
        logs: allLogs,
        ...updates(),
      };
    if (!request.url?.trim())
      return failed(
        "Invalid Request URL",
        "Request URL cannot be empty",
        "ERR_EMPTY_URL",
      );
    const resolve = (text: string, budget = maxRequestBytes) =>
      VariableResolver.resolve(text, context(), budget);
    let url: URL;
    try {
      let raw = resolve(request.url, 8192).trim();
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "http://" + raw;
      url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Only HTTP and HTTPS are supported");
      for (const param of request.queryParams || [])
        if (param.enabled !== false && param.key)
          url.searchParams.append(
            resolve(param.key, 8192),
            resolve(param.value ?? "", 8192),
          );
      if (Buffer.byteLength(url.href) > 8192)
        throw new BodyBudgetError(
          "Resolved URL exceeds 8 KiB",
          "ERR_REQUEST_LIMIT",
          413,
        );
    } catch (error) {
      return failed(
        "Invalid Request URL",
        error.message,
        error instanceof BodyBudgetError ? error.code : "ERR_INVALID_URL",
      );
    }
    const headers = new Headers();
    const credentialHeaders = new Set([
      "authorization",
      "proxy-authorization",
      "cookie",
    ]);
    let headerBytes = 0;
    const setHeader = (key: string, value: string) => {
      const previous = headers.has(key)
        ? Buffer.byteLength(key) + Buffer.byteLength(headers.get(key)) + 4
        : 0;
      const next =
        headerBytes -
        previous +
        Buffer.byteLength(key) +
        Buffer.byteLength(value) +
        4;
      if (next > 64 * 1024)
        throw new BodyBudgetError(
          "Request headers exceed 64 KiB",
          "ERR_REQUEST_LIMIT",
          413,
        );
      options.secrets?.observeHeader(key, value);
      headers.set(key, value);
      headerBytes = next;
    };
    try {
      for (const header of request.headers || [])
        if (header.enabled !== false && header.key)
          setHeader(
            resolve(header.key, 64 * 1024),
            resolve(header.value ?? "", 64 * 1024),
          );
      if (request.auth?.type === "bearer")
        setHeader(
          "Authorization",
          "Bearer " + resolve(request.auth.bearerToken || "", 64 * 1024),
        );
      if (request.auth?.type === "basic")
        setHeader(
          "Authorization",
          "Basic " +
            Buffer.from(
              resolve(request.auth.basicUsername || "", 64 * 1024) +
                ":" +
                resolve(request.auth.basicPassword || "", 64 * 1024),
            ).toString("base64"),
        );
      if (request.auth?.type === "apikey") {
        const key = resolve(request.auth.apiKeyName || "", 8192),
          value = resolve(request.auth.apiKeyValue || "", 64 * 1024);
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
      if (Buffer.byteLength(url.href) > 8192)
        throw new BodyBudgetError(
          "Resolved URL exceeds 8 KiB",
          "ERR_REQUEST_LIMIT",
          413,
        );
    } catch (error) {
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
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
        method,
      )
    )
      return failed(
        "Unsupported Method",
        `Unsupported HTTP method ${method}`,
        "ERR_METHOD",
      );
    let body: any;
    let formBytes = 0,
      formFields = 0;
    const resolveField = (key: string, value: string) => {
      if (++formFields > 1000)
        throw new BodyBudgetError(
          "Request exceeds 1000 form fields",
          "ERR_REQUEST_LIMIT",
          413,
        );
      const resolvedKey = resolve(key),
        resolvedValue = resolve(value);
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
          body = resolve(request.body.raw || "");
          if (request.body.mode === "raw-json" && !headers.has("content-type"))
            headers.set("content-type", "application/json");
        } else if (request.body?.mode === "x-www-form-urlencoded") {
          const params = new URLSearchParams();
          for (const field of request.body.formData || [])
            if (field.enabled !== false && field.key)
              params.append(...resolveField(field.key, field.value));
          body = request.body.formData?.length
            ? params.toString()
            : resolve(request.body.raw || "");
          headers.set("content-type", "application/x-www-form-urlencoded");
        } else if (request.body?.mode === "form-data") {
          body = new FormData();
          for (const field of request.body.formData || [])
            if (field.enabled !== false && field.key)
              body.append(...resolveField(field.key, field.value));
          headers.delete("content-type");
        }
      }
      if (body instanceof FormData) {
        const prepared = new Request(url.href, { method, headers, body });
        // Only bounded text fields reach this encoder. Complete its in-memory stream:
        // cancelling Undici's multipart encoder mid-chunk can reject outside its reader.
        const bytes = await prepared.arrayBuffer();
        if (bytes.byteLength > maxRequestBytes)
          throw new BodyBudgetError(
            "Serialized multipart body exceeds configured limit",
            "ERR_REQUEST_LIMIT",
            413,
          );
        headers.set("content-type", prepared.headers.get("content-type"));
        body = new Uint8Array(bytes);
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
      let response: Response;
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        const outgoing = new Headers(headers);
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
        response = await fetch(url.href, {
          method,
          headers: outgoing,
          body,
          signal,
          redirect: "manual",
        });
        for (const cookie of response.headers.getSetCookie())
          await jar.setCookie(cookie, url.href, { ignoreError: true });
        const location = response.headers.get("location");
        if (
          ![301, 302, 303, 307, 308].includes(response.status) ||
          !location ||
          request.followRedirects === false
        )
          break;
        await response.body?.cancel();
        if (redirects >= 10)
          throw Object.assign(new Error("Maximum 10 redirects exceeded"), {
            code: "ERR_REDIRECTS",
          });
        const next = new URL(location, url);
        if (!["http:", "https:"].includes(next.protocol))
          throw new Error("Redirect target must use HTTP or HTTPS");
        if (next.origin !== url.origin) {
          for (const name of credentialHeaders) headers.delete(name);
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
      const bytes = await readResponseBody(response, maxBytes, signal);
      const mime = response.headers.get("content-type") || "";
      const binary =
        !!mime &&
        !/^(text\/)|json|xml|javascript|x-www-form-urlencoded/i.test(mime);
      const text = binary
        ? `Binary response (${bytes.length} bytes). Use Download to save the original bytes.`
        : bytes.toString("utf8");
      const totalMs = Math.round(performance.now() - start),
        resHeaders = Object.fromEntries(response.headers);
      await scripts([...(request.testScripts || []), request.testScript], {
        code: response.status,
        statusText: response.statusText,
        headers: resHeaders,
        body: text,
        responseTimeMs: totalMs,
      });
      const postBudgetFailure = budgetFailure();
      if (postBudgetFailure) return postBudgetFailure;
      return {
        transportAttempted,
        status: response.status,
        statusText: response.statusText,
        headers: resHeaders,
        body: text,
        bodyEncoding: binary ? "base64" : "utf8",
        ...(binary ? { bodyBase64: bytes.toString("base64") } : {}),
        sizeBytes: bytes.length,
        timings: {
          firstByteMs,
          totalMs: Math.round(performance.now() - start),
        },
        testResults,
        logs: allLogs,
        ...updates(),
      };
    } catch (error) {
      const detail = options.signal?.aborted
        ? normalizeNetworkError({ code: "ERR_ABORTED" })
        : normalizeNetworkError(error, url.href);
      return {
        ...failed(detail.category, detail.message, detail.code),
        error: detail,
        timings: {
          firstByteMs,
          totalMs: Math.round(performance.now() - start),
        },
      };
    }
  }
}
