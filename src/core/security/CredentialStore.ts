import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export type CredentialKind = 'secret' | 'oauth-client-secret' | 'oauth-bundle' | 'cookie-bundle';
export type CredentialStorage = 'session' | 'keychain';
export interface CredentialMetadata { id: string; reference: string; label: string; origins: string[]; storage: CredentialStorage; kind: CredentialKind }
export interface CredentialProvider { get(namespace: string, id: string): Promise<string>; set(namespace: string, id: string, value: string): Promise<void>; delete(namespace: string, id: string): Promise<void> }
const fail = () => new Error('Credential operation failed');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const secretReferencePattern = /^\{\{secret:([0-9a-f-]{36})\}\}$/;
export function credentialOrigin(value: string) {
  if (typeof value !== 'string' || value.length > 8192) throw fail();
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.origin === 'null') throw fail();
  return u.origin;
}
/** Native OS APIs: values never appear in process arguments. Linux requires persistent Secret Service. */
export class NativeKeychainProvider implements CredentialProvider {
  async entry(namespace: string, id: string) {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(namespace, id, { linux: { store: 'secret-service' } });
  }
  async get(n: string, id: string) { try { const value = await (await this.entry(n, id)).getPassword(); if (typeof value !== 'string') throw fail(); return value; } catch { throw fail(); } }
  async set(n: string, id: string, value: string) { try { await (await this.entry(n, id)).setPassword(value); } catch { throw fail(); } }
  async delete(n: string, id: string) { try { await (await this.entry(n, id)).deletePassword(); } catch { throw fail(); } }
}

