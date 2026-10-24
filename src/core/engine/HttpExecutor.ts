import { HttpRequest, HttpResponse, TimingMetrics, KeyValueParam, ApiErrorDetail } from '../models/types.js';
import { VariableResolver } from './VariableResolver.js';
import { ScriptSandbox } from './ScriptSandbox.js';

export function normalizeNetworkError(err: any, targetUrl?: string): ApiErrorDetail {
  const errCode = err?.code || (err?.cause as any)?.code || '';
  const errMsg = String(err?.message || err || '');
  const errName = err?.name || '';

  // 1. DNS Resolution Failed
  if (errCode === 'ENOTFOUND' || errMsg.includes('getaddrinfo ENOTFOUND')) {
    let hostname = 'target';
    try {
      if (targetUrl) hostname = new URL(targetUrl).hostname;
    } catch {}
    return {
      category: 'DNS Resolution Failed',
      message: `Cannot resolve host '${hostname}'`,
      guidance: 'Verify hostname spelling and active internet connection.',
      code: 'ENOTFOUND'
    };
  }

  // 2. Connection Refused
  if (errCode === 'ECONNREFUSED' || errMsg.includes('ECONNREFUSED')) {
    let port = '';
    try {
      if (targetUrl) port = new URL(targetUrl).port || (new URL(targetUrl).protocol === 'https:' ? '443' : '80');
    } catch {}
    return {
      category: 'Connection Refused',
      message: `Target server refused connection${port ? ` on port ${port}` : ''}`,
      guidance: 'Verify target server is running and listening on the specified port.',
      code: 'ECONNREFUSED'
    };
  }

  // 3. Timeout
  if (
    errCode === 'ETIMEDOUT' ||
    errCode === 'UND_ERR_CONNECT_TIMEOUT' ||
    (err?.cause as any)?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    errName === 'TimeoutError' ||
    errCode === 'ABORT_ERR' ||
    errMsg.includes('timeout') ||
    errMsg.includes('timed out') ||
    errMsg.includes('CONNECT_TIMEOUT')
  ) {
    return {
      category: 'Request Timeout',
      message: 'Connection or request exceeded timeout limit',
      guidance: 'Target server took too long to respond. Check server load, network latency, or increase timeout.',
      code: 'ETIMEDOUT'
    };
  }

  // 4. SSL Expired
  if (errCode === 'CERT_HAS_EXPIRED' || errMsg.includes('CERT_HAS_EXPIRED')) {
    return {
      category: 'SSL Certificate Expired',
      message: 'Remote TLS/SSL certificate has expired',
      guidance: 'Upstream TLS certificate is invalid. Renew server certificate or configure TLS bypass.',
      code: 'CERT_HAS_EXPIRED'
    };
  }

  // 5. Self-Signed SSL
  if (
    errCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    errMsg.includes('DEPTH_ZERO_SELF_SIGNED_CERT') ||
    errMsg.includes('self-signed')
  ) {
    return {
      category: 'Self-Signed SSL Certificate',
      message: 'Self-signed SSL certificate rejected',
      guidance: 'Common in local development. Configure SSL verification options.',
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT'
    };
  }

  // 6. Invalid URL
  if (errCode === 'ERR_INVALID_URL' || (errName === 'TypeError' && errMsg.includes('Invalid URL'))) {
    return {
      category: 'Invalid Request URL',
      message: `URL '${targetUrl || ''}' is malformed or invalid`,
      guidance: 'Ensure URL starts with http:// or https:// and has a valid hostname.',
      code: 'ERR_INVALID_URL'
    };
  }

  // 7. General Network Error fallback without stack trace leakage
  return {
    category: 'Network Error',
    message: errMsg.replace(/^Error:\s*/, '') || 'Failed to execute HTTP request',
    guidance: 'Check target endpoint, network connectivity, and proxy settings.',
    code: errCode || 'FETCH_ERROR'
  };
}

