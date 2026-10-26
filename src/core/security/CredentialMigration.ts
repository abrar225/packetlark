import { isSensitiveField } from './SensitiveFields.js';
import { SecretRedactor } from './SecretRedactor.js';
import { secretReferencePattern } from './CredentialStore.js';
export interface CredentialCandidate { pointer: string; label: string }
const failure = () => new Error('Credential migration failed');
const escape = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
/** Pure review metadata: values are read only by credentialMigrationValue during an approved apply. */
export function scanCredentialCandidates(document: unknown): CredentialCandidate[] {
  const out: CredentialCandidate[] = []; let nodes = 0;
  function visit(value: unknown, pointer: string, sensitive: boolean, depth: number) {
    if (++nodes > 100000 || depth > 48) throw failure();
    if (typeof value === 'string') {
      if (sensitive && value && !secretReferencePattern.test(value) && !/^\{\{[^{}]+\}\}$/.test(value)) { if (out.length >= 1000) throw failure(); out.push({ pointer, label: pointer }); }
    } else if (value && typeof value === 'object') {
      const pair = value as { key?: unknown; secret?: unknown };
      for (const [key, child] of Object.entries(value)) {
        const flagged = key === 'value' && (pair.secret === true || (typeof pair.key === 'string' && isSensitiveField(pair.key)));
        visit(child, `${pointer}/${escape(key)}`, sensitive || flagged || isSensitiveField(key), depth + 1);
      }
    }
  }
  visit(document, '', false, 0); return out;
}
function location(document: any, pointer: string): { parent: any; key: string } {
  if (!pointer.startsWith('/') || pointer.length > 8192) throw failure();
  const keys = pointer.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw failure();
  let parent = document;
  for (const key of keys.slice(0, -1)) { if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw failure(); parent = parent[key]; }
  const key = keys.at(-1)!; if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw failure(); return { parent, key };
}
export function credentialMigrationValue(document: unknown, pointer: string): string {
  if (!scanCredentialCandidates(document).some(c => c.pointer === pointer)) throw failure();
  const { parent, key } = location(document, pointer); if (typeof parent[key] !== 'string') throw failure(); return parent[key];
}
/** Produces a detached replacement document, preserving the source byte-for-byte in caller storage. */
export function projectCredentialMigration<T>(document: T, replacements: { pointer: string; reference: string }[]): T {
  const copy = structuredClone(document); const candidates = new Set(scanCredentialCandidates(document).map(c => c.pointer)); const used = new Set<string>();
  for (const { pointer, reference } of replacements) {
    if (!candidates.has(pointer) || used.has(pointer) || !secretReferencePattern.test(reference)) throw failure(); used.add(pointer);
    const { parent, key } = location(copy, pointer); parent[key] = reference;
  }
  return copy;
}
/** Pure safe-export projection. References and template variables remain inert; no vault reads. */
export function safeCredentialExport<T>(document: T): T {
  const redactor = new SecretRedactor();
  const reference = /\{\{secret:[0-9a-f-]{36}\}\}/g;
  const template = /^\{\{[^{}]+\}\}$/;
  const protectedText = (value: string) => value.split(/(\{\{secret:[0-9a-f-]{36}\}\})/g).map(part => secretReferencePattern.test(part) ? part : redactor.text(part)).join('');
  const mask = (value: string) => {
    if (!value || template.test(value)) return value;
    const refs = value.match(reference);
    if (refs) return refs.join(' ');
    redactor.add(value); return '[REDACTED]';
  };
  let visited = 0;
  function visit(value: any, sensitive: boolean, depth: number, final: boolean): any {
    if (++visited > 200000 || depth > 48) throw failure();
    if (typeof value === 'string') return sensitive && !final ? mask(value) : final ? protectedText(value) : value;
    if (!value || typeof value !== 'object') return value;
    const copy: any = Array.isArray(value) ? [] : {};
    for (const [key, child] of Object.entries(value)) {
      const flagged = key === 'value' && (value.secret === true || (typeof value.key === 'string' && isSensitiveField(value.key)));
      const childSensitive = sensitive || flagged || isSensitiveField(key);
      if (key === 'raw' && typeof child === 'string') {
        try { copy[key] = JSON.stringify(visit(JSON.parse(child), childSensitive, depth + 1, final)); continue; } catch (error) { if (error.message === 'Credential migration failed') throw error; }
      }
      if (key === 'url' && typeof child === 'string') {
        let url: URL | undefined; try { url = new URL(child); } catch {}
        if (url) {
          if (url.username) url.username = final ? protectedText(decodeURIComponent(url.username)) : mask(decodeURIComponent(url.username));
          if (url.password) url.password = final ? protectedText(decodeURIComponent(url.password)) : mask(decodeURIComponent(url.password));
          const params = [...url.searchParams]; url.search = '';
          for (const [name, text] of params) url.searchParams.append(name, !final && isSensitiveField(name) ? mask(text) : final ? protectedText(text) : text);
          copy[key] = url.href; continue;
        }
      }
      Object.defineProperty(copy, key, { value: visit(child, childSensitive, depth + 1, final), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  }
  const projected = visit(document, false, 0, false);
  return visit(projected, false, 0, true);
}
