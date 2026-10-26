import { isSensitiveField, SecretRedactor } from "../security/SecretRedactor.js";
import type { SniffedTrafficItem } from "../models/types.js";
const marker = "[REDACTED]";
const safeHeaders = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "content-length",
  "cache-control",
  "date",
  "server",
  "vary",
  "allow",
  "location",
]);
const sensitive = (key: string, extra: Set<string>) =>
  isSensitiveField(key) || extra.has(key.toLowerCase());

/** Safe inspection copy only. Never use this copy to forward a request. Unknown text/binary bodies are omitted. */
export function sanitizeCapture(
  input: SniffedTrafficItem,
  extraFields: string[] = [],
  knownSecrets?: SecretRedactor,
): SniffedTrafficItem {
  const extra = new Set(extraFields.map((key) => key.toLowerCase()));
  const secrets = new Set<string>();
  const redactor = new SecretRedactor();
  let visited = 0;
  const remember = (value: unknown) => {
    if (value === null || value === undefined || typeof value === "object")
      return;
    const text = String(value);
    if (!text) return;
    if (text.length > 8192 || (!secrets.has(text) && secrets.size >= 128))
      throw new Error("Capture redaction budget exceeded");
    secrets.add(text);
    redactor.add(text);
    if (/^Bearer /i.test(text)) remember(text.slice(7));
  };
  const collect = (value: unknown, depth = 0, secret = false) => {
    if (++visited > 10000 || depth > 24)
      throw new Error("Capture redaction traversal exceeded");
    if (!value || typeof value !== "object") {
      if (secret) remember(value);
      return;
    }
    const entries = Object.entries(value);
    if (entries.length > 1000)
      throw new Error("Capture redaction width exceeded");
    for (const [key, child] of entries)
      collect(child, depth + 1, secret || sensitive(key, extra));
  };
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    url = new URL("http://invalid.invalid/");
  }
  remember(url.username);
  remember(url.password);
  for (const [key, value] of url.searchParams)
    if (sensitive(key, extra)) remember(value);
  for (const headers of [input.requestHeaders, input.responseHeaders])
    for (const [key, value] of Object.entries(headers || {})) {
      if (sensitive(key, extra) || !safeHeaders.has(key.toLowerCase()))
        remember(value);
      // Learn decoded Basic components and cookie/Bearer fragments as well as
      // the complete field, so an echoed password is never retained.
      redactor.observeHeader(key, value);
      if (/cookie/i.test(key))
        for (const match of value.matchAll(
          /(?:^|[;,]\s*)[^=;,\s]+\s*=\s*("[^"]*"|[^;,]*)/g,
        ))
          remember(match[1].trim().replace(/^"|"$/g, ""));
      if (key.toLowerCase() === "location") {
        let location: URL;
        try {
          location = new URL(value, url);
        } catch {
          continue;
        }
        remember(location.username);
        remember(location.password);
        for (const [field, entry] of location.searchParams)
          if (sensitive(field, extra)) remember(entry);
      }
    }
  const normalizeBody = (body: unknown, headers: Record<string, string>) => {
    const mime =
      Object.entries(headers || {}).find(
        ([key]) => key.toLowerCase() === "content-type",
      )?.[1] || "";
    if (
      typeof body !== "string" ||
      !mime.includes("application/x-www-form-urlencoded")
    )
      return body;
    const fields = Object.create(null);
    let count = 0;
    for (const [key, value] of new URLSearchParams(body)) {
      if (++count > 1000) throw new Error("Capture form traversal exceeded");
      if (Object.hasOwn(fields, key)) {
        if (!Array.isArray(fields[key])) fields[key] = [fields[key]];
        fields[key].push(value);
      } else fields[key] = value;
    }
    return fields;
  };
  const requestBody = normalizeBody(input.requestBody, input.requestHeaders);
  const responseBody = normalizeBody(input.responseBody, input.responseHeaders);
  collect(requestBody);
  collect(responseBody);
  visited = 0;
  const redactText = (text: string) => {
    const result = knownSecrets?.text(redactor.text(text)) ?? redactor.text(text);
    return result.length > 8192 ? result.slice(0, 8192) + "[omitted]" : result;
  };
  const cleanValue = (value: any, depth = 0): any => {
    if (++visited > 10000 || depth > 24) return "[Omitted: structure limit]";
    if (typeof value === "string") return redactText(value);
    if (typeof value === "number" || typeof value === "boolean")
      return redactText(String(value)) !== String(value) ? marker : value;
    if (value === null) return value;
    if (Array.isArray(value))
      return value.slice(0, 1000).map((child) => cleanValue(child, depth + 1));
    if (value && typeof value === "object") {
      const output = Object.create(null);
      for (const [key, child] of Object.entries(value).slice(0, 1000))
        output[redactText(key)] = sensitive(key, extra)
          ? marker
          : cleanValue(child, depth + 1);
      return output;
    }
    return undefined;
  };
  const cleanBody = (body: unknown) =>
    typeof body === "string"
      ? "[Omitted: unstructured or binary body]"
      : cleanValue(body);
  const cleanUrl = (value: URL) => {
    value.username = "";
    value.password = "";
    value.hash = "";
    value.search = new URLSearchParams(
      [...value.searchParams].map(([key, entry]) => [
        redactText(key),
        sensitive(key, extra) ? marker : redactText(entry),
      ]),
    ).toString();
    return redactText(value.href);
  };
  const cleanHeaders = (headers: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(headers || {}).map(([key, value]) => [
        redactText(key),
        sensitive(key, extra) || !safeHeaders.has(key.toLowerCase())
          ? marker
          : key.toLowerCase() === "location"
            ? (() => {
                try {
                  return cleanUrl(new URL(value, url));
                } catch {
                  return "[Omitted: invalid location]";
                }
              })()
            : redactText(value),
      ]),
    );
  const sanitizedUrl = cleanUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(sanitizedUrl);
  } catch {
    parsed = new URL("http://redacted.invalid/");
  }
  const entries = [...parsed.searchParams.entries()];
  return {
    id: redactText(input.id),
    timestamp: input.timestamp,
    method: redactText(input.method) as SniffedTrafficItem["method"],
    url: parsed.href,
    pathname: parsed.pathname,
    queryParams: Object.fromEntries(entries),
    queryParamEntries: entries,
    requestHeaders: cleanHeaders(input.requestHeaders),
    requestBody: cleanBody(requestBody),
    responseStatus: input.responseStatus,
    responseHeaders: cleanHeaders(input.responseHeaders),
    responseBody: cleanBody(responseBody),
    durationMs: input.durationMs,
    redaction: { version: 1, applied: true },
  };
}
