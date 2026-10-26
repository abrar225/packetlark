import * as oauth from 'oauth4webapi';
import { randomUUID } from 'node:crypto';
import { CredentialStore, credentialOrigin, secretReferencePattern, type CredentialStorage } from './CredentialStore.js';

export interface OAuthConfig {
  label: string; issuer: string; authorizationEndpoint?: string; tokenEndpoint: string; revocationEndpoint?: string; jwksUri?: string;
  clientId: string; clientSecretRef?: string; allowedOrigins: string[]; storage: CredentialStorage; scope?: string; environment?: string; account?: string;
}
interface Bundle { config: OAuthConfig; accessToken: string; refreshToken?: string; expiresAt: number; }
interface Flow { config: OAuthConfig; state: string; nonce: string; verifier: string; expiresAt: number; timer: ReturnType<typeof setTimeout>; }
const failure = () => new Error('OAuth operation failed');

/** All responses are metadata except token(), which is only for the request executor. */
export class OAuthService {
  #store: CredentialStore; #callback: URL; #flows = new Map<string, Flow>(); #refresh = new Map<string, Promise<string>>(); #closing = new Set<string>();
  #fetch: typeof fetch; #testHttp: boolean; #timeout: number;
  constructor(store: CredentialStore, options: { callbackUrl: string; fetch?: typeof fetch; allowInsecureLoopbackForTests?: boolean; flowTimeoutMs?: number }) {
    this.#store = store;
    try { this.#callback = new URL(options.callbackUrl); } catch { throw failure(); }
    if (this.#callback.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(this.#callback.hostname) || this.#callback.username || this.#callback.password || this.#callback.search || this.#callback.hash) throw failure();
    this.#fetch = options.fetch ?? fetch; this.#testHttp = options.allowInsecureLoopbackForTests === true;
    this.#timeout = Math.max(10, Math.min(options.flowTimeoutMs ?? 300000, 600000));
  }
  #endpoint(value: string) {
    if (typeof value !== 'string') throw failure();
    const url = new URL(value);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(this.#testHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) throw failure();
    return url.href;
  }
  #config(c: OAuthConfig): OAuthConfig {
    if (!c || typeof c.label !== 'string' || c.label.length > 200 || typeof c.clientId !== 'string' || !c.clientId || c.clientId.length > 2000 || !Array.isArray(c.allowedOrigins) || !c.allowedOrigins.length || c.allowedOrigins.length > 64 || !['session', 'keychain'].includes(c.storage) || (c.scope?.length ?? 0) > 4000 || (c.environment?.length ?? 0) > 200 || (c.account?.length ?? 0) > 200) throw failure();
    // Issuer identifiers are exact strings; URL.href would add an unintended trailing slash.
    this.#endpoint(c.issuer);
    // Allowlist fields deliberately: no pasted client secrets or tokens are retained.
    return { label: c.label, issuer: c.issuer, tokenEndpoint: this.#endpoint(c.tokenEndpoint), authorizationEndpoint: c.authorizationEndpoint ? this.#endpoint(c.authorizationEndpoint) : undefined, revocationEndpoint: c.revocationEndpoint ? this.#endpoint(c.revocationEndpoint) : undefined, jwksUri: c.jwksUri ? this.#endpoint(c.jwksUri) : undefined, clientId: c.clientId, clientSecretRef: c.clientSecretRef, allowedOrigins: [...new Set(c.allowedOrigins.map(credentialOrigin))], storage: c.storage, scope: c.scope, environment: c.environment, account: c.account };
  }
  #as(c: OAuthConfig): oauth.AuthorizationServer { return { issuer: c.issuer, authorization_endpoint: c.authorizationEndpoint, token_endpoint: c.tokenEndpoint, revocation_endpoint: c.revocationEndpoint, jwks_uri: c.jwksUri }; }
  #client(c: OAuthConfig): oauth.Client { return { client_id: c.clientId }; }
  async #auth(c: OAuthConfig, endpoint = c.tokenEndpoint) { return c.clientSecretRef ? oauth.ClientSecretPost(await this.#store.resolveClientSecret(c.clientSecretRef, credentialOrigin(endpoint))) : oauth.None(); }
  #options() {
    const wrapped: typeof fetch = async (input, init) => {
      this.#endpoint(String(input));
      const response = await this.#fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 128 * 1024) throw failure(); chunks.push(value); } }
      catch { await reader?.cancel().catch(() => {}); throw failure(); }
      return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    return { [oauth.customFetch]: wrapped, [oauth.allowInsecureRequests]: this.#testHttp };
  }
  async start(config: OAuthConfig) {
    try {
      const c = this.#config(config); if (!c.authorizationEndpoint || this.#flows.size >= 64) throw failure();
      const id = randomUUID(), state = oauth.generateRandomState(), nonce = oauth.generateRandomNonce(), verifier = oauth.generateRandomCodeVerifier();
      const url = new URL(c.authorizationEndpoint);
      for (const [k, v] of Object.entries({ client_id: c.clientId, redirect_uri: this.#callback.href, response_type: 'code', state, nonce, code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', scope: c.scope ?? '' })) url.searchParams.set(k, v);
      const timer = setTimeout(() => this.#flows.delete(id), this.#timeout); timer.unref();
      this.#flows.set(id, { config: c, state, nonce, verifier, expiresAt: Date.now() + this.#timeout, timer });
      return { flowId: id, authorizationUrl: url.href, expiresAt: Date.now() + this.#timeout };
    } catch { throw failure(); }
  }
  async callbackForUrl(url: string) {
    try { const state = new URL(url).searchParams.get('state'); const entry = [...this.#flows].find(([, f]) => f.state === state); if (!entry) throw failure(); return await this.callback(entry[0], url); } catch { throw failure(); }
  }
  async callback(flowId: string, callbackUrl: string) {
    try {
      const flow = this.#flows.get(flowId); if (!flow) throw failure();
      // One attempt consumes the state, including denials and malformed callbacks.
      this.#flows.delete(flowId); clearTimeout(flow.timer);
      const url = new URL(callbackUrl);
      if (url.origin !== this.#callback.origin || url.pathname !== this.#callback.pathname || url.hash || url.username || url.password || Date.now() >= flow.expiresAt) throw failure();
      const c = flow.config, as = this.#as(c), client = this.#client(c);
      const params = oauth.validateAuthResponse(as, client, url, flow.state);
      const response = await oauth.authorizationCodeGrantRequest(as, client, await this.#auth(c), params, this.#callback.href, flow.verifier, this.#options());
      const oidc = c.scope?.split(/\s+/).includes('openid');
      const result = await oauth.processAuthorizationCodeResponse(as, client, response, oidc ? { expectedNonce: flow.nonce, requireIdToken: true } : undefined);
      if (oidc) await oauth.validateApplicationLevelSignature(as, response, this.#options());
      return await this.#save(c, result);
    } catch { throw failure(); }
  }
  async clientCredentials(config: OAuthConfig) {
    try {
      const c = this.#config(config); if (!c.clientSecretRef) throw failure();
      const as = this.#as(c), client = this.#client(c);
      const response = await oauth.clientCredentialsGrantRequest(as, client, await this.#auth(c), new URLSearchParams(c.scope ? { scope: c.scope } : {}), this.#options());
      return await this.#save(c, await oauth.processClientCredentialsResponse(as, client, response));
    } catch { throw failure(); }
  }
  #bundle(c: OAuthConfig, result: oauth.TokenEndpointResponse, previous?: Bundle): Bundle {
    if (result.token_type.toLowerCase() !== 'bearer' || typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw failure();
    const expiresAt = Date.now() + result.expires_in * 1000; if (!Number.isFinite(expiresAt) || expiresAt > 8640000000000000) throw failure();
    return { config: c, accessToken: result.access_token, refreshToken: result.refresh_token ?? previous?.refreshToken, expiresAt };
  }
  async #save(c: OAuthConfig, result: oauth.TokenEndpointResponse) {
    return this.#store.createOAuthBundle({ label: c.label, origins: c.allowedOrigins, storage: c.storage, value: JSON.stringify(this.#bundle(c, result)) });
  }
  async list() { return (await this.#store.list()).filter(m => m.kind === 'oauth-bundle'); }
  async token(connectionId: string, origin: string): Promise<string> {
    try {
      connectionId = secretReferencePattern.exec(connectionId)?.[1] ?? connectionId;
      if (this.#closing.has(connectionId)) throw failure();
      const bundle: Bundle = JSON.parse(await this.#store.resolveOAuthBundle(connectionId, origin));
      if (this.#closing.has(connectionId)) throw failure();
      if (bundle.expiresAt > Date.now() + 30000) return bundle.accessToken;
      // Binding is checked before joining another request's refresh.
      let pending = this.#refresh.get(connectionId);
      if (!pending) {
        pending = this.#renew(connectionId, bundle); this.#refresh.set(connectionId, pending);
        void pending.finally(() => this.#refresh.delete(connectionId)).catch(() => {});
      }
      const token = await pending; if (this.#closing.has(connectionId)) throw failure(); return token;
    } catch { throw failure(); }
  }
  async #renew(id: string, bundle: Bundle) {
    try {
      const c = bundle.config; if (!bundle.refreshToken) throw failure();
      const as = this.#as(c), client = this.#client(c);
      const response = await oauth.refreshTokenGrantRequest(as, client, await this.#auth(c), bundle.refreshToken, this.#options());
      const result = await oauth.processRefreshTokenResponse(as, client, response);
      const next = this.#bundle(c, result, bundle);
      await this.#store.replaceOAuthBundle(id, JSON.stringify(next)); return next.accessToken;
    } catch { throw failure(); }
  }
  async clear(connectionId: string) { try { const m = (await this.list()).find(m => m.id === connectionId || m.reference === connectionId); if (!m) throw failure(); await this.#store.delete(m.id); } catch { throw failure(); } }
  async revoke(connectionId: string) {
    let closingId: string | undefined;
    try {
      const m = (await this.list()).find(m => m.id === connectionId || m.reference === connectionId); if (!m || this.#closing.has(m.id)) throw failure();
      closingId = m.id; this.#closing.add(m.id);
      // Prevent new grants and revoke the latest rotated pair after any existing refresh settles.
      await this.#refresh.get(m.id)?.catch(() => {});
      const bundle: Bundle = JSON.parse(await this.#store.resolveOAuthBundle(m.id, m.origins[0])); const c = bundle.config;
      if (!c.revocationEndpoint) throw failure();
      for (const token of [...new Set([bundle.refreshToken, bundle.accessToken].filter(Boolean))]) {
        const response = await oauth.revocationRequest(this.#as(c), this.#client(c), await this.#auth(c, c.revocationEndpoint), token!, this.#options());
        await oauth.processRevocationResponse(response);
      }
      await this.clear(m.id);
    } catch { throw failure(); }
    finally { if (closingId) this.#closing.delete(closingId); }
  }
  dispose() { for (const flow of this.#flows.values()) clearTimeout(flow.timer); this.#flows.clear(); }
}
