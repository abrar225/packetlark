import { SecretRedactor, isSensitiveField } from "../security/SecretRedactor.js";
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
interface TabState { label: string; token?: string; response?: any; retentionNotice?: string; touched: number; }

/** Browser-neutral ownership and retention model, shared by UI and public tests. */
export class WorkbenchState {
  readonly tabs = new Map<string, TabState>();
  readonly history: any[] = [];
  open(key: string, label: string) {
    if (!this.tabs.has(key)) {
      if (this.tabs.size >= 20) throw new Error("20 request tabs are open. Close a tab before opening another.");
      this.tabs.set(key, { label, touched: Date.now() });
    }
    this.tabs.get(key)!.label = label;
    this.tabs.get(key)!.touched = Date.now();
    return this.tabs.get(key)!;
  }
  close(key: string) { this.tabs.delete(key); }
  begin(key: string) { const tab = this.tabs.get(key)!; return tab.token = crypto.randomUUID(); }
  retainedBytes() { return [...this.tabs.values()].reduce((n, tab) => n + (tab.response ? size(tab.response) : 0), 0); }
  finish(key: string, token: string, response: any) {
    const tab = this.tabs.get(key);
    if (!tab || tab.token !== token) return false;
    tab.token = undefined;
    tab.retentionNotice = undefined;
    tab.response = size(response) <= 2 * 1024 * 1024 ? structuredClone(response) : {
      status: Number.isFinite(response.status) ? response.status : 0, statusText: String(response.statusText || "").slice(0, 512), headers: {}, timings: { totalMs: Number.isFinite(response.timings?.totalMs) ? response.timings.totalMs : 0 },
      sizeBytes: Number.isFinite(response.sizeBytes) ? response.sizeBytes : 0, body: String(response.body || "").slice(0, 65536), testResults: (response.testResults || []).slice(0, 50).map((test: any) => ({ name: String(test.name).slice(0, 512), passed: test.passed === true, error: String(test.error || "").slice(0, 2048) })),
      artifactId: typeof response.artifactId === "string" ? response.artifactId : undefined, previewTruncated: true,
      retentionWarning: "Response retained as a 64 KiB preview; it exceeds the 2 MiB per-tab retention limit.",
    };
    for (const [other, value] of [...this.tabs].sort((a, b) => a[1].touched - b[1].touched)) {
      if (this.retainedBytes() <= 16 * 1024 * 1024) break;
      if (other !== key && value.response) {
        value.response = undefined;
        value.retentionNotice = "This response preview expired to keep retained responses within 16 MiB. Send again to refresh it.";
      }
    }
    return true;
  }
  addHistory(entry: any) {
    if (size(entry) > 512 * 1024) return false;
    this.history.unshift(structuredClone(entry));
    while (this.history.length > 50 || size(this.history) > 4 * 1024 * 1024) this.history.pop();
    return true;
  }
}

/** Reviewable example projection. Opaque metadata/scripts/unstructured bodies are omitted. */
export function sanitizeExample(request: any, response: any, variables: any[] = [], knownSecrets?: SecretRedactor) {
  const redactor = knownSecrets ?? new SecretRedactor();
  redactor.observeParameters(variables);
  redactor.observeParameters(request.headers);
  redactor.observeParameters(request.queryParams);
  redactor.observeParameters(request.body?.formData);
  for (const [key, value] of Object.entries(request.auth || {})) if (typeof value === "string" && key !== "type" && key !== "apiKeyName" && key !== "apiKeyIn") redactor.add(value);
  for (const header of request.headers || []) redactor.observeHeader(header.key, header.value);
  try { redactor.observeUrl(new URL(request.url.replace(/\{\{[^}]+\}\}/g, "placeholder"), "http://example.invalid")); } catch {}
  redactor.observeBody(request.body?.raw || "", request.body?.mode === "x-www-form-urlencoded" ? "application/x-www-form-urlencoded" : "application/json");
  redactor.observeBody(response.body || "", "application/json");
  for (const [key, value] of Object.entries(response.headers || {})) redactor.observeHeader(key, String(value));
  let url = request.url;
  try { const parsed = new URL(url); parsed.username = ""; parsed.password = ""; url = parsed.href; } catch {}
  const params = (values: any[] = []) => values.map((item) => ({ key: item.key, value: item.secret || isSensitiveField(item.key) ? "[REDACTED]" : redactor.text(String(item.value)), enabled: item.enabled !== false }));
  let body: any = { mode: "none" };
  let requestJson: any, responseJson: any;
  let visited = 0;
  const structured = (value: any, depth = 0): any => {
    if (++visited > 10000 || depth > 24) throw new Error("Example structure exceeds inspection budget");
    if (Array.isArray(value)) return value.map((child) => structured(child, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [redactor.text(key), isSensitiveField(key) ? "[REDACTED]" : structured(child, depth + 1)]));
    if (typeof value === "string") return redactor.text(value);
    return redactor.text(String(value)) === String(value) ? value : "[REDACTED]";
  };
  if (request.body?.mode === "raw-json") {
    try { requestJson = structured(JSON.parse(request.body.raw)); body = { mode: "raw-json", raw: "" }; } catch {}
  } else if (["form-data", "x-www-form-urlencoded"].includes(request.body?.mode)) body = { mode: request.body.mode, formData: params(request.body.formData) };
  let responseBody = "[Unstructured or binary body omitted from example]";
  if (response.bodyEncoding !== "base64") { try { responseJson = structured(JSON.parse(response.body)); responseBody = ""; } catch {} }
  const result = redactor.redact({
    request: { id: request.id, name: request.name, method: request.method, url: redactor.text(url), headers: params((request.headers || []).filter((header: any) => /^(content-type|accept|user-agent)$/i.test(header.key))), queryParams: params(request.queryParams), auth: { type: "none" }, body },
    response: { status: response.status, statusText: response.statusText, headers: Object.fromEntries(Object.entries(response.headers || {}).filter(([key]) => /^(content-type|content-length)$/i.test(key))), body: responseBody, sizeBytes: response.sizeBytes, timings: response.timings },
    omissions: "Scripts, authentication, opaque import metadata, unknown headers and non-JSON/binary body previews are omitted. Review for unknown secrets before saving.",
  });
  // Mask parsed values before JSON serialization. Masking the serialized text
  // can turn numeric secrets into invalid unquoted stars or damage escaping.
  if (requestJson !== undefined) result.request.body.raw = JSON.stringify(requestJson);
  if (responseJson !== undefined) result.response.body = JSON.stringify(responseJson);
  return result;
}
