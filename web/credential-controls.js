// Secret values are only sent on explicit store; metadata lists never retrieve values.
export async function api(path, options = {}, transport = fetch) {
  const response = await transport(path, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.error || `Request failed (${response.status})`);
  return data;
}
export function element(tag, text, props = {}) {
  const node = document.createElement(tag); if (text != null) node.textContent = text;
  Object.assign(node, props); return node;
}
export function field(parent, label, value = '', type = 'text') {
  const wrap = element('label', null, { className: 'p2-field' }); wrap.append(element('span', label));
  const input = element('input', null, { type, value, className: 'url-input', autocomplete: 'off' });
  wrap.append(input); parent.append(wrap); return input;
}
export function select(parent, label, choices, value) {
  const wrap = element('label', null, { className: 'p2-field' }); wrap.append(element('span', label));
  const input = element('select', null, { className: 'method-select' });
  for (const [key, title] of choices) input.append(element('option', title, { value: key }));
  input.value = value; wrap.append(input); parent.append(wrap); return input;
}
export function action(parent, label, fn) {
  const button = element('button', label, { type: 'button', className: 'nav-btn' });
  button.addEventListener('click', fn); parent.append(button); return button;
}
export function dialog(title) {
  const previous = document.activeElement;
  const node = element('dialog', null, { className: 'p2-dialog', ariaLabel: title });
  const heading = element('h2', title); const content = element('div', null, { className: 'p2-controls' });
  const status = element('p', '', { role: 'status', className: 'p2-status' });
  node.append(heading, content, status);
  let pending = false;
  const close = action(node, 'Close', () => node.close());
  // Keep the exit reachable without scrolling past a long credential review.
  node.insertBefore(close, content);
  node.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  node.addEventListener('close', () => { node.remove(); previous?.focus(); });
  document.body.append(node); node.showModal();
  return { node, content, status, alive: () => node.isConnected && node.open,
    async run(fn) {
      if (pending) return;
      pending = true; status.textContent = '';
      const buttons = [...node.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true);
      try { await fn(); } catch (error) { if (node.open) status.textContent = error.message; }
      finally { pending = false; if (node.open) buttons.forEach(button => button.disabled = false); close.disabled = false; }
    }
  };
}
const rows = data => Array.isArray(data) ? data : data.credentials || data.connections || data.items || [];
export class CredentialControls {
  constructor({ getRequest, changed, fetch: transport = (...args) => fetch(...args) }) { Object.assign(this, { getRequest, changed, transport }); }
  call(path, options) { return api(path, options, this.transport); }
  renderAuth(container) {
    const request = this.getRequest(), auth = request.auth || { type: 'none' };
    container.replaceChildren(); container.classList.add('p2-controls');
    const edit = (label, key, sensitive = false, fallback = '') => {
      const input = field(container, label, auth[key] || fallback, sensitive ? 'password' : 'text');
      input.addEventListener('input', () => { auth[key] = input.value; this.changed(); });
      if (!sensitive) return;
      const reference = field(container, `${label} credential reference`, auth[key]?.startsWith('{{secret:') ? auth[key] : '');
      reference.addEventListener('change', () => { auth[key] = reference.value || ''; this.changed(); });
      container.append(element('p', auth[key]?.startsWith('{{secret:') ? 'The credential reference is used. Remove it to use the inline value.' : 'Inline values are plaintext in saved requests and exports. Store this value to replace it with a credential reference.', { className: 'p2-note' }));
      action(container, 'Store and replace with reference', () => this.storeInline(request, key, input, container));
    };
    if (auth.type === 'bearer') edit('Bearer token', 'bearerToken', true);
    else if (auth.type === 'basic') { edit('Username', 'basicUsername'); edit('Password', 'basicPassword', true); }
    else if (auth.type === 'apikey') {
      edit('Key name', 'apiKeyName', false, 'X-API-Key'); edit('Key value', 'apiKeyValue', true);
      const location = select(container, 'Add to', [['header','Header'], ['query','Query parameters']], auth.apiKeyIn || 'header');
      location.onchange = () => { auth.apiKeyIn = location.value; this.changed(); };
    } else if (auth.type === 'oauth2') {
      const id = field(container, 'OAuth connection ID', auth.oauthConnectionId || '');
      id.onchange = () => { auth.oauthConnectionId = id.value; this.changed(); };
      action(container, 'Manage OAuth connections', () => this.openOAuth());
    } else container.append(element('p', auth.type === 'inherit' ? 'Authorization is resolved from the nearest parent folder or collection when this request runs.' : auth.type === 'unsupported' ? 'This imported authorization mode is preserved. Select a supported mode to execute.' : 'This request does not use authorization headers.'));
    action(container, 'Manage credentials', () => this.openManager());
  }
  storeInline(request, key, input, container) {
    const originalAuth = request.auth;
    const modal = dialog('Store credential');
    modal.content.append(element('p', 'This explicitly removes the inline secret from this request and replaces it with a reference. Existing exports and saved copies are not changed.'));
    const name = field(modal.content, 'Name', key);
    const storage = select(modal.content, 'Storage', [['session','Session — cleared when the server exits'],['keychain','OS keychain — persists on this computer']], 'session');
    const origin = field(modal.content, 'Allowed origins (comma separated)', this.origin(request.url));
    action(modal.content, 'Store and replace', () => modal.run(async () => {
      if (this.getRequest() !== request || request.auth !== originalAuth) throw new Error('The active request changed. Reopen this action from the intended request.');
      if (!input.value) throw new Error('Enter a secret first.');
      const result = await this.call('/api/credentials', { method: 'POST', body: JSON.stringify({ label: name.value, value: input.value, storage: storage.value, origins: origin.value.split(',').map(x => x.trim()).filter(Boolean) }) });
      if (!modal.alive()) return;
      if (this.getRequest() !== request || request.auth !== originalAuth) { modal.status.textContent = 'Credential stored. The active request changed; no reference was attached.'; return; }
      const reference = result.reference || result.credential?.reference || (result.id ? `{{secret:${result.id}}}` : null);
      if (!reference) throw new Error('The credential service did not return a reference.');
      request.auth[key] = reference;
      input.value = reference; this.changed(); this.renderAuth(container); modal.node.close();
    }));
  }
  origin(url) { try { return new URL(url).origin; } catch { return ''; } }
  openManager() {
    const modal = dialog('Credentials');
    modal.content.append(element('p', 'Session credentials last until the server exits. Keychain credentials remain on this computer. Only names, references, and origin bindings are listed.'));
    const list = element('div'); modal.content.append(list);
    const refresh = async () => {
      const data = await this.call('/api/credentials'); if (!modal.alive()) return;
      list.replaceChildren();
      for (const item of rows(data)) {
        const row = element('section', null, { className: 'p2-card' });
        row.append(element('strong', item.label || item.id), element('code', item.reference || item.id), element('span', item.storage || 'session'));
        const origins = field(row, 'Allowed origins (comma separated)', (item.origins || []).join(', '));
        action(row, 'Update origins…', () => { if (!confirm('Change the origins allowed to use this credential? Only list origins you trust with its value.')) return; modal.run(async () => { await this.call(`/api/credentials/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ origins: origins.value.split(',').map(x => x.trim()).filter(Boolean) }) }); modal.status.textContent = 'Origin bindings updated.'; }); });
        action(row, 'Delete credential…', () => { if (confirm(`Delete credential “${item.label || item.id}”? Requests using its reference will fail.`)) modal.run(async () => { await this.call(`/api/credentials/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await refresh(); }); });
        list.append(row);
      }
      if (!rows(data).length) list.append(element('p', 'No credentials stored.'));
    };
    const name = field(modal.content, 'Name'); const secret = field(modal.content, 'Secret value', '', 'password');
    const storage = select(modal.content, 'Storage', [['session','Session'],['keychain','OS keychain']], 'session');
    const origins = field(modal.content, 'Allowed origins (comma separated)', this.origin(this.getRequest()?.url));
    const kind = select(modal.content, 'Use', [['secret','Request secret'],['oauth-client-secret','OAuth client secret']], 'secret');
    action(modal.content, 'Store credential', () => modal.run(async () => { if (!secret.value) throw new Error('Enter a secret value.'); await this.call('/api/credentials', { method: 'POST', body: JSON.stringify({ label: name.value, value: secret.value, storage: storage.value, kind: kind.value, origins: origins.value.split(',').map(x => x.trim()).filter(Boolean) }) }); secret.value = ''; await refresh(); }));
    const migration = element('section', null, { className: 'p2-card' }); modal.content.append(migration);
    migration.append(element('h3', 'Migrate saved plaintext credentials'), element('p', 'Review a saved collection or environment, then select the fields to replace. Save pending edits first. Existing files, history, backups, and exports may retain plaintext.'));
    const resourceKind = select(migration, 'Resource kind', [['collections','Collection'],['environments','Environment']], 'collections');
    const resourceId = field(migration, 'Resource ID');
    const migrationOrigins = field(migration, 'Migration origins (comma separated)', this.origin(this.getRequest()?.url));
    const migrationStorage = select(migration, 'Migration storage', [['session','Session — references stop resolving when the server exits'],['keychain','OS keychain — persists on this computer']], 'session');
    const review = element('div'); migration.append(review);
    let plan;
    const parameters = () => ({ kind: resourceKind.value, id: resourceId.value.trim(), origins: migrationOrigins.value.split(',').map(value => value.trim()).filter(Boolean), storage: migrationStorage.value });
    const invalidate = () => { plan = undefined; review.replaceChildren(); };
    for (const input of [resourceKind, resourceId, migrationOrigins, migrationStorage]) { input.addEventListener('input', invalidate); input.addEventListener('change', invalidate); }
    action(migration, 'Preview migration', () => modal.run(async () => {
      invalidate(); const params = parameters(), fingerprint = JSON.stringify(params);
      if (!params.id || !params.origins.length) throw new Error('Enter a resource ID and at least one allowed origin.');
      const result = await this.call('/api/credentials/migration/preview', { method: 'POST', body: JSON.stringify(params) });
      if (!modal.alive() || JSON.stringify(parameters()) !== fingerprint) return;
      if (!result.planId || !Array.isArray(result.fields) || result.fields.some(item => typeof item.pointer !== 'string')) throw new Error('The migration service returned an invalid review.');
      const warning = 'Only the selected saved resource is replaced. Existing files, history, backups, and exports may retain plaintext. Session references stop resolving when the server exits; use an available OS keychain for persistence.';
      review.append(element('p', warning, { className: 'p2-note' }));
      const selections = result.fields.map(item => ({ pointer: item.pointer, input: field(review, item.pointer, '', 'checkbox') }));
      if (!selections.length) review.append(element('p', 'No plaintext credential fields found.'));
      const sessionConsent = params.storage === 'session' ? field(review, 'I understand these saved references will stop resolving after the server exits.', '', 'checkbox') : null;
      plan = { id: result.planId, fingerprint, selections, sessionConsent, params };
      modal.status.textContent = 'Review the field paths and select only the credentials you want to migrate. Values are not displayed.';
    }));
    action(migration, 'Apply selected migration…', () => modal.run(async () => {
      const current = plan;
      if (!current || current.fingerprint !== JSON.stringify(parameters())) throw new Error('Preview the current resource and storage choice before applying.');
      const fields = current.selections.filter(item => item.input.checked).map(item => item.pointer);
      if (!fields.length) throw new Error('Select at least one reviewed field.');
      if (current.sessionConsent && !current.sessionConsent.checked) throw new Error('Acknowledge that session references stop resolving when the server exits.');
      if (!confirm(`Replace ${fields.length} selected plaintext field(s) in ${current.params.kind}/${current.params.id} with ${current.params.storage} credential references? Existing copies may retain plaintext. Reload the resource after migration; unsaved drafts must not overwrite it.${current.sessionConsent ? ' Session references stop resolving when the server exits.' : ''}`)) return;
      invalidate();
      await this.call('/api/credentials/migration/apply', { method: 'POST', body: JSON.stringify({ planId: current.id, fields, consent: true, ...(current.sessionConsent ? { sessionLossConsent: true } : {}) }) });
      await refresh();
      if (modal.alive()) modal.status.textContent = 'Migration applied. Reload the collection or environment before editing it. Do not save an older open draft over the migrated resource. Existing historical copies may retain plaintext.';
    }));
    modal.run(refresh); return modal;
  }
  openOAuth() {
    const modal = dialog('OAuth connections'), request = this.getRequest();
    const list = element('div'); modal.content.append(list);
    const refresh = async () => {
      const data = await this.call('/api/oauth'); if (!modal.alive()) return; list.replaceChildren();
      for (const item of rows(data)) {
        const row = element('section', null, { className: 'p2-card' }); row.append(element('strong', item.label || item.id), element('code', item.reference || item.id), element('span', item.status || 'Stored connection'));
        action(row, 'Use connection', () => { if (this.getRequest() !== request) { modal.status.textContent = 'The active request changed. Reopen OAuth from the intended request.'; return; } request.auth = { type: 'oauth2', oauthConnectionId: item.id }; this.changed(); modal.node.close(); });
        for (const operation of ['clear','revoke']) action(row, `${operation === 'clear' ? 'Clear local tokens' : 'Revoke at provider'}…`, () => { if (confirm(`${operation === 'clear' ? 'Clear local tokens for' : 'Revoke provider tokens for'} ${item.label || item.id}?`)) modal.run(async () => { await this.call(`/api/oauth/${encodeURIComponent(item.id)}/${operation}`, { method: 'POST', body: JSON.stringify({consent:true}) }); await refresh(); }); });
        list.append(row);
      }
    };
    const name = field(modal.content, 'Connection name');
    const issuer = field(modal.content, 'Issuer URL');
    const revoke = field(modal.content, 'Revocation endpoint (optional)');
    const jwks = field(modal.content, 'JWKS URI (required for OpenID Connect)');
    const environment = field(modal.content, 'Environment name (optional)');
    const account = field(modal.content, 'Account name (optional)');
    const storage = select(modal.content, 'Token storage', [['session','Session'],['keychain','OS keychain']], 'session');
    const grant = select(modal.content, 'Grant', [['authorization_code','Authorization code with PKCE'],['client_credentials','Client credentials']], 'authorization_code');
    const authorize = field(modal.content, 'Authorization endpoint'); const token = field(modal.content, 'Token endpoint');
    const client = field(modal.content, 'Client ID'); const clientSecret = field(modal.content, 'Client secret credential reference');
    modal.content.append(element('p', 'Client secret references must be stored as OAuth client secrets and allowed for the token endpoint origin.', { className: 'p2-note' }));
    const scope = field(modal.content, 'Scopes (space separated)'); const origin = field(modal.content, 'Resource origins (comma separated)', this.origin(request?.url));
    action(modal.content, 'Connect', () => modal.run(async () => {
      const result = await this.call(`/api/oauth/${grant.value === 'client_credentials' ? 'client-credentials' : 'start'}`, { method: 'POST', body: JSON.stringify({ label: name.value, authorizationEndpoint: authorize.value, tokenEndpoint: token.value, issuer: issuer.value, revocationEndpoint: revoke.value || undefined, jwksUri: jwks.value || undefined, environment: environment.value || undefined, account: account.value || undefined, storage: storage.value, clientId: client.value, clientSecretRef: clientSecret.value || undefined, scope: scope.value, allowedOrigins: origin.value.split(',').map(x => x.trim()).filter(Boolean) }) });
      if (!modal.alive()) return;
      if (result.authorizationUrl) {
        const link = element('a', 'Continue authorization at provider', { href: result.authorizationUrl, target: '_blank', rel: 'noopener noreferrer', className: 'nav-btn' });
        if (!['http:', 'https:'].includes(new URL(result.authorizationUrl).protocol)) throw new Error('Invalid authorization URL.');
        modal.content.append(link); modal.status.textContent = 'Complete authorization in the provider tab, then refresh connections.';
      } else await refresh();
    }));
    action(modal.content, 'Refresh connections', () => modal.run(refresh)); modal.run(refresh); return modal;
  }
}