export class HttpExecutor {
  public static async execute(
    request: HttpRequest,
    collectionVars: KeyValueParam[] = [],
    envVars: KeyValueParam[] = []
  ): Promise<HttpResponse> {
    const allLogs: string[] = [];
    const method = (request.method || 'GET').toUpperCase() as any;

    // 1. Build initial variable context
    let context = VariableResolver.buildContext(collectionVars, envVars);

    // 2. Execute Pre-request script if present
    if (request.preRequestScript && request.preRequestScript.trim()) {
      try {
        const sandboxRes = ScriptSandbox.execute(request.preRequestScript, context);
        context = sandboxRes.updatedVariables;
        if (sandboxRes.logs && sandboxRes.logs.length > 0) {
          allLogs.push(...sandboxRes.logs);
        }
      } catch (scriptErr: any) {
        allLogs.push(`[Pre-request Error] ${scriptErr.message || String(scriptErr)}`);
      }
    }

    // 3. Resolve and normalize URL defensively
    let rawUrl = (request.url || '').trim();
    if (!rawUrl) {
      const errDetail: ApiErrorDetail = {
        category: 'Invalid Request URL',
        message: 'Request URL cannot be empty',
        guidance: 'Please enter a valid target URL (e.g., https://api.example.com).',
        code: 'ERR_EMPTY_URL'
      };
      return {
        status: 0,
        statusText: errDetail.category,
        headers: {},
        body: JSON.stringify({ error: errDetail }, null, 2),
        sizeBytes: 0,
        timings: { firstByteMs: 0, totalMs: 0 },
        logs: allLogs,
        updatedVariables: context,
        error: errDetail
      };
    }

    let resolvedUrl = VariableResolver.resolve(rawUrl, context).trim();

    // Auto-prefix http:// if protocol is missing
    if (!/^https?:\/\//i.test(resolvedUrl)) {
      resolvedUrl = 'http://' + resolvedUrl;
    }

    // Append query params if present
    const enabledQueryParams = (request.queryParams || []).filter(q => q.enabled !== false && q.key);
    try {
      const urlObj = new URL(resolvedUrl);
      for (const q of enabledQueryParams) {
        const key = VariableResolver.resolve(q.key, context);
        const val = VariableResolver.resolve(q.value || '', context);
        urlObj.searchParams.append(key, val);
      }
      resolvedUrl = urlObj.toString();
    } catch (urlErr: any) {
      const errDetail = normalizeNetworkError(urlErr, resolvedUrl);
      return {
        status: 0,
        statusText: errDetail.category,
        headers: {},
        body: JSON.stringify({ error: errDetail }, null, 2),
        sizeBytes: 0,
        timings: { firstByteMs: 0, totalMs: 0 },
        logs: allLogs,
        updatedVariables: context,
        error: errDetail
      };
    }

    // 4. Resolve and format headers
    const headersMap: Record<string, string> = {};
    for (const h of request.headers || []) {
      if (h.enabled !== false && h.key) {
        const k = VariableResolver.resolve(h.key, context);
        const v = VariableResolver.resolve(h.value || '', context);
        headersMap[k] = v;
      }
    }

    // 5. Apply Auth
    if (request.auth) {
      if (request.auth.type === 'bearer' && request.auth.bearerToken) {
        const token = VariableResolver.resolve(request.auth.bearerToken, context);
        headersMap['Authorization'] = `Bearer ${token}`;
      } else if (request.auth.type === 'basic') {
        const user = VariableResolver.resolve(request.auth.basicUsername || '', context);
        const pass = VariableResolver.resolve(request.auth.basicPassword || '', context);
        const credentials = Buffer.from(`${user}:${pass}`).toString('base64');
        headersMap['Authorization'] = `Basic ${credentials}`;
      } else if (request.auth.type === 'apikey' && request.auth.apiKeyName && request.auth.apiKeyValue) {
        const key = VariableResolver.resolve(request.auth.apiKeyName, context);
        const val = VariableResolver.resolve(request.auth.apiKeyValue, context);
        if (request.auth.apiKeyIn === 'query') {
          try {
            const urlObj = new URL(resolvedUrl);
            urlObj.searchParams.append(key, val);
            resolvedUrl = urlObj.toString();
          } catch {
            // Keep resolvedUrl as is if parse fails
          }
        } else {
          headersMap[key] = val;
        }
      }
    }

    // 6. Format Body
    let reqBody: any = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      if (request.body?.mode === 'raw-json') {
        reqBody = VariableResolver.resolve(request.body.raw || '', context);
        if (!headersMap['Content-Type'] && !headersMap['content-type']) {
          headersMap['Content-Type'] = 'application/json';
        }
      } else if (request.body?.mode === 'raw-text') {
        reqBody = VariableResolver.resolve(request.body.raw || '', context);
      } else if (request.body?.mode === 'x-www-form-urlencoded') {
        const params = new URLSearchParams();
        if (Array.isArray(request.body.formData) && request.body.formData.length > 0) {
          for (const p of request.body.formData) {
            if (p.enabled !== false && p.key) {
              params.append(
                VariableResolver.resolve(p.key, context),
                VariableResolver.resolve(p.value, context)
              );
            }
          }
          reqBody = params.toString();
        } else if (request.body.raw) {
          reqBody = VariableResolver.resolve(request.body.raw, context);
        } else {
          reqBody = '';
        }
        headersMap['Content-Type'] = 'application/x-www-form-urlencoded';
      } else if (request.body?.mode === 'form-data') {
        const formData = new FormData();
        for (const p of request.body.formData || []) {
          if (p.enabled !== false && p.key) {
            formData.append(
              VariableResolver.resolve(p.key, context),
              VariableResolver.resolve(p.value, context)
            );
          }
        }
        reqBody = formData;
        // Native fetch will automatically generate multipart/form-data with proper boundary
        for (const k of Object.keys(headersMap)) {
          if (k.toLowerCase() === 'content-type') {
            delete headersMap[k];
          }
        }
      }
    }

