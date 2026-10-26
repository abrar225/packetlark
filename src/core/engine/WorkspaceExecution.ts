import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CredentialStore, secretReferencePattern, type CredentialProvider } from '../security/CredentialStore.js';
import { OAuthService } from '../security/OAuthService.js';
import { SecretRedactor } from '../security/SecretRedactor.js';
import { WorkspaceLease } from '../workspace/WorkspaceLease.js';
import { SelectedFileStore } from './SelectedFileStore.js';
import { ResponseArtifactStore } from './ResponseArtifactStore.js';
import { CookieManager } from './CookieManager.js';
import { validateJsonBody } from './JsonBodyValidation.js';
import type { ExecutionOptions } from './HttpExecutor.js';

/** One process context owns ephemeral capabilities and credential resolution. */
export class WorkspaceExecution {
  readonly knownSecrets: SecretRedactor;
  readonly credentials: CredentialStore;
  readonly oauth: OAuthService;
  readonly files = new SelectedFileStore();
  readonly artifacts = new ResponseArtifactStore();
  readonly cookies = new CookieManager();
  readonly workspaceRoot: string;
  #serverOwned: boolean;
  #tokens = new Map<string, Promise<string>>();
  constructor(workspaceRoot: string, options: { serverOwned?: boolean; callbackUrl?: string; credentialProvider?: CredentialProvider; allowInsecureLoopbackForTests?: boolean; knownSecrets?: SecretRedactor } = {}) {
    this.knownSecrets = options.knownSecrets ?? new SecretRedactor();
    const absolute = path.resolve(workspaceRoot);
    this.workspaceRoot = fs.existsSync(absolute) ? fs.realpathSync(absolute) : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    this.#serverOwned = options.serverOwned === true;
    const id = createHash('sha256').update(this.workspaceRoot).digest('hex');
    this.credentials = new CredentialStore({ workspaceId: id, metadataPath: path.join(this.workspaceRoot, 'private-credentials', 'bindings-v1.json'), provider: options.credentialProvider });
    // Headless contexts only resolve/refresh; they never expose this placeholder callback.
    this.oauth = new OAuthService(this.credentials, { callbackUrl: options.callbackUrl ?? 'http://127.0.0.1:65535/api/oauth/callback', allowInsecureLoopbackForTests: options.allowInsecureLoopbackForTests });
  }
  async #token(id: string, origin: string) {
    if (this.#serverOwned) return this.oauth.token(id, origin);
    const normalized = secretReferencePattern.exec(id)?.[1] ?? id;
    // Verify every caller's binding before it can join a same-process refresh.
    await this.credentials.resolveOAuthBundle(id, origin);
    const key = normalized;
    let pending = this.#tokens.get(key);
    if (!pending) {
      pending = (async () => {
        // Headless OAuth mutation obeys the same cooperating-writer protocol as Studio.
        const lease = WorkspaceLease.acquire(this.workspaceRoot);
        try { return await this.oauth.token(id, origin); } finally { lease.release(); }
      })();
      this.#tokens.set(key, pending);
      void pending.finally(() => this.#tokens.delete(key)).catch(() => {});
    }
    return pending;
  }
  async options(options: { stream?: boolean; forbiddenOrigins?: string[] } = {}): Promise<ExecutionOptions> {
    return {
      secrets: this.knownSecrets,
      resolveCredential: (ref, origin) => this.credentials.resolve(ref, origin),
      resolveOAuth: (id, origin) => this.#token(id, origin),
      resolveFile: (id) => this.files.resolve(id),
      validateJsonBody: (raw, schema, signal) => validateJsonBody(raw, schema, { signal }),
      forbiddenOrigins: options.forbiddenOrigins,
      ...(options.stream ? { artifactStore: this.artifacts, previewBytes: 256 * 1024 } : {}),
    };
  }
  async close() { this.oauth.dispose(); await Promise.all([this.files.close(), this.artifacts.close(), this.credentials.idle()]); }
}
