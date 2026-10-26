import type { KeyValueParam } from "../models/types.js";
import { isSensitiveField } from "./SensitiveFields.js";
export { isSensitiveField } from "./SensitiveFields.js";
const marker = "[REDACTED]";

/** Run-local, bounded credential knowledge. Never serialize raw values into a report. */
export class SecretRedactor {
  #values = new Set<string>();
  #keys = new Set<string>();
  #bytes = 0;
  #blocked = false;
  #matcher: RegExp | undefined;
  #remember(value: unknown) {
    if (value === undefined || value === null) return;
    const text = String(value);
    if (!text || this.#values.has(text) || this.#blocked) return;
    const bytes = new TextEncoder().encode(text).byteLength;
    if (
      bytes > 8192 ||
      this.#values.size >= 256 ||
      this.#bytes + bytes > 256 * 1024
    ) {
      this.#blocked = true;
      return;
    }
    this.#values.add(text);
    this.#bytes += bytes;
    this.#matcher = undefined;
  }
  add(value: unknown) {
    if (value === undefined || value === null || value === "") return;
    const text = String(value);
    this.#remember(text);
    if (this.#blocked) return;
    try {
      const uri = encodeURIComponent(text);
      this.#remember(uri);
      this.#remember(uri.replace(/%20/g, "+"));
    } catch {
      this.#blocked = true;
    }
    this.#remember(btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join("")));
  }
  observeBody(body: string, mime: string) {
    if (mime.includes("application/x-www-form-urlencoded")) {
      for (const [key, value] of new URLSearchParams(body))
        this.observe(key, value);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    let visited = 0;
    const visit = (value: unknown, secret = false, depth = 0) => {
      if (++visited > 10000 || depth > 24) {
        this.#blocked = true;
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (this.#blocked) break;
          visit(
            child,
            secret ||
              isSensitiveField(key) ||
              this.#keys.has(key.toLowerCase()),
            depth + 1,
          );
        }
      } else if (secret) this.add(value);
    };
    visit(parsed);
  }
  observeParameters(values: KeyValueParam[] = []) {
    for (const parameter of values) {
      if (parameter.secret || (parameter as any).type === "secret") {
        if (this.#keys.size >= 256 || parameter.key.length > 8192)
          this.#blocked = true;
        else this.#keys.add(parameter.key.toLowerCase());
      }
      this.observe(parameter.key, parameter.value);
    }
  }
  observe(key: string, value: unknown) {
    if (isSensitiveField(key) || this.#keys.has(key.toLowerCase()))
      this.add(value);
  }
  observeUrl(url: URL) {
    for (const value of [url.username, url.password]) {
      this.add(value);
      try {
        this.add(decodeURIComponent(value));
      } catch {}
    }
    for (const [key, value] of url.searchParams) this.observe(key, value);
  }
  observeHeader(key: string, value: string) {
    if (!isSensitiveField(key)) return;
    this.add(value);
    if (/^bearer\s+/i.test(value)) this.add(value.replace(/^bearer\s+/i, ""));
    if (/^basic\s+/i.test(value)) {
      try {
        const encoded = value.replace(/^basic\s+/i, "").replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
        for (const part of new TextDecoder().decode(Uint8Array.from(atob(encoded + "=".repeat((4 - encoded.length % 4) % 4)), (char) => char.charCodeAt(0))).split(":"))
          this.add(part);
      } catch {}
    }
    if (/cookie/i.test(key))
      for (const match of value.matchAll(
        /(?:^|[;,]\s*)[^=;,\s]+\s*=\s*("[^"]*"|[^;,]*)/g,
      ))
        this.add(match[1].trim().replace(/^"|"$/g, ""));
  }
  text(value: string) {
    if (this.#blocked)
      return value.length >= 48
        ? "[Details withheld: redaction budget exceeded]"
        : "*".repeat(value.length);
    if (!this.#values.size) return value;
    this.#matcher ??= new RegExp(
      [...this.#values]
        .sort((a, b) => b.length - a.length)
        .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
      "g",
    );
    return value.replace(this.#matcher, (matched) =>
      matched.length >= marker.length
        ? marker
        : (matched.includes("*") ? "#" : "*").repeat(matched.length),
    );
  }
  redact<T>(value: T, depth = 0): T {
    if (typeof value === "string") return this.text(value) as T;
    if (depth > 32) return "[Details withheld: structure budget exceeded]" as T;
    if (Array.isArray(value))
      return value.map((child) => this.redact(child, depth + 1)) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          this.redact(child, depth + 1),
        ]),
      ) as T;
    return value;
  }
}
