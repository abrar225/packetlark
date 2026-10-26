import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore } from '../src/core/security/CredentialStore.js';
import { OAuthService, type OAuthConfig } from '../src/core/security/OAuthService.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(timeout = 300000) {
  const requests: URLSearchParams[] = []; let mode = 'ok'; let refreshes = 0; let oidc: { nonce: string; badSignature?: boolean; keys: ReturnType<typeof generateKeyPairSync> } | undefined;
  const server = createServer(async (req, res) => {
    if (req.url === '/jwks' && oidc) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [{ ...oidc.keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body); requests.push(params);
    if (req.url === '/revoke') { res.writeHead(mode === 'revoke-fail' ? 500 : 200); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    if (mode === 'redirect') { res.writeHead(302, { location: base + '/capture' }); res.end(); return; }
    if (mode === 'invalid-token') { res.end(JSON.stringify({ token_type: 'Bearer', access_token: 'SEEDED-INVALID-TOKEN' })); return; }
    if (mode === 'fail') { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'SEEDED-ERROR-SECRET' })); return; }
    if (mode === 'oversize') { res.end('x'.repeat(140000)); return; }
    if (params.get('grant_type') === 'refresh_token') { refreshes++; await new Promise(r => setTimeout(r, 20)); }
    let id_token: string | undefined;
    if (oidc) { const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url'); const payload = b64({ alg: 'RS256', kid: 'fixture' }) + '.' + b64({ iss: base, aud: 'client', sub: 'fixture-user', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, nonce: oidc.nonce }); id_token = payload + '.' + (oidc.badSignature ? Buffer.from('bad-signature') : sign('RSA-SHA256', Buffer.from(payload), oidc.keys.privateKey)).toString('base64url'); }
    res.end(JSON.stringify({ id_token, access_token: `SEEDED-ACCESS-${refreshes}`, refresh_token: `SEEDED-REFRESH-${refreshes}`, token_type: 'Bearer', expires_in: mode === 'short' ? 1 : 3600 }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rea-oauth-'))); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const metadataPath = path.join(dir, 'metadata.json'); const store = new CredentialStore({ workspaceId: dir, metadataPath });
  const service = new OAuthService(store, { callbackUrl: 'http://127.0.0.1:7777/api/oauth/callback', allowInsecureLoopbackForTests: true, flowTimeoutMs: timeout }); cleanup.push(async () => service.dispose());
  const secret = await store.create({ label: 'client', value: 'SEEDED-CLIENT-SECRET', origins: [base], storage: 'session', kind: 'oauth-client-secret' });
  const config: OAuthConfig = { label: 'test', issuer: base, authorizationEndpoint: base + '/authorize', tokenEndpoint: base + '/token', revocationEndpoint: base + '/revoke', jwksUri: base + '/jwks', clientId: 'client', clientSecretRef: secret.reference, allowedOrigins: ['https://api.test'], storage: 'session', scope: 'read', environment: 'test', account: 'fixture' };
  const callback = (authorizationUrl: string, code = 'FIXTURE-CODE') => { const url = new URL('http://127.0.0.1:7777/api/oauth/callback'); url.searchParams.set('state', new URL(authorizationUrl).searchParams.get('state')!); url.searchParams.set('code', code); return url.href; };
  return { service, store, config, requests, callback, metadataPath, setOIDC: (nonce: string, badSignature = false) => { oidc = { nonce, badSignature, keys: generateKeyPairSync('rsa', { modulusLength: 2048 }) as any }; }, mode: (m: string) => { mode = m; }, refreshes: () => refreshes };
}
describe('OAuth fake-provider wire protocol', () => {
  it('performs code + PKCE, consumes state, binds origin and retains no secrets in metadata', async () => {
    const f = await fixture(); const flow = await f.service.start(f.config); const auth = new URL(flow.authorizationUrl);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256'); expect(auth.searchParams.get('nonce')).toBeTruthy();
    const m = await f.service.callbackForUrl(f.callback(flow.authorizationUrl));
    expect(await f.service.token(m.id, 'https://api.test')).toBe('SEEDED-ACCESS-0');
    expect(f.requests[0].get('grant_type')).toBe('authorization_code'); expect(f.requests[0].get('code_verifier')).toBeTruthy();
    await expect(f.service.callback(flow.flowId, f.callback(flow.authorizationUrl))).rejects.toThrow(/^OAuth operation failed$/);
    await expect(f.service.token(m.id, 'https://evil.test')).rejects.toThrow();
    await expect(f.store.resolve(m.reference, 'https://api.test')).rejects.toThrow();
    expect(await readFile(f.metadataPath, 'utf8')).not.toMatch(/SEEDED|FIXTURE-CODE|code_verifier/);
  });
  it('rejects state mismatch, callback route mismatch, denial, timeout and replay without token calls', async () => {
    const f = await fixture(15);
    for (const alter of [(url: string) => url.replace(/state=[^&]+/, 'state=wrong'), (url: string) => url.replace('/api/oauth/callback', '/other'), (url: string) => url.replace(/code=[^&]+/, 'error=access_denied')]) {
      const flow = await f.service.start(f.config); await expect(f.service.callback(flow.flowId, alter(f.callback(flow.authorizationUrl)))).rejects.toThrow();
    }
    const flow = await f.service.start(f.config); await new Promise(r => setTimeout(r, 25)); await expect(f.service.callback(flow.flowId, f.callback(flow.authorizationUrl))).rejects.toThrow(); expect(f.requests).toHaveLength(0);
  });
  it('refreshes once for concurrent calls and keeps rotated tokens atomic', async () => {
    const f = await fixture(); f.mode('short'); const flow = await f.service.start(f.config); const m = await f.service.callback(flow.flowId, f.callback(flow.authorizationUrl));
    f.mode('ok'); const tokens = await Promise.all(Array.from({ length: 8 }, (_, i) => f.service.token(i % 2 ? m.id : m.reference, 'https://api.test')));
    expect(new Set(tokens)).toEqual(new Set(['SEEDED-ACCESS-1'])); expect(f.refreshes()).toBe(1);
    const bundle = JSON.parse(await f.store.resolveOAuthBundle(m.id, 'https://api.test')); expect(bundle.refreshToken).toBe('SEEDED-REFRESH-1');
    expect(await readFile(f.metadataPath, 'utf8')).not.toContain('SEEDED');
  });
  it('supports client credentials, explicit remote revoke failure retention and local clear', async () => {
    const f = await fixture(); const m = await f.service.clientCredentials(f.config); expect(f.requests[0].get('grant_type')).toBe('client_credentials'); expect(f.requests[0].get('client_secret')).toBe('SEEDED-CLIENT-SECRET');
    f.mode('revoke-fail'); await expect(f.service.revoke(m.id)).rejects.toThrow(); expect(await f.service.list()).toHaveLength(1);
    f.mode('ok'); await f.service.revoke(m.id); expect(await f.service.list()).toHaveLength(0);
    const next = await f.service.clientCredentials(f.config); const calls = f.requests.length; await f.service.clear(next.id); expect(f.requests).toHaveLength(calls);
  });
  it('sanitizes provider failures and bounds token responses', async () => {
    const f = await fixture(); f.mode('fail'); await expect(f.service.clientCredentials(f.config)).rejects.toThrow(/^OAuth operation failed$/);
    f.mode('oversize'); await expect(f.service.clientCredentials(f.config)).rejects.toThrow(/^OAuth operation failed$/);
    expect(await f.service.list()).toEqual([]);
  });
  it('requires HTTPS outside explicit disposable loopback fixtures', async () => {
    const f = await fixture(); const production = new OAuthService(f.store, { callbackUrl: 'http://127.0.0.1:7777/api/oauth/callback' });
    await expect(production.start(f.config)).rejects.toThrow(); production.dispose();
  });
  it('rejects failed refresh without replacing stored rotation state', async () => {
    const f = await fixture(); f.mode('short'); const flow = await f.service.start(f.config); const m = await f.service.callback(flow.flowId, f.callback(flow.authorizationUrl));
    const before = await f.store.resolveOAuthBundle(m.id, 'https://api.test'); f.mode('fail');
    await expect(f.service.token(m.id, 'https://api.test')).rejects.toThrow(/^OAuth operation failed$/);
    expect(await f.store.resolveOAuthBundle(m.id, 'https://api.test')).toBe(before);
  });
  it('requires provider-origin binding on client secrets', async () => {
    const f = await fixture(); const wrong = await f.store.create({ label: 'other provider', value: 'SEEDED-WRONG-PROVIDER', origins: ['https://other.test'], storage: 'session', kind: 'oauth-client-secret' });
    await expect(f.service.clientCredentials({ ...f.config, clientSecretRef: wrong.reference })).rejects.toThrow(); expect(f.requests).toHaveLength(0);
  });
  it('validates OIDC nonce and JWKS signature using the standards library', async () => {
    const f = await fixture();
    for (const scenario of ['valid', 'wrong-nonce', 'bad-signature']) {
      const flow = await f.service.start({ ...f.config, scope: 'openid read' }); const nonce = new URL(flow.authorizationUrl).searchParams.get('nonce')!;
      f.setOIDC(scenario === 'wrong-nonce' ? 'wrong' : nonce, scenario === 'bad-signature');
      const result = f.service.callback(flow.flowId, f.callback(flow.authorizationUrl));
      if (scenario === 'valid') expect((await result).kind).toBe('oauth-bundle'); else await expect(result).rejects.toThrow(/^OAuth operation failed$/);
    }
    expect(await f.service.list()).toHaveLength(1);
  });

  it('waits for in-flight refresh before revoking the rotated pair and blocks new token callers', async () => {
    const f = await fixture(); f.mode('short'); const flow = await f.service.start(f.config); const m = await f.service.callback(flow.flowId, f.callback(flow.authorizationUrl));
    f.mode('ok'); const refreshing = f.service.token(m.id, 'https://api.test').then(() => 'token', () => 'closed');
    for (let i = 0; i < 100 && f.refreshes() === 0; i++) await new Promise(r => setTimeout(r, 1)); expect(f.refreshes()).toBe(1);
    const revoke = f.service.revoke(m.reference); await new Promise(r => setTimeout(r, 1));
    await expect(f.service.token(m.id, 'https://api.test')).rejects.toThrow(); await revoke; expect(await refreshing).toBe('closed');
    const revoked = f.requests.filter(p => p.has('token')).map(p => p.get('token')); expect(revoked).toEqual(['SEEDED-REFRESH-1', 'SEEDED-ACCESS-1']); expect(await f.service.list()).toEqual([]);
  });

  it('does not persist invalid token responses or follow token-endpoint redirects', async () => {
    const f = await fixture(); const initial = await f.store.list(); f.mode('invalid-token');
    const flow = await f.service.start(f.config); await expect(f.service.callback(flow.flowId, f.callback(flow.authorizationUrl))).rejects.toThrow(/^OAuth operation failed$/);
    await expect(f.service.callback(flow.flowId, f.callback(flow.authorizationUrl))).rejects.toThrow(); expect(await f.store.list()).toEqual(initial);
    const before = f.requests.length; f.mode('redirect'); await expect(f.service.clientCredentials(f.config)).rejects.toThrow(/^OAuth operation failed$/); expect(f.requests.length - before).toBe(1); expect(await f.store.list()).toEqual(initial);
  });

});
