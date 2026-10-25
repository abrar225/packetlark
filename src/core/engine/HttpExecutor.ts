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
      timings: { firstByteMs: 0, totalMs: 0 },
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
    const jar = options.cookieJar ?? new CookieJar();
    const scripts = async (codes: string[], response?: ResponseContext) => {
      for (const code of codes.filter(Boolean)) {
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
            signal: options.signal,
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
    if (
      !(await scripts([
        ...(request.preRequestScripts || []),
        request.preRequestScript,
      ]))
    )
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
    const resolve = (text: string) => VariableResolver.resolve(text, context());
    let url: URL;
    try {
      let raw = resolve(request.url).trim();
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "http://" + raw;
      url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Only HTTP and HTTPS are supported");
      for (const param of request.queryParams || [])
        if (param.enabled !== false && param.key)
          url.searchParams.append(
            resolve(param.key),
            resolve(param.value ?? ""),
          );
    } catch (error) {
      return failed("Invalid Request URL", error.message, "ERR_INVALID_URL");
    }
    const headers = new Headers();
    try {
      for (const h of request.headers || [])
        if (h.enabled !== false && h.key)
          headers.set(resolve(h.key), resolve(h.value ?? ""));
    } catch (error) {
      return failed("Invalid Headers", error.message, "ERR_HEADERS");
    }
    if (request.auth?.type === "bearer")
      headers.set(
        "Authorization",
        "Bearer " + resolve(request.auth.bearerToken || ""),
      );
    if (request.auth?.type === "basic")
      headers.set(
        "Authorization",
        "Basic " +
          Buffer.from(
            resolve(request.auth.basicUsername || "") +
              ":" +
              resolve(request.auth.basicPassword || ""),
          ).toString("base64"),
      );
    if (request.auth?.type === "apikey") {
      const key = resolve(request.auth.apiKeyName || "");
      const value = resolve(request.auth.apiKeyValue || "");
      if (key) {
        if (request.auth.apiKeyIn === "query")
          url.searchParams.append(key, value);
        else headers.set(key, value);
      }
    }
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
            params.append(resolve(field.key), resolve(field.value));
        body = request.body.formData?.length
          ? params.toString()
          : resolve(request.body.raw || "");
        headers.set("content-type", "application/x-www-form-urlencoded");
      } else if (request.body?.mode === "form-data") {
        body = new FormData();
        for (const field of request.body.formData || [])
          if (field.enabled !== false && field.key)
            body.append(resolve(field.key), resolve(field.value));
        headers.delete("content-type");
      }
    }
    const start = performance.now();
    let firstByteMs = 0;
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = options.signal
      ? AbortSignal.any([timeoutSignal, options.signal])
      : timeoutSignal;
    try {
      let response: Response;
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        const outgoing = new Headers(headers);
        if (!headers.has("cookie")) {
          const cookie = await jar.getCookieString(url.href);
          if (cookie) outgoing.set("cookie", cookie);
        }
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
          headers.delete("authorization");
          headers.delete("cookie");
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
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader)
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxBytes) {
              await reader.cancel();
              throw Object.assign(
                new Error(`Response exceeds ${maxBytes} byte limit`),
                { code: "ERR_RESPONSE_LIMIT" },
              );
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      const bytes = Buffer.concat(chunks);
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
      return {
        status: response.status,
        statusText: response.statusText,
        headers: resHeaders,
        body: text,
        bodyEncoding: binary ? "base64" : "utf8",
        ...(binary ? { bodyBase64: bytes.toString("base64") } : {}),
        sizeBytes: bytes.length,
        timings: { firstByteMs, totalMs },
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