export class CredentialStore {
  readonly namespace: string;
  #path: string; #provider: CredentialProvider; #session = new Map<string, string>(); #memoryMetadata: CredentialMetadata[] = []; #queue: Promise<unknown> = Promise.resolve();
  constructor(options: { workspaceId: string; metadataPath: string; provider?: CredentialProvider }) {
    if (!options.workspaceId || !path.isAbsolute(options.metadataPath)) throw fail();
    this.namespace = `packetlark:${createHash('sha256').update(options.workspaceId).digest('hex')}`;
    this.#path = options.metadataPath; this.#provider = options.provider ?? new NativeKeychainProvider();
  }
  /** Keep the workspace writer lease until native mutations have settled. */
  async idle() { await this.#queue; }
  async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn); this.#queue = run.catch(() => {});
    try { return await run; } catch { throw fail(); }
  }
  async #directory(create = false) {
    const dir = path.dirname(this.#path);
    let current = path.parse(dir).root;
    for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return false;
        await mkdir(current, { mode: 0o700 }); stat = await lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail();
    }
    const stat = await lstat(dir);
    if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw fail();
    return true;
  }
  async #read(): Promise<CredentialMetadata[]> {
    // Node POSIX mode bits do not establish Windows ACL privacy. Session remains memory-only.
    if (process.platform === 'win32') return structuredClone(this.#memoryMetadata);
    if (!await this.#directory()) return []; let file;
    try { file = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if (e.code === 'ENOENT') return []; throw fail(); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024 || ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw fail();
      const buffer = Buffer.alloc(1024 * 1024 + 1); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) throw fail();
      const data = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (data.namespace !== this.namespace || !Array.isArray(data.credentials) || data.credentials.length > 1000) throw fail();
      const entries = data.credentials.map((m: CredentialMetadata) => this.#metadata(m));
      if (new Set(entries.map(m => m.id)).size !== entries.length) throw fail();
      return entries;
    } finally { await file.close(); }
  }
  #metadata(m: CredentialMetadata): CredentialMetadata {
    if (!uuid.test(m.id) || m.reference !== `{{secret:${m.id}}}` || typeof m.label !== 'string' || m.label.length > 200 || !['secret', 'oauth-client-secret', 'oauth-bundle', 'cookie-bundle'].includes(m.kind) || !['session', 'keychain'].includes(m.storage) || !Array.isArray(m.origins) || !m.origins.length || m.origins.length > 64) throw fail();
    return { id: m.id, reference: m.reference, label: m.label, origins: [...new Set(m.origins.map(credentialOrigin))], storage: m.storage, kind: m.kind };
  }
  #serialize(credentials: CredentialMetadata[]) {
    if (credentials.length > 1000) throw fail();
    const serialized = JSON.stringify({ namespace: this.namespace, credentials });
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw fail();
    return serialized;
  }
  async #write(credentials: CredentialMetadata[]) {
    const serialized = this.#serialize(credentials);
    if (process.platform === 'win32') { this.#memoryMetadata = structuredClone(credentials); return; }
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(serialized); await file.sync(); await file.close(); file = undefined;
      await rename(temp, this.#path);
      let directory: Awaited<ReturnType<typeof open>> | undefined;
      try { directory = await open(path.dirname(this.#path), constants.O_RDONLY | constants.O_NOFOLLOW); await directory.sync(); }
      catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error; }
      finally { await directory?.close(); }
    } finally { await file?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  }
  async create(input: { label: string; value: string; origins: string[]; storage: CredentialStorage; kind?: Exclude<CredentialKind, 'oauth-bundle' | 'cookie-bundle'> }) {
    if (input.kind !== undefined && !['secret', 'oauth-client-secret'].includes(input.kind)) throw fail();
    return this.#create(input, input.kind ?? 'secret');
  }
  async createOAuthBundle(input: { label: string; value: string; origins: string[]; storage: CredentialStorage }) { return this.#create(input, 'oauth-bundle'); }
  async createCookieBundle(input: { label: string; value: string; origins: string[]; storage: CredentialStorage }) { return this.#create(input, 'cookie-bundle'); }
  async #create(input: { label: string; value: string; origins: string[]; storage: CredentialStorage }, kind: CredentialKind) {
    return this.#exclusive(async () => {
      if (process.platform === 'win32' && input.storage === 'keychain') throw fail();
      if (typeof input.value !== 'string' || !input.value || Buffer.byteLength(input.value) > 64 * 1024) throw fail();
      const id = randomUUID(); const metadata = this.#metadata({ ...input, kind, id, reference: `{{secret:${id}}}` });
      if (process.platform !== 'win32') await this.#directory(true);
      const entries = await this.#read();
      this.#serialize([...entries, metadata]); // Validate before creating a native value.
      if (metadata.storage === 'session') this.#session.set(id, input.value); else await this.#provider.set(this.namespace, id, input.value);
      try { await this.#write([...entries, metadata]); } catch { if (metadata.storage === 'session') this.#session.delete(id); else await this.#provider.delete(this.namespace, id).catch(() => {}); throw fail(); }
      return structuredClone(metadata);
    });
  }
  async list() { return this.#exclusive(async () => structuredClone(await this.#read())); }
  async updateOrigins(idOrRef: string, origins: string[]) { return this.#exclusive(async () => {
    const entries = await this.#read(); const current = this.#find(entries, idOrRef);
    const updated = this.#metadata({ ...current, origins });
    await this.#write(entries.map(m => m.id === current.id ? updated : m));
    return structuredClone(updated);
  }); }
  async delete(idOrRef: string) { return this.#exclusive(async () => {
    const entries = await this.#read(); const m = this.#find(entries, idOrRef);
    if (m.storage === 'session') this.#session.delete(m.id); else await this.#provider.delete(this.namespace, m.id);
    await this.#write(entries.filter(e => e.id !== m.id));
  }); }
  #find(entries: CredentialMetadata[], ref: string) { const id = secretReferencePattern.exec(ref)?.[1] ?? ref; const m = entries.find(e => e.id === id); if (!m) throw fail(); return m; }
  async resolve(ref: string, origin: string) { return this.#resolve(ref, origin, 'secret'); }
  async resolveClientSecret(ref: string, origin: string) { return this.#resolve(ref, origin, 'oauth-client-secret'); }
  async resolveCookieBundle(ref: string, origin: string) { return this.#resolve(ref, origin, 'cookie-bundle'); }
  async resolveOAuthBundle(ref: string, origin: string) { return this.#resolve(ref, origin, 'oauth-bundle'); }
  async #resolve(ref: string, origin: string, kind: CredentialKind) { return this.#exclusive(async () => {
    const m = this.#find(await this.#read(), ref);
    if (m.kind !== kind || !m.origins.includes(credentialOrigin(origin))) throw fail();
    const value = m.storage === 'session' ? this.#session.get(m.id) : await this.#provider.get(this.namespace, m.id);
    if (typeof value !== 'string' || Buffer.byteLength(value) > 64 * 1024) throw fail(); return value;
  }); }
  async replaceCookieBundle(id: string, value: string) { return this.#replaceBundle(id, value, 'cookie-bundle'); }
  async replaceOAuthBundle(id: string, value: string) { return this.#replaceBundle(id, value, 'oauth-bundle'); }
  async #replaceBundle(id: string, value: string, kind: CredentialKind) { return this.#exclusive(async () => {
    if (!value || Buffer.byteLength(value) > 64 * 1024) throw fail();
    const m = this.#find(await this.#read(), id); if (m.kind !== kind) throw fail();
    if (m.storage === 'session') this.#session.set(m.id, value); else await this.#provider.set(this.namespace, m.id, value);
  }); }
}
