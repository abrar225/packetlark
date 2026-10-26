import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, chmod, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore, type CredentialProvider } from '../src/core/security/CredentialStore.js';

const dirs: string[] = [];
async function fixture(workspaceId = 'workspace-A', provider?: CredentialProvider) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rea-vault-'))); dirs.push(dir);
  return { dir, store: new CredentialStore({ workspaceId, metadataPath: path.join(dir, 'metadata.json'), provider }) };
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('credential lifecycle', () => {
  it('keeps session values off disk and enforces purpose, workspace and origin', async () => {
    const { dir, store } = await fixture(); const seed = 'SEEDED-SECRET-do-not-leak';
    const m = await store.create({ label: 'test', value: seed, origins: ['https://api.test/path'], storage: 'session' });
    expect(m.reference).toMatch(/^\{\{secret:/); expect(await store.resolve(m.reference, 'https://api.test/other')).toBe(seed);
    expect(await readFile(path.join(dir, 'metadata.json'), 'utf8')).not.toContain(seed);
    expect((await stat(path.join(dir, 'metadata.json'))).mode & 0o777).toBe(0o600);
    await expect(store.resolve(m.reference, 'https://evil.test')).rejects.toThrow('Credential operation failed');
    await expect(store.resolveClientSecret(m.reference, 'https://api.test')).rejects.toThrow();
    const other = new CredentialStore({ workspaceId: 'other', metadataPath: path.join(dir, 'metadata.json') });
    await expect(other.list()).rejects.toThrow();
    const restarted = new CredentialStore({ workspaceId: 'workspace-A', metadataPath: path.join(dir, 'metadata.json') });
    await expect(restarted.resolve(m.reference, 'https://api.test')).rejects.toThrow();
    await store.delete(m.id); expect(await store.list()).toEqual([]);
  });
  it('makes native-provider errors generic and never falls back to disk/session', async () => {
    const seed = 'native-secret'; const { store, dir } = await fixture('test', { get: async () => { throw new Error(seed); }, set: async () => { throw new Error(seed); }, delete: async () => {} });
    await expect(store.create({ label: 'keychain', value: seed, origins: ['https://api.test'], storage: 'keychain' })).rejects.toThrow(/^Credential operation failed$/);
    expect(await store.list()).toEqual([]);
    await expect(readFile(path.join(dir, 'metadata.json'))).rejects.toThrow();
  });
  it('supports persistent provider reopen and atomic OAuth bundles without generic injection', async () => {
    const values = new Map<string, string>(); const provider = { get: async (n, i) => values.get(n + i)!, set: async (n, i, v) => { values.set(n + i, v); }, delete: async (n, i) => { values.delete(n + i); } };
    const { dir, store } = await fixture('persist', provider); const m = await store.createOAuthBundle({ label: 'oauth', value: '{"access":"AAA","refresh":"RRR"}', origins: ['https://api.test'], storage: 'keychain' });
    await expect(store.resolve(m.reference, 'https://api.test')).rejects.toThrow();
    await expect(store.create({ label: 'bypass', value: 'bad', origins: ['https://api.test'], storage: 'session', kind: 'oauth-bundle' as any })).rejects.toThrow();
    await store.replaceOAuthBundle(m.id, '{"access":"BBB","refresh":"SSS"}');
    const reopened = new CredentialStore({ workspaceId: 'persist', metadataPath: path.join(dir, 'metadata.json'), provider });
    expect(await reopened.resolveOAuthBundle(m.reference, 'https://api.test')).toContain('BBB');
    expect(JSON.stringify(await reopened.list())).not.toContain('BBB');
    await reopened.delete(m.id); expect(values.size).toBe(0);
  });
  it('rejects symlink metadata, weak permissions and oversized input', async () => {
    const { dir, store } = await fixture(); const target = path.join(dir, 'target'); await writeFile(target, '{}', { mode: 0o600 });
    await symlink(target, path.join(dir, 'metadata.json')); await expect(store.list()).rejects.toThrow();
    await rm(path.join(dir, 'metadata.json')); await chmod(dir, 0o755); await expect(store.list()).rejects.toThrow(); await chmod(dir, 0o700);
    await expect(store.create({ label: 'oversize', value: 'a'.repeat(65537), origins: ['https://api.test'], storage: 'session' })).rejects.toThrow();
  });
});

import { scanCredentialCandidates, credentialMigrationValue, projectCredentialMigration, safeCredentialExport } from '../src/core/security/CredentialMigration.js';
describe('reviewed migration projections', () => {
  it('scans metadata only, produces detached refs and preserves the source', () => {
    const source = { auth: { bearerToken: 'SEEDED-BEARER' }, variables: [{ key: 'api_key', value: 'SEEDED-KEY' }, { key: 'public', value: 'visible' }], body: { raw: '{"password":"SEEDED-BODY"}' }, url: 'https://user:SEEDED-PASS@api.test?token=SEEDED-QUERY' };
    const before = JSON.stringify(source); const candidates = scanCredentialCandidates(source); expect(JSON.stringify(candidates)).not.toContain('SEEDED'); expect(candidates).toHaveLength(2);
    expect(credentialMigrationValue(source, '/auth/bearerToken')).toBe('SEEDED-BEARER');
    const ref = '{{secret:11111111-1111-4111-8111-111111111111}}';
    const projected = projectCredentialMigration(source, [{ pointer: '/auth/bearerToken', reference: ref }]); expect(projected.auth.bearerToken).toBe(ref); expect(JSON.stringify(source)).toBe(before);
    expect(JSON.stringify(safeCredentialExport(source))).not.toContain('SEEDED'); expect(safeCredentialExport(projected).auth.bearerToken).toBe(ref);
    expect(() => projectCredentialMigration(source, [{ pointer: '/__proto__/x', reference: ref }])).toThrow();
  });
  it('updates bindings without exposing or changing raw values', async () => {
    const { store } = await fixture(); const m = await store.create({ label: 'binding', value: 'SEEDED-BOUND', origins: ['https://old.test'], storage: 'session' });
    const updated = await store.updateOrigins(m.id, ['https://new.test/path']); expect(updated.origins).toEqual(['https://new.test']); expect(JSON.stringify(updated)).not.toContain('SEEDED');
    await expect(store.resolve(m.reference, 'https://old.test')).rejects.toThrow(); expect(await store.resolve(m.reference, 'https://new.test')).toBe('SEEDED-BOUND');
  });
});

describe('security regression cases', () => {
  it('preserves references while structurally redacting JSON escapes and arbitrary URL encoding', () => {
    const ref = '{{secret:11111111-1111-4111-8111-111111111111}}';
    const exported = safeCredentialExport({ body: { raw: JSON.stringify({ password: 'a"b\\c', refresh_token: ref, publicCopy: 'a"b\\c' }) }, url: 'https://api.test?token=%73%65%65%64', other: { url: 'https://api.test?token=' + ref }, headers: [{ key: 'Authorization', value: 'Bearer ' + ref }] });
    const raw = JSON.parse(exported.body.raw); expect(raw.password).toBe('[REDACTED]'); expect(raw.publicCopy).not.toContain('a"b\\c'); expect(raw.refresh_token).toBe(ref);
    expect(new URL(exported.url).searchParams.get('token')).toBe('[REDACTED]'); expect(new URL(exported.other.url).searchParams.get('token')).toBe(ref); expect(exported.headers[0].value).toContain(ref);
  });
  it('rejects duplicate metadata IDs instead of picking ambiguous bindings', async () => {
    const { dir, store } = await fixture(); const m = await store.create({ label: 'original', value: 'SEEDED', origins: ['https://api.test'], storage: 'session' });
    const filename = path.join(dir, 'metadata.json'); const data = JSON.parse(await readFile(filename, 'utf8')); data.credentials.push({ ...m, origins: ['https://evil.test'] }); await writeFile(filename, JSON.stringify(data));
    await expect(store.list()).rejects.toThrow(); await expect(store.resolve(m.reference, 'https://api.test')).rejects.toThrow();
  });
  it('does not create directories on missing-store reads or updates', async () => {
    const { dir } = await fixture(); const missing = path.join(dir, 'not-created'); const store = new CredentialStore({ workspaceId: 'missing', metadataPath: path.join(missing, 'metadata.json') });
    expect(await store.list()).toEqual([]); await expect(store.resolve('unknown', 'https://api.test')).rejects.toThrow(); await expect(store.updateOrigins('unknown', ['https://api.test'])).rejects.toThrow();
    await expect(stat(missing)).rejects.toThrow();
  });
  it('preflights metadata bytes before native values are created and bounds origins', async () => {
    let sets = 0; const { store } = await fixture('bounds', { get: async () => '', set: async () => { sets++; }, delete: async () => {} });
    const origins = Array.from({ length: 64 }, (_, i) => `https://${'a'.repeat(7900)}${i}.test`);
    await store.create({ label: 'one', value: 'VALUE1', origins, storage: 'keychain' }); await store.create({ label: 'two', value: 'VALUE2', origins, storage: 'keychain' });
    await expect(store.create({ label: 'three', value: 'VALUE3', origins, storage: 'keychain' })).rejects.toThrow(); expect(sets).toBe(2); expect(await store.list()).toHaveLength(2);
    await expect(store.updateOrigins((await store.list())[0].id, ['https://' + 'a'.repeat(9000)])).rejects.toThrow();
  });
  it('keeps cookie bundles purpose-isolated from generic secrets and OAuth', async () => {
    const { store } = await fixture(); const m = await store.createCookieBundle({ label: 'cookies', value: 'SEEDED-COOKIE', origins: ['https://api.test'], storage: 'session' });
    expect(await store.resolveCookieBundle(m.id, 'https://api.test')).toBe('SEEDED-COOKIE'); await expect(store.resolve(m.reference, 'https://api.test')).rejects.toThrow(); await expect(store.resolveOAuthBundle(m.id, 'https://api.test')).rejects.toThrow();
    await store.replaceCookieBundle(m.id, 'ROTATED-COOKIE'); expect(await store.resolveCookieBundle(m.id, 'https://api.test')).toBe('ROTATED-COOKIE'); await expect(store.replaceOAuthBundle(m.id, 'WRONG')).rejects.toThrow();
    await expect(store.create({ label: 'bypass', value: 'VALUE', origins: ['https://api.test'], storage: 'session', kind: 'cookie-bundle' as any })).rejects.toThrow();
  });
});
