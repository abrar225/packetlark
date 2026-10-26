import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { WorkspaceRepository } from '../src/core/workspace/WorkspaceRepository.js';

const roots: string[] = [];
const secret = 'cli-inline-sensitive-fixture';
const reference = '{{secret:11111111-1111-4111-8111-111111111111}}';
function fixture(migrated = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-cli-export-')); roots.push(base);
  const root = path.join(base, '.rea-api');
  const repo = new WorkspaceRepository(root);
  repo.persistEnvironment('export-env', { id: 'export-env', name: 'Export fixture', values: [
    { key: 'apiKey', value: secret, enabled: true },
    { key: 'password', value: reference, enabled: true },
  ] }, null);
  if (migrated) repo.migrate(repo.migrationPlan().checksum);
  repo.close();
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  const call = async (command: string, ...flags: string[]) => {
    expect(await main(['workspace', command, '--workspace', base, ...flags])).toBe(0);
    return JSON.parse(String(logs.mock.calls.at(-1)![0]));
  };
  return { base, root, call };
}
function read(root: string) { return new WorkspaceRepository(root, { readOnly: true }); }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('redacts snapshots without changing source credentials or inert references', async () => {
  const { root, call } = fixture();
  const safe = await call('snapshot');
  expect(JSON.stringify(safe)).not.toContain(secret);
  expect(JSON.stringify(safe)).toContain(reference);
  expect(JSON.stringify(await call('snapshot', '--include-secrets', '--consent', 'plaintext'))).toContain(secret);
  const repo = read(root);
  try { expect(JSON.stringify(repo.snapshot())).toContain(secret); } finally { repo.close(); }
});

it.each([
  ['--include-secrets'], ['--consent', 'plaintext'], ['--include-secrets', '--consent', 'yes'],
])('rejects incomplete or invalid raw export consent %j', async (...flags) => {
  const { call, base } = fixture();
  await expect(call('snapshot', ...flags)).rejects.toThrow(/consent plaintext/);
  const destination = path.join(base, 'blocked.json');
  await expect(call('backup', '--backup-file', destination, ...flags)).rejects.toThrow(/consent plaintext/);
  expect(fs.existsSync(destination)).toBe(false);
});

it('writes safe restorable envelopes with a checksum of the projected payload and private exclusive files', async () => {
  const { root, base, call } = fixture();
  const destination = path.join(base, 'safe.json');
  const result = await call('backup', '--backup-file', destination);
  const backup = WorkspaceRepository.readBackup(destination);
  expect(fs.readFileSync(destination, 'utf8')).not.toContain(secret);
  expect(backup.payload).toContain(reference);
  expect(backup.checksum).toBe(createHash('sha256').update(backup.payload).digest('hex'));
  expect(result.checksum).toBe(backup.checksum);
  expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
  const repo = read(root);
  try { expect(repo.restorePlan(backup).checksum).toBe(backup.checksum); } finally { repo.close(); }
  const original = fs.readFileSync(destination, 'utf8');
  await expect(call('backup', '--backup-file', destination)).rejects.toThrow();
  expect(fs.readFileSync(destination, 'utf8')).toBe(original);
  const raw = path.join(base, 'raw.json');
  await call('backup', '--backup-file', raw, '--include-secrets', '--consent', 'plaintext');
  expect(WorkspaceRepository.readBackup(raw).payload).toContain(secret);
});

it('requires consent before lossless migration recovery backup and explains it in the preview', async () => {
  const { root, call } = fixture();
  const plan = await call('migrate');
  expect(plan.recoveryBackup.plaintextBackupConsentRequired).toBe(true);
  expect(plan.recoveryBackup.inlineCredentialCandidates).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(plan)).not.toContain(secret);
  const retained = () => fs.readdirSync(root).filter(name => /^backup-/.test(name));
  expect(retained()).toEqual([]);
  await expect(call('migrate', '--apply', '--checksum', plan.checksum)).rejects.toThrow(/--consent plaintext/);
  expect(retained()).toEqual([]);
  await call('migrate', '--apply', '--checksum', plan.checksum, '--consent', 'plaintext');
  expect(WorkspaceRepository.readBackup(path.join(root, retained()[0])).payload).toContain(secret);
});

it('gates pre-restore backup of current secrets and redacts the applied snapshot result', async () => {
  const { root, base, call } = fixture(true);
  const destination = path.join(base, 'restore.json');
  await call('backup', '--backup-file', destination, '--include-secrets', '--consent', 'plaintext');
  const plan = await call('restore', '--backup-file', destination);
  expect(plan.recoveryBackup.plaintextBackupConsentRequired).toBe(true);
  expect(JSON.stringify(plan)).not.toContain(secret);
  const flags = ['--backup-file', destination, '--apply', '--checksum', plan.checksum, '--revision', plan.revision];
  await expect(call('restore', ...flags)).rejects.toThrow(/--consent plaintext/);
  const result = await call('restore', ...flags, '--consent', 'plaintext');
  expect(JSON.stringify(result)).not.toContain(secret);
  const repo = read(root);
  try { expect(JSON.stringify(repo.snapshot())).toContain(secret); } finally { repo.close(); }
});
