import { api, element, field, select, action, dialog } from './credential-controls.js';
export class HttpControls {
  constructor({ getRequest, changed, ownsRequest = request => getRequest() === request, fetch: transport = (...args) => fetch(...args) }) { Object.assign(this, { getRequest, changed, ownsRequest, transport }); }
  call(path, options) { return api(path, options, this.transport); }
  // File objects come exclusively from native input[type=file]. No filesystem paths are accepted.
  async upload(file, signal) {
    const result = await this.call('/api/files', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file, signal });
    if (!result.id) throw new Error('File upload returned no selection ID.'); return result;
  }
  filePicker(parent, label, target, apply, current = '') {
    const input = field(parent, label, '', 'file');
    const status = element('p', current || 'No file selected.', { role: 'status', className: 'p2-note' }); parent.append(status);
    const request = this.getRequest(), body = request.body, mode = body.mode;
    const owns = () => this.ownsRequest(request) && request.body === body && (target === body || body.formData?.includes(target));
    let pending = false, cleanupBlocked = false;
    const cleanup = async id => { if (id) await this.call(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' }); };
    const reportCleanup = (id, error) => {
      cleanupBlocked = true;
      const modal = parent.isConnected ? null : dialog('Remove unused upload');
      const host = modal?.content || parent, message = modal?.status || status;
      message.textContent = `${error.message} An unused upload still needs removal.`;
      action(host, 'Retry unused upload cleanup', async event => {
        const button = event.currentTarget; button.disabled = true;
        try { await cleanup(id); button.remove(); cleanupBlocked = false; input.disabled = pending; message.textContent = 'Unused upload removed.'; }
        catch (failure) { message.textContent = failure.message; button.disabled = false; }
      });
    };
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file || pending || cleanupBlocked) return;
      pending = true; input.disabled = clear.disabled = true; status.textContent = `Uploading ${file.name}…`;
      const oldId = target.fileId; let selected, retiringId, staleCleanup = false;
      try {
        selected = await this.upload(file);
        if (!owns() || body.mode !== mode || target.fileId !== oldId) {
          staleCleanup = true; await cleanup(selected.id); selected = undefined;
          if (parent.isConnected) status.textContent = 'The request changed. Choose the file again from the intended request.';
          return;
        }
        // Attach while ownership is current. Retiring the previous upload must
        // never discard newly chosen bytes or mutate a subsequently active draft.
        apply(selected); selected = undefined; this.changed(request);
        status.textContent = `${file.name} · ${file.size} bytes selected`;
        if (oldId && oldId !== target.fileId) { retiringId = oldId; await cleanup(oldId); retiringId = undefined; }
      } catch (error) {
        if (retiringId) reportCleanup(retiringId, error);
        else if (selected) {
          if (staleCleanup) reportCleanup(selected.id, error);
          else { try { await cleanup(selected.id); } catch (failure) { reportCleanup(selected.id, failure); } }
        }
        if (parent.isConnected && !cleanupBlocked) status.textContent = error.message;
      } finally { pending = false; input.disabled = cleanupBlocked; clear.disabled = false; }
    };
    const clear = action(parent, target === body ? 'Clear file selection' : 'Use text instead', async () => {
      if (pending || !target.fileId) return;
      pending = true; input.disabled = clear.disabled = true; const id = target.fileId;
      try {
        await cleanup(id);
        if (owns() && target.fileId === id) { delete target.fileId; delete target.fileName; this.changed(request); }
        if (parent.isConnected) { input.value = ''; status.textContent = 'No file selected.'; }
      } catch (error) { if (parent.isConnected) status.textContent = error.message; }
      finally { pending = false; input.disabled = cleanupBlocked; clear.disabled = false; }
    });
    return input;
  }
  renderBody(container) {
    container.replaceChildren(); container.classList.add('p2-controls');
    const request = this.getRequest(), body = request.body || { mode: 'none' };
    if (body.mode === 'binary') {
      this.filePicker(container, 'Binary file', body, file => { body.fileId = file.id; }, body.fileId ? `File reference: ${body.fileId}` : '');
    } else if (body.mode === 'form-data') {
      container.append(element('p', 'Attach chosen files to multipart fields. Text fields remain editable above.', { className: 'p2-note' }));
      for (const entry of body.formData || []) {
        const row = element('section', null, { className: 'p2-card' }); container.append(row);
        const key = field(row, 'Multipart field name', entry.key || ''); key.oninput = () => { entry.key = key.value; this.changed(); };
        this.filePicker(row, 'Attach file', entry, file => { entry.fileId = file.id; entry.fileName = file.name; entry.value = ''; }, entry.fileName || entry.fileId || '');
      }
    } else if (body.mode === 'raw-json') {
      const details = element('details'); details.append(element('summary', 'JSON schema validation (optional)'));
      const schema = element('textarea', null, { className: 'code-editor', value: body.schema ? JSON.stringify(body.schema, null, 2) : '', ariaLabel: 'JSON schema', rows: 6 });
      const status = element('p', '', { role: 'status' }); details.append(schema, status); container.append(details);
      action(details, 'Apply schema and validate', async event => {
        const button = event.currentTarget; button.disabled = true;
        try {
          const parsed = schema.value.trim() ? JSON.parse(schema.value) : undefined;
          if (parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Schema must be a JSON object.');
          const result = await this.call('/api/validate/json', { method: 'POST', body: JSON.stringify({ raw: body.raw || '', schema: parsed }) });
          if (this.getRequest() !== request || !container.isConnected) return;
          body.schema = parsed; this.changed(); status.textContent = result.valid ? 'JSON matches the schema.' : JSON.stringify(result.errors || result.error || 'JSON does not match the schema.');
        } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
      });
    }
  }
  openTls() {
    const request = this.getRequest(), modal = dialog('TLS certificates');
    const tls = { ...request.tls };
    let pendingReads = 0;
    modal.content.append(element('p', 'Choose public CA and client certificate PEM files. Private keys and passphrases use credential references; local file paths are never imported.', { className: 'p2-note' }));
    const pem = (label, key) => {
      let generation = 0;
      const input = field(modal.content, label, '', 'file'); input.accept = '.pem,.crt,.cer';
      const status = element('p', tls[key] ? 'Certificate configured.' : 'No certificate configured.', { className: 'p2-note', role: 'status' }); modal.content.append(status);
      input.onchange = async () => {
        const file = input.files?.[0]; if (!file || input.disabled) return; const selectedGeneration = ++generation; input.disabled = true; pendingReads++;
        try {
          if (file.size > 256 * 1024) throw new Error('Certificate file exceeds 256 KiB.');
          const text = await file.text();
          if (!modal.alive() || selectedGeneration !== generation) return;
          if (new TextEncoder().encode(text).byteLength > 256 * 1024) throw new Error('Certificate file exceeds 256 KiB.');
          if (/PRIVATE KEY/.test(text)) throw new Error('Choose a public certificate. Store private keys in Credentials.');
          if (!/-----BEGIN CERTIFICATE-----/.test(text)) throw new Error('Choose a PEM certificate file.');
          tls[key] = text; status.textContent = `${file.name} selected.`;
        } catch (error) { status.textContent = error.message; } finally { input.disabled = false; pendingReads--; }
      };
      action(modal.content, `Clear ${label}`, () => { generation++; delete tls[key]; input.value = ''; status.textContent = 'No certificate configured.'; });
    };
    pem('CA certificate', 'ca'); pem('Client certificate', 'cert');
    const key = field(modal.content, 'Private key credential reference', tls.keyRef || '');
    const passphrase = field(modal.content, 'Passphrase credential reference (optional)', tls.passphraseRef || '');
    action(modal.content, 'Apply TLS settings', () => {
      if (pendingReads) { modal.status.textContent = 'Wait for certificate files to finish loading before applying.'; return; }
      if (this.getRequest() !== request) { modal.status.textContent = 'The active request changed. Reopen TLS settings from the intended request.'; return; }
      if ([key.value, passphrase.value].some(value => value && !/^\{\{secret:[^{}]+\}\}$/.test(value))) { modal.status.textContent = 'Use credential references in the form {{secret:ID}}.'; return; }
      request.tls = { ...tls, keyRef: key.value || undefined, passphraseRef: passphrase.value || undefined }; this.changed(); modal.node.close();
    });
    return modal;
  }
  openCookies() {
    const modal = dialog('Cookies');
    modal.content.append(element('p', 'Cookies are sent only to matching domains and paths. Persistence is opt-in and stores the cookie jar securely on this computer.', { className: 'p2-note' }));
    const list = element('div'); modal.content.append(list);
    const refresh = async () => {
      const data = await this.call('/api/cookies'); if (!modal.alive()) return; list.replaceChildren();
      const cookies = Array.isArray(data) ? data : data.cookies || [];
      for (const cookie of cookies) {
        const row = element('section', null, { className: 'p2-card' });
        row.append(element('strong', cookie.key || cookie.name), element('span', `${cookie.domain || ''}${cookie.path || '/'} ${cookie.secure ? '· Secure' : ''} ${cookie.httpOnly ? '· HttpOnly' : ''}`));
        const value = field(row, 'Cookie value', cookie.value || '', 'password');
        action(row, 'Update cookie', () => modal.run(async () => { await this.call('/api/cookies', { method: 'PUT', body: JSON.stringify({ url: `${cookie.secure ? 'https' : 'http'}://${String(cookie.domain || '').replace(/^\./, '')}${cookie.path || '/'}`, cookie: `${cookie.key || cookie.name}=${value.value}; Path=${cookie.path || '/'}${cookie.hostOnly ? '' : `; Domain=${cookie.domain}`}${cookie.secure ? '; Secure' : ''}${cookie.httpOnly ? '; HttpOnly' : ''}${cookie.sameSite ? `; SameSite=${cookie.sameSite}` : ''}${cookie.expires && cookie.expires !== 'Infinity' ? `; Expires=${cookie.expires}` : ''}` }) }); modal.status.textContent = 'Cookie updated.'; }));
        list.append(row);
      }
      if (!cookies.length) list.append(element('p', 'No cookies.'));
      if (data.persistence != null) { consent.checked = Boolean(data.persistence.enabled); modal.status.textContent = data.persistence.error || `Secure persistence: ${data.persistence.enabled ? 'enabled' : 'disabled'}.`; }
    };
    const url = field(modal.content, 'Cookie URL', this.getRequest()?.url || '');
    const cookie = field(modal.content, 'Set-Cookie value', '', 'password');
    action(modal.content, 'Set cookie', () => modal.run(async () => { await this.call('/api/cookies', { method: 'PUT', body: JSON.stringify({ url: url.value, cookie: cookie.value }) }); cookie.value = ''; await refresh(); }));
    const consent = field(modal.content, 'Allow secure cookie persistence on this computer', '', 'checkbox');
    action(modal.content, 'Apply persistence choice', () => modal.run(async () => { if (!confirm(consent.checked ? 'Store these cookies in the OS keychain for restart recovery?' : 'Disable future cookie persistence? Previously saved cookies remain in the OS keychain until explicitly removed.')) return; await this.call('/api/cookies/persistence', { method: 'POST', body: JSON.stringify({ enabled: consent.checked, storage: 'keychain', consent: true }) }); await refresh(); }));
    action(modal.content, 'Forget saved cookies…', () => { if (confirm('Remove the saved cookie bundle from the OS keychain and disable persistence? Current session cookies remain available until cleared separately.')) modal.run(async () => { await this.call('/api/cookies/persistence', { method: 'DELETE', body: JSON.stringify({ consent: true }) }); await refresh(); if (modal.alive()) modal.status.textContent = 'Saved cookies removed and persistence disabled. Current session cookies were retained.'; }); });
    action(modal.content, 'Clear all cookies…', () => { if (confirm('Clear all cookies from the local jar?')) modal.run(async () => { await this.call('/api/cookies', { method: 'DELETE', body: JSON.stringify({}) }); await refresh(); }); });
    modal.run(refresh); return modal;
  }
  async execute(request, { signal, onEvent = () => {} } = {}) {
    const response = await this.transport('/api/execute/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message || data.error || `Request failed (${response.status})`); }
    if (!response.body) throw new Error('Streaming is unavailable in this browser.');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', completed;
    const consume = line => {
      if (!line.trim()) return; const event = JSON.parse(line); onEvent(event);
      if (event.type === 'complete') completed = event.response || event.data;
      if (event.type === 'error') throw new Error(event.error?.message || event.message || 'Execution failed.');
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        // A transport failure must not permit unbounded retained browser text.
        if (pending.length > 2 * 1024 * 1024) throw new Error('A stream event exceeded the 2 MiB preview limit.');
        let newline; while ((newline = pending.indexOf('\n')) !== -1) { consume(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
        if (done) break;
      }
      consume(pending); if (!completed) throw new Error('The response stream ended before completion.'); return completed;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  renderInspector(container, response) {
    container.replaceChildren(); container.classList.add('p2-controls');
    const mime = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
    if (mime) container.append(element('p', `Content type: ${mime}`, { className: 'p2-note' }));
    if (response.previewTruncated) container.append(element('p', `Showing a limited preview of ${Number(response.sizeBytes || 0).toLocaleString()} response bytes. Download the complete response below.`, { className: 'p2-note' }));
    if (response.bodyEncoding === 'base64') container.append(element('p', 'Binary response. Download the artifact to preserve its bytes.', { className: 'p2-note' }));
    for (const [label, value] of [['Headers (including duplicates)', response.headerEntries], ['Timings', response.timings], ['TLS', response.tls], ['Connection', response.connection], ['Redirects', response.redirects], ['Response limits', response.truncation || response.limits]]) {
      if (value == null) continue; const section = element('details'); section.append(element('summary', label), element('pre', JSON.stringify(value, null, 2))); container.append(section);
    }
    if (response.artifactId) container.append(element('a', 'Download complete response', { href: `/api/responses/${encodeURIComponent(response.artifactId)}`, className: 'nav-btn', download: '' }));
  }
}
