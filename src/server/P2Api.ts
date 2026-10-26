import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import { once } from 'node:events';
import { WorkspaceExecution } from '../core/engine/WorkspaceExecution.js';
import { validateJsonBody } from '../core/engine/JsonBodyValidation.js';
import { credentialOrigin } from '../core/security/CredentialStore.js';
import { scanCredentialCandidates, credentialMigrationValue, projectCredentialMigration, safeCredentialExport } from '../core/security/CredentialMigration.js';

const cookieOrigin = 'https://rea-cookie-store.invalid';
const bad = (message: string, code = 'ERR_P2_SETTINGS', statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
type CookieSettings = { enabled: boolean; credentialId?: string };
interface MigrationPlan { kind: 'collections' | 'environments'; id: string; revision: string; source: any; origins: string[]; storage: 'session' | 'keychain'; expires: number }

/** Studio adapter. It never exposes credential values or accepts imported file paths. */
export class P2Api {
  #plans = new Map<string, MigrationPlan>();
  #cookieSettings: CookieSettings = { enabled: false };
  #cookieError?: string;
  #ready?: Promise<void>;
  #cookieTail: Promise<void> = Promise.resolve();
  #cookieStalled = false;
  #cookiePending = 0;
  #cookieRun<T>(work: () => Promise<T>): Promise<T> {
    if (this.#cookieStalled || this.#cookiePending >= 8) return Promise.reject(bad('A prior cookie operation is still pending. Its outcome is unknown; review it before retrying.', 'ERR_COOKIE_PENDING', 503));
    this.#cookiePending++;
    const operation = this.#cookieTail.then(work);
    this.#cookieTail = operation.then(() => {}, () => {}).finally(() => { this.#cookiePending--; if (!this.#cookiePending) this.#cookieStalled = false; });
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { this.#cookieStalled = true; reject(bad('Cookie storage did not finish within its deadline. The operation may still complete; review before retrying.', 'ERR_COOKIE_PENDING', 503)); }, this.cookieWaitMs); timer.unref();
    })]).finally(() => clearTimeout(timer));
  }
  constructor(readonly context: WorkspaceExecution, readonly baseUrl: string, readonly workspace: {
    assertOwned(): void;
    snapshot(): { collections: any[]; environments: any[] };
    commit(kind: 'collections' | 'environments', value: any, revision: string): void;
  }, readonly cookieWaitMs = 10000) {}
  async idle() { await this.#cookieTail; }
  #configFile() { return path.join(this.context.workspaceRoot, 'private-credentials', 'cookies-v1.json'); }
  #readConfig(): CookieSettings {
    const file = this.#configFile();
    if (!fs.existsSync(file)) return { enabled: false };
    const dir = path.dirname(file), stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw bad('Cookie persistence configuration is unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.size > 4096 || (process.platform !== 'win32' && (s.mode & 0o077))) throw bad('Cookie persistence configuration is unsafe');
      const bytes = Buffer.alloc(4097), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (count > 4096) throw bad('Cookie persistence configuration is too large');
      const settings = JSON.parse(bytes.subarray(0, count).toString());
      if (typeof settings.enabled !== 'boolean' || (settings.credentialId !== undefined && !/^[a-f0-9-]{36}$/.test(settings.credentialId))) throw bad('Cookie persistence configuration is invalid');
      return { enabled: settings.enabled, credentialId: settings.credentialId };
    } finally { fs.closeSync(fd); }
  }
  #writeConfig(settings: CookieSettings) {
    this.workspace.assertOwned();
    const file = this.#configFile(), directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw bad('Cookie persistence configuration is unsafe');
    const temp = file + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(settings)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(temp, file); const directoryFd = fs.openSync(directory, 'r'); try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); } }
    finally { try { fs.unlinkSync(temp); } catch {} }
    this.#cookieSettings = settings;
  }
  async ready() {
    this.#ready ??= (async () => {
      try {
        this.#cookieSettings = this.#readConfig();
        if (this.#cookieSettings.enabled) {
          if (!this.#cookieSettings.credentialId) throw bad('Saved cookie credential is missing');
          let timer: ReturnType<typeof setTimeout>;
          const text = await Promise.race([
            this.context.credentials.resolveCookieBundle(this.#cookieSettings.credentialId, cookieOrigin),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(bad('Credential store read timed out')), 10000); timer.unref(); }),
          ]).finally(() => clearTimeout(timer));
          if (Buffer.byteLength(text) > 64 * 1024) throw bad('Saved cookies exceed 64 KiB');
          const { CookieJar } = await import('tough-cookie');
          this.context.cookies.jar = await CookieJar.deserialize(JSON.parse(text));
        }
      } catch { this.#cookieError = 'Saved cookies are unavailable. Disable persistence explicitly or reconnect the OS credential store before sending.'; }
    })();
    await this.#ready;
  }
  async executionOptions(stream = false) {
    await this.ready();
    if (this.#cookieError) throw bad(this.#cookieError, 'ERR_COOKIE_STORAGE', 409);
    return { ...await this.context.options({ stream, forbiddenOrigins: [this.baseUrl, this.baseUrl.replace('127.0.0.1', 'localhost'), cookieOrigin] }), cookieJar: this.context.cookies.jar };
  }
  saveCookies() { return this.#cookieRun(() => this.#saveCookies()); }
  async #saveCookies() {
    await this.ready();
    if (!this.#cookieSettings.enabled) return;
    const serialized = JSON.stringify(await this.context.cookies.jar.serialize());
    if (Buffer.byteLength(serialized) > 64 * 1024) throw bad('Cookie persistence is limited to 64 KiB');
    const id = this.#cookieSettings.credentialId;
    if (id) await this.context.credentials.replaceCookieBundle(id, serialized);
    else {
      const stored = await this.context.credentials.createCookieBundle({ label: 'Persisted HTTP cookies', value: serialized, origins: [cookieOrigin], storage: 'keychain' });
      try { this.#writeConfig({ enabled: true, credentialId: stored.id }); }
      catch (error) { await this.context.credentials.delete(stored.id).catch(() => {}); throw error; }
    }
  }
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, readBody: () => Promise<any>): Promise<boolean> {
    const p = url.pathname;
    if (!/^\/api\/(credentials|oauth|files|responses|cookies|validate\/json)(\/|$)/.test(p)) return false;
    this.workspace.assertOwned();
    const send = (data: any, status = 200) => { if (res.writableEnded || res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    const store = this.context.credentials;
    if (p === '/api/validate/json' && req.method === 'POST') {
      const body = await readBody();
      try { await validateJsonBody(body.raw, body.schema); send({ valid: true }); }
      catch (error) { send({ valid: false, error: { message: error.message, code: error.code } }, error.statusCode ?? 400); }
      return true;
    }
    if (p === '/api/credentials' && req.method === 'GET') { send({ credentials: (await store.list()).filter(m => ['secret', 'oauth-client-secret'].includes(m.kind)) }); return true; }
    if (p === '/api/credentials' && req.method === 'POST') { const body = await readBody(); send(await store.create(body)); return true; }
    const credential = p.match(/^\/api\/credentials\/([a-f0-9-]{36})$/);
    if (credential && ['PATCH', 'DELETE'].includes(req.method ?? '')) {
      const entry = (await store.list()).find(m => m.id === credential[1]);
      if (!entry || !['secret', 'oauth-client-secret'].includes(entry.kind)) throw bad('Credential not found', 'ERR_CREDENTIAL_NOT_FOUND', 404);
      if (req.method === 'DELETE') { await store.delete(entry.id); send({ ok: true }); }
      else { const body = await readBody(); send(await store.updateOrigins(entry.id, body.origins)); }
      return true;
    }
    if (p === '/api/credentials/migration/preview' && req.method === 'POST') {
      const body = await readBody(); if (!['collections', 'environments'].includes(body.kind)) throw bad('Choose a collection or environment');
      const source = this.workspace.snapshot()[body.kind].find((value: any) => value.id === body.id);
      if (!source) throw bad('Workspace resource not found', 'ERR_RESOURCE_NOT_FOUND', 404);
      const origins = [...new Set((body.origins || []).map(credentialOrigin))] as string[];
      if (!origins.length || origins.length > 64 || !['session', 'keychain'].includes(body.storage)) throw bad('Choose explicit origins and credential storage');
      for (const [id, plan] of this.#plans) if (plan.expires < Date.now()) this.#plans.delete(id);
      if (this.#plans.size >= 16) throw bad('Sixteen migration reviews are pending', 'ERR_MIGRATION_LIMIT', 429);
      const planId = randomUUID(); this.#plans.set(planId, { source, revision: source.revision, kind: body.kind, id: body.id, origins, storage: body.storage, expires: Date.now() + 300000 });
      send({ planId, revision: source.revision, fields: scanCredentialCandidates(source), storage: body.storage, warning: 'Only the selected current resource is replaced. Existing files/history/backups may retain plaintext and are never silently deleted. Session references stop resolving after server exit; persistent migration should use an available OS keychain.' }); return true;
    }
    if (p === '/api/credentials/migration/apply' && req.method === 'POST') {
      const body = await readBody(), plan = this.#plans.get(body.planId);
      if (!plan || plan.expires < Date.now() || body.consent !== true || (plan.storage === 'session' && body.sessionLossConsent !== true)) throw bad('Review a current migration plan and explicitly acknowledge its storage/recovery consequences');
      this.#plans.delete(body.planId);
      const current = this.workspace.snapshot()[plan.kind].find(value => value.id === plan.id);
      if (!current || current.revision !== plan.revision) throw bad('Resource changed; review a new migration plan', 'ERR_WORKSPACE_CONFLICT', 412);
      const all = scanCredentialCandidates(plan.source);
      const fields = body.fields ?? all.map(field => field.pointer);
      if (!Array.isArray(fields) || !fields.length || new Set(fields).size !== fields.length || fields.some(pointer => !all.some(field => field.pointer === pointer))) throw bad('Select reviewed credential fields');
      const replacements: { pointer: string; reference: string }[] = [];
      const created: string[] = [];
      try {
        for (const pointer of fields) { const value = credentialMigrationValue(plan.source, pointer); const entry = await store.create({ label: `${plan.kind}/${plan.id}${pointer}`.slice(0, 200), value, storage: plan.storage, origins: plan.origins }); created.push(entry.id); replacements.push({ pointer, reference: entry.reference }); }
        const next = projectCredentialMigration(plan.source, replacements);
        this.workspace.commit(plan.kind, next, plan.revision);
        send({ ok: true, resource: next, created: created.length, recovery: 'The original source is preserved if commit fails. Existing historical copies are unchanged; new values resolve through the selected store.' });
      } catch (error) { for (const id of created) await store.delete(id).catch(() => {}); throw error; }
      return true;
    }
    if (p === '/api/oauth' && req.method === 'GET') { send({ connections: await this.context.oauth.list() }); return true; }
    if (p === '/api/oauth/start' && req.method === 'POST') { send(await this.context.oauth.start(await readBody())); return true; }
    if (p === '/api/oauth/client-credentials' && req.method === 'POST') { send(await this.context.oauth.clientCredentials(await readBody())); return true; }
    if (p === '/api/oauth/callback' && req.method === 'GET') {
      try { await this.context.oauth.callbackForUrl(this.baseUrl + p + url.search); res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end('Authorization complete. Close this window and select the stored connection in Rea.'); }
      catch { res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end('Authorization did not complete. Return to Rea to review or start a new attempt.'); }
      return true;
    }
    const oauth = p.match(/^\/api\/oauth\/([a-f0-9-]{36})\/(clear|revoke)$/);
    if (oauth && req.method === 'POST') { const body = await readBody(); if (body.consent !== true) throw bad('Confirm clearing local credentials or revoking provider tokens'); await this.context.oauth[oauth[2]](oauth[1]); send({ ok: true }); return true; }
    if (p === '/api/files' && req.method === 'POST') {
      const remaining = this.context.files.stats;
      const length = Number(req.headers['content-length']);
      if (!remaining.availableCount || (Number.isFinite(length) && length > remaining.availableBytes)) {
        req.resume(); send({ error: { code: 'ERR_FILE_LIMIT', message: 'Selected file storage limit reached. Remove an existing selection or choose a smaller file.' } }, 413); return true;
      }
      const controller = new AbortController(), abort = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', abort); req.on('aborted', abort);
      try { const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'upload.bin')); const file = await this.context.files.addStream(req, name, String(req.headers['content-type'] ?? 'application/octet-stream'), AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])); if (!res.destroyed) send(file); }
      finally { res.off('close', abort); req.off('aborted', abort); }
      return true;
    }
    const file = p.match(/^\/api\/files\/([a-f0-9-]{36})$/);
    if (file && req.method === 'DELETE') { await this.context.files.remove(file[1]); send({ ok: true }); return true; }
    const response = p.match(/^\/api\/responses\/([a-f0-9-]{36})$/);
    if (response && req.method === 'DELETE') { await this.context.artifacts.remove(response[1]); send({ ok: true }); return true; }
    if (response && req.method === 'GET') {
      const artifact = this.context.artifacts.get(response[1]), stream = artifact.open();
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': artifact.size, 'Content-Disposition': `attachment; filename="response-${response[1]}.bin"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      const close = () => stream.destroy(); res.on('close', close); stream.on('error', () => res.destroy());
      stream.pipe(res); await once(res, 'close'); res.off('close', close); return true;
    }
    if (p.startsWith('/api/cookies')) return this.#cookieRun(async () => {
      await this.ready();
      if (p === '/api/cookies' && req.method === 'GET') { const cookies = url.searchParams.get('url') ? await this.context.cookies.list(url.searchParams.get('url')) : (await this.context.cookies.jar.serialize()).cookies; send({ cookies, persistence: { ...this.#cookieSettings, storage: 'keychain', error: this.#cookieError } }); return true; }
      if (p === '/api/cookies' && req.method === 'PUT') { const body = await readBody(); if (typeof body.url !== 'string' || typeof body.cookie !== 'string' || body.cookie.length > 8192) throw bad('Enter an HTTP URL and bounded Set-Cookie value'); credentialOrigin(body.url); await this.context.cookies.set(body.url, body.cookie); await this.#saveCookies(); send({ ok: true }); return true; }
      if (p === '/api/cookies' && req.method === 'DELETE') { const body = await readBody(); await this.context.cookies.clear(body.url); await this.#saveCookies(); send({ ok: true }); return true; }
      if (p === '/api/cookies/persistence' && req.method === 'DELETE') {
        const body = await readBody(); if (body.consent !== true) throw bad('Confirm forgetting saved cookies');
        const id = this.#cookieSettings.credentialId;
        // Delete before forgetting its ID, so provider refusal leaves a retryable binding.
        if (id) await store.delete(id);
        this.#writeConfig({ enabled: false }); this.#cookieError = undefined;
        send({ ok: true, enabled: false, sessionCookiesRetained: true }); return true;
      }
      if (p === '/api/cookies/persistence' && req.method === 'POST') {
        const body = await readBody(); if (typeof body.enabled !== 'boolean' || body.consent !== true || (body.enabled && body.storage !== 'keychain')) throw bad('Explicit OS keychain persistence consent is required');
        if (!body.enabled) { this.#writeConfig({ ...this.#cookieSettings, enabled: false }); this.#cookieError = undefined; }
        else { const previous = this.#cookieSettings; this.#cookieSettings = { ...previous, enabled: true }; try { await this.#saveCookies(); this.#writeConfig(this.#cookieSettings); this.#cookieError = undefined; } catch (error) { this.#cookieSettings = previous; throw error; } }
        send({ ok: true, enabled: this.#cookieSettings.enabled }); return true;
      }
      send({ error: { message: 'Cookie route or method not found', code: 'ERR_ROUTE' } }, 404); return true;
    });
    send({ error: { message: 'P2 route or method not found', code: 'ERR_ROUTE' } }, 404); return true;
  }
  exportResource<T>(value: T, includeSecrets = false, consent = false): T {
    if (includeSecrets && !consent) throw bad('Explicit plaintext export consent is required');
    return includeSecrets ? structuredClone(value) : safeCredentialExport(value);
  }
}