    // 7. Dispatch HTTP Request with precise microsecond/millisecond timing & 30s timeout
    const startTime = performance.now();
    let response: globalThis.Response;
    let bodyText = '';
    let status = 0;
    let statusText = '';
    const resHeaders: Record<string, string> = {};

    try {
      const signal = AbortSignal.timeout(30000);
      response = await fetch(resolvedUrl, {
        method,
        headers: headersMap,
        body: reqBody,
        signal
      });

      status = response.status;
      statusText = response.statusText;
      response.headers.forEach((val, key) => {
        resHeaders[key] = val;
      });

      bodyText = await response.text();
    } catch (err: any) {
      const endTime = performance.now();
      const totalMs = Math.round(endTime - startTime);
      const normalizedErr = normalizeNetworkError(err, resolvedUrl);

      return {
        status: 0,
        statusText: normalizedErr.category,
        headers: {},
        body: JSON.stringify({ error: normalizedErr }, null, 2),
        sizeBytes: 0,
        timings: {
          firstByteMs: 0,
          totalMs
        },
        logs: allLogs,
        updatedVariables: context,
        error: normalizedErr
      };
    }

    const endTime = performance.now();
    const totalMs = Math.round(endTime - startTime);

    const timingMetrics: TimingMetrics = {
      firstByteMs: totalMs,
      totalMs
    };

    // 8. Run Test Scripts
    let testResults: any[] = [];
    if (request.testScript && request.testScript.trim()) {
      try {
        const testRes = ScriptSandbox.execute(request.testScript, context, {
          code: status,
          statusText,
          headers: resHeaders,
          body: bodyText,
          responseTimeMs: totalMs
        });
        testResults = testRes.testResults;
        context = testRes.updatedVariables;
        if (testRes.logs && testRes.logs.length > 0) {
          allLogs.push(...testRes.logs);
        }
      } catch (testErr: any) {
        testResults.push({
          name: 'Test Execution',
          passed: false,
          error: testErr.message || String(testErr)
        });
      }
    }

    return {
      status,
      statusText,
      headers: resHeaders,
      body: bodyText,
      sizeBytes: Buffer.byteLength(bodyText, 'utf8'),
      timings: timingMetrics,
      testResults,
      logs: allLogs,
      updatedVariables: context
    };
  }
}
