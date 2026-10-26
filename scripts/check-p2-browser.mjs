import assert from 'node:assert/strict';

// Run with the project's connected Ego Page API on a disposable Studio fixture.
// Network doubles below verify browser ownership and privacy without retaining secrets.
export async function verifyP2Controls(page, baseUrl) {
  await page.goto(baseUrl + '/studio');
  await page.waitForFunction(() => Boolean(window.ReaCredentialControls && window.ReaHttpControls));
  const result = await page.evaluate(async () => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const cases = [];
    const originalConfirm = window.confirm; window.confirm = () => true;
    const calls = [];
    let request = { url: 'https://example.test/data', auth: { type: 'bearer', bearerToken: 'p2-disposable-secret' }, body: { mode: 'binary' } };
    let changes = 0;
    const secretReference = '{{secret:00000000-0000-4000-8000-000000000001}}';
    const transport = async (path, options = {}) => {
      calls.push({ path, options });
      const data = path === '/api/credentials' && options.method === 'POST' ? { id: '00000000-0000-4000-8000-000000000001', reference: secretReference } : path === '/api/oauth/start' ? { flowId: 'p2-flow', authorizationUrl: 'https://provider.example.test/authorize?state=opaque' } : path === '/api/files' ? { id: 'p2-selected-file', name: 'chosen.bin', size: 3, contentType: 'application/octet-stream' } : [];
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    };
    const auth = new window.ReaCredentialControls({ getRequest: () => request, changed: () => changes++, fetch: transport });
    const http = new window.ReaHttpControls({ getRequest: () => request, changed: () => changes++, fetch: transport });
    const host = document.createElement('section'); host.id = 'p2-browser-fixture'; document.body.append(host);
    const button = (node, text) => [...node.querySelectorAll('button')].find(item => item.textContent === text);
    const wait = async predicate => { for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for P2 UI.'); };
    try {
      for (const id of ['btn-credentials','btn-oauth','btn-cookies','btn-tls','p2-body-controls','p2-response-inspector','p2-stream-progress']) check(document.getElementById(id), `Missing ${id}`);
      auth.renderAuth(host);
      check(host.querySelector('input[type=password]')?.value === 'p2-disposable-secret', 'Bearer value must be sensitive.');
      check(host.textContent.includes('plaintext'), 'Inline plaintext disclosure missing.');
      button(host, 'Store and replace with reference').click();
      let modal = document.querySelector('dialog.p2-dialog[open]');
      check(modal.querySelector('select').value === 'session', 'Credential migration must default to session.');
      button(modal, 'Store and replace').click();
      await wait(() => !modal.isConnected);
      check(request.auth.bearerToken === secretReference, 'Store did not replace plaintext with a secret reference.');
      check(!('bearerTokenRef' in request.auth), 'Unexpected parallel reference field.');
      const stored = JSON.parse(calls.find(call => call.path === '/api/credentials' && call.options.method === 'POST').options.body);
      check(stored.value === 'p2-disposable-secret' && stored.storage === 'session' && stored.origins[0] === 'https://example.test', 'Credential storage lost scope or secret.');
      cases.push('sensitive auth, plaintext disclosure, explicit session storage and reference replacement');
      request.auth = { type: 'inherit' }; auth.renderAuth(host);
      check(host.textContent.includes('nearest parent'), 'Inherited authorization explanation missing.');
      cases.push('inherited authorization preserved');
      const failing = new window.ReaCredentialControls({ getRequest: () => request, changed: () => changes++, fetch: async () => new Response(JSON.stringify({ error: 'Keychain unavailable' }), { status: 503 }) });
      modal = failing.openManager(); await wait(() => modal.status.textContent.includes('Keychain unavailable'));
      const secret = modal.content.querySelector('input[type=password]'); secret.value = 'retained-on-error';
      modal.status.textContent = ''; button(modal.node, 'Store credential').click(); await wait(() => modal.status.textContent.includes('Keychain unavailable'));
      check(secret.value === 'retained-on-error', 'Failed save erased input.'); modal.node.close();
      cases.push('service failure retains credential input');
      const migrationCalls = [];
      const migrator = new window.ReaCredentialControls({ getRequest: () => request, changed: () => changes++, fetch: async (path, options = {}) => {
        migrationCalls.push({ path, options });
        const data = path.endsWith('/preview') ? { planId: 'reviewed-plan', fields: [{ pointer: '/items/0/request/auth/bearerToken', value: 'must-not-display' }] } : [];
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      } });
      let migration = migrator.openManager(); await wait(() => !button(migration.node, 'Preview migration').disabled);
      const migrationInput = label => [...migration.content.querySelectorAll('label')].find(item => item.querySelector('span')?.textContent === label).querySelector('input,select');
      migrationInput('Resource ID').value = 'fixture-collection';
      button(migration.node, 'Preview migration').click(); await wait(() => migration.content.textContent.includes('/items/0/request/auth/bearerToken'));
      check(!migration.content.textContent.includes('must-not-display'), 'Migration review displayed a raw secret value.');
      button(migration.node, 'Apply selected migration…').click(); await wait(() => migration.status.textContent.includes('Select at least one'));
      let choices = migration.content.querySelectorAll('input[type=checkbox]'); choices[0].checked = true;
      button(migration.node, 'Apply selected migration…').click(); await wait(() => migration.status.textContent.includes('Acknowledge'));
      migrationInput('Resource ID').dispatchEvent(new Event('input'));
      button(migration.node, 'Apply selected migration…').click(); await wait(() => migration.status.textContent.includes('Preview the current'));
      check(!migrationCalls.some(call => call.path.endsWith('/apply')), 'Migration applied without a current review.');
      button(migration.node, 'Preview migration').click(); await wait(() => migration.content.querySelectorAll('input[type=checkbox]').length === 2);
      choices = migration.content.querySelectorAll('input[type=checkbox]'); choices[0].checked = choices[1].checked = true;
      window.confirm = () => false;
      button(migration.node, 'Apply selected migration…').click(); await wait(() => !button(migration.node, 'Apply selected migration…').disabled);
      check(!migrationCalls.some(call => call.path.endsWith('/apply')), 'Cancelled migration still applied.');
      window.confirm = () => true;
      button(migration.node, 'Apply selected migration…').click(); await wait(() => migration.status.textContent.includes('Migration applied. Reload'));
      const approved = JSON.parse(migrationCalls.find(call => call.path.endsWith('/apply')).options.body);
      check(approved.planId === 'reviewed-plan' && approved.fields.length === 1 && approved.consent === true && approved.sessionLossConsent === true, 'Migration approval lost selection or explicit consent.');
      migration.node.close();
      cases.push('migration reviews paths without values, requires current selections, session acknowledgement and explicit confirmation, then prompts reload');
      const owned = request;
      auth.renderAuth(host); request.auth = { type: 'basic', basicPassword: 'disposable' }; auth.renderAuth(host);
      button(host, 'Store and replace with reference').click(); modal = document.querySelector('dialog.p2-dialog[open]');
      const before = calls.length; request = { url: 'https://other.test', auth: { type: 'none' }, body: { mode: 'binary' } };
      button(modal, 'Store and replace').click(); await wait(() => modal.textContent.includes('active request changed'));
      check(calls.length === before, 'Stale dialog wrote a credential.'); modal.close();
      check(owned.auth.basicPassword === 'disposable', 'Stale action changed original request.');
      cases.push('stale auth dialog cannot migrate a different draft');
      http.renderBody(host);
      const input = host.querySelector('input[type=file]');
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([1,2,3])], 'chosen.bin', { type: 'application/octet-stream' }));
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
      await wait(() => request.body.fileId === 'p2-selected-file');
      const upload = calls.find(call => call.path === '/api/files');
      check(upload.options.body instanceof Blob && upload.options.body.size === 3, 'File must upload only chosen Blob bytes.');
      check(!JSON.stringify(request).includes('chosen.bin'), 'Binary request persisted unnecessary path/name.');
      cases.push('native chosen file uploads Blob and stores only binary selection ID');
      modal = http.openTls();
      const key = [...modal.content.querySelectorAll('label')].find(label => label.textContent.includes('Private key credential reference')).querySelector('input');
      key.value = '/tmp/private-key.pem'; button(modal.node, 'Apply TLS settings').click();
      check(modal.status.textContent.includes('Use credential references'), 'TLS accepted a filesystem key path.');
      key.value = secretReference; button(modal.node, 'Apply TLS settings').click();
      check(request.tls.keyRef === secretReference, 'TLS key reference not saved.');
      modal = http.openTls();
      const certificateInput = modal.content.querySelector('input[type=file]');
      const oversized = new DataTransfer(); oversized.items.add(new File([new Uint8Array(256 * 1024 + 1)], 'large.pem'));
      certificateInput.files = oversized.files; certificateInput.dispatchEvent(new Event('change'));
      await wait(() => modal.content.textContent.includes('exceeds 256 KiB'));
      check(!request.tls.ca, 'Oversized certificate changed TLS settings.'); modal.node.close();
      cases.push('TLS private keys require credential references');
      const stream = new window.ReaHttpControls({ getRequest: () => request, changed: () => {}, fetch: async () => new Response(new ReadableStream({ start(controller) { const encoder = new TextEncoder(); controller.enqueue(encoder.encode('{"type":"progress","receivedBytes":3}\n{"type":"complete","res')); controller.enqueue(encoder.encode('ponse":{"status":200,"artifactId":"p2-artifact"}}\n')); controller.close(); } })) });
      const events = []; const response = await stream.execute(request, { onEvent: event => events.push(event.type) });
      check(response.status === 200 && events.join(',') === 'progress,complete', 'Split NDJSON event handling failed.');
      http.renderInspector(host, response);
      check(host.querySelector('a')?.getAttribute('href') === '/api/responses/p2-artifact', 'Artifact download link missing.');
      cases.push('split streaming events and artifact downloads');
      modal = auth.openOAuth(); await wait(() => !button(modal.node, 'Connect').disabled);
      const inputFor = label => [...modal.content.querySelectorAll('label')].find(item => item.querySelector('span')?.textContent === label).querySelector('input');
      inputFor('Connection name').value = 'Disposable provider'; inputFor('Issuer URL').value = 'https://provider.example.test';
      inputFor('Authorization endpoint').value = 'https://provider.example.test/authorize'; inputFor('Token endpoint').value = 'https://provider.example.test/token'; inputFor('Client ID').value = 'p2-client';
      button(modal.node, 'Connect').click(); await wait(() => modal.content.querySelector('a'));
      const oauth = JSON.parse(calls.find(call => call.path === '/api/oauth/start').options.body);
      check(oauth.clientId === 'p2-client' && oauth.storage === 'session' && oauth.allowedOrigins[0] === 'https://other.test', 'OAuth configuration lost origin or session scope.');
      check(modal.content.querySelector('a').rel.includes('noopener'), 'OAuth provider navigation must isolate the new tab.'); modal.node.close();
      cases.push('OAuth starts with endpoint and origin metadata and explicit provider navigation');
      modal = http.openCookies(); await wait(() => !button(modal.node, 'Apply persistence choice').disabled);
      const consent = modal.content.querySelector('input[type=checkbox]'); check(!consent.checked, 'Cookie persistence must be opt-in.'); consent.checked = true;
      button(modal.node, 'Apply persistence choice').click(); await wait(() => !button(modal.node, 'Apply persistence choice').disabled);
      const persistence = JSON.parse(calls.find(call => call.path === '/api/cookies/persistence').options.body);
      check(persistence.enabled === true && persistence.storage === 'keychain' && persistence.consent === true, 'Secure cookie persistence lost explicit consent.');
      cases.push('cookie persistence requires explicit keychain consent');
      window.confirm = () => false;
      button(modal.node, 'Forget saved cookies…').click();
      check(!calls.some(call => call.path === '/api/cookies/persistence' && call.options.method === 'DELETE'), 'Cancelled cookie removal still wrote.');
      window.confirm = () => true;
      button(modal.node, 'Forget saved cookies…').click(); await wait(() => modal.status.textContent.includes('Current session cookies were retained.'));
      const forgotten = calls.find(call => call.path === '/api/cookies/persistence' && call.options.method === 'DELETE');
      check(JSON.parse(forgotten.options.body).consent === true, 'Saved cookie removal lost explicit consent.'); modal.node.close();
      cases.push('saved cookie removal requires confirmation and retains session cookies');
      request.body = { mode: 'raw-json', raw: '{}' }; http.renderBody(host);
      const schema = host.querySelector('textarea'); schema.value = '{ invalid schema'; button(host, 'Apply schema and validate').click();
      await wait(() => !button(host, 'Apply schema and validate').disabled);
      check(!request.body.schema, 'Invalid schema was persisted.');
      check(host.querySelector('[role=status]').textContent.length > 0, 'Invalid schema had no inline error.');
      cases.push('invalid JSON schema retains input and cannot change request');
      return { verdict: 'PASS', cases, changes };
    } finally { window.confirm = originalConfirm; document.querySelectorAll('dialog.p2-dialog').forEach(node => { node.close(); node.remove(); }); host.remove(); }
  });
  assert.equal(result.verdict, 'PASS'); assert.equal(result.cases.length, 12);
  return result;
}

// Real Studio + real local backend acceptance. Use ONLY a disposable fixture workspace.
// targetUrl is a JSON echo endpoint that reports received headers and body bytes.
export async function verifyP2RealWorkflow(page, baseUrl, targetUrl, fixtureFilePath) {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const collectionId = `p2_browser_${suffix}`, itemId = `p2_request_${suffix}`;
  const label = `P2 session credential ${suffix}`, requestName = `P2 real workflow ${suffix}`;
  const secret = `p2-disposable-${suffix}`, cookieName = `p2_cookie_${suffix}`;
  const target = new URL(targetUrl), cases = [];
  let credentialId, selectedFileId;
  const call = async (route, method = 'GET', body) => {
    const response = await page.fetch(route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, `${method} ${route}: ${response.body}`);
    return JSON.parse(response.body || '{}');
  };
  const ready = async () => { await page.goto(baseUrl + '/studio'); await page.waitForFunction(() => performance.getEntriesByName('rea:studio-ready').length > 0); };
  const closeNative = async () => { await page.click('dialog.p2-dialog[open] > button'); await page.waitForFunction(() => !document.querySelector('dialog.p2-dialog[open]')); };
  // Ego supports terminal text selectors; identify labelled descendants in the
  // DOM first so the actual fill/click operations use plain CSS selectors.
  const fillDialog = async (labelText, value) => {
    await page.evaluate(label => {
      const node = [...document.querySelectorAll('dialog.p2-dialog[open] label')].find(item => item.querySelector('span')?.textContent === label)?.querySelector('input');
      if (!node) throw new Error(`Missing dialog field: ${label}`);
      document.getElementById('p2-fixture-dialog-field')?.removeAttribute('id'); node.id = 'p2-fixture-dialog-field';
    }, labelText);
    await page.fill('#p2-fixture-dialog-field', value);
  };
  const send = async () => { await page.click('#btn-send-main'); await page.waitForFunction(() => !document.getElementById('btn-send-main').disabled && /^2\d\d/.test(document.getElementById('res-status').textContent)); };
  const readResponse = () => page.evaluate(() => document.getElementById('res-body').textContent);
  const credentials = data => Array.isArray(data) ? data : data.credentials || data.items || [];
  const latestRequest = async () => { const col = await call(`/api/collections/${collectionId}`); return col.items.find(item => item.id === itemId).request; };
  try {
    await ready();
    await call('/api/collections', 'POST', { id: collectionId, name: `P2 acceptance ${suffix}`, variables: [], items: [{ id: itemId, name: requestName, request: { id: itemId, name: requestName, method: 'GET', url: target.href, headers: [], queryParams: [], auth: { type: 'none' }, body: { mode: 'none' } } }] });
    await ready(); await page.fill('#collection-search', requestName); await page.click(`[aria-label="GET ${requestName}"]`);
    await page.click('#btn-credentials');
    await page.waitForFunction(() => Boolean(document.querySelector('dialog.p2-dialog[open] input[type=password]')) && ![...document.querySelectorAll('dialog.p2-dialog[open] button')].find(button => button.textContent === 'Store credential').disabled);
    await fillDialog('Name', label);
    await fillDialog('Secret value', secret);
    await fillDialog('Allowed origins (comma separated)', target.origin);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('dialog.p2-dialog[open] label')].find(node => node.querySelector('span')?.textContent === 'Storage').querySelector('select').value), 'session');
    await page.click('dialog.p2-dialog[open] button:has-text("Store credential")');
    await page.waitForFunction(() => [...document.querySelectorAll('dialog.p2-dialog[open] .p2-card strong')].some(node => node.textContent.startsWith('P2 session credential')));
    const metadata = credentials(await call('/api/credentials')).find(entry => entry.label === label);
    assert.ok(metadata, 'Session credential created by real UI'); credentialId = metadata.id;
    assert.equal(metadata.storage, 'session'); assert.deepEqual(metadata.origins, [target.origin]);
    assert.equal('value' in metadata, false, 'Metadata listing exposes no raw value');
    const reference = metadata.reference; assert.match(reference, /^\{\{secret:[^{}]+\}\}$/);
    await closeNative();
    await page.click('[data-tab="auth"]'); await page.selectOption('#auth-type', 'bearer');
    assert.equal(await page.evaluate(() => document.querySelector('#auth-fields input').type), 'password');
    await page.fill('#auth-fields input[type=password]', reference);
    await page.click('#btn-save-req');
    await page.waitForFunction(() => !document.getElementById('btn-save-req').disabled && !document.getElementById('dirty-badge').offsetParent);
    const saved = await latestRequest(); assert.equal(saved.auth.bearerToken, reference); assert.equal(JSON.stringify(saved).includes(secret), false);
    await send(); assert.match(await readResponse(), /authorization/i);
    cases.push('real credential dialog stores session secret metadata; real auth control saves only reference and executes');

    await page.click('#btn-cookies');
    await page.waitForFunction(() => Boolean(document.querySelector('dialog.p2-dialog[open] input[type=checkbox]')) && ![...document.querySelectorAll('dialog.p2-dialog[open] button')].find(node => node.textContent === 'Set cookie').disabled);
    assert.equal(await page.evaluate(() => document.querySelector('dialog.p2-dialog[open] input[type=checkbox]').checked), false);
    await fillDialog('Cookie URL', target.href);
    await fillDialog('Set-Cookie value', `${cookieName}=first; Path=/; HttpOnly; SameSite=Lax`);
    await page.click('dialog.p2-dialog[open] button:has-text("Set cookie")');
    await page.waitForFunction(() => [...document.querySelectorAll('dialog.p2-dialog[open] .p2-card strong')].some(node => node.textContent.startsWith('p2_cookie_')));
    await page.evaluate(name => {
      const row = [...document.querySelectorAll('dialog.p2-dialog[open] .p2-card')].find(item => item.querySelector('strong')?.textContent === name);
      if (!row) throw new Error('Missing fixture cookie row.'); row.id = 'p2-fixture-cookie-row';
    }, cookieName);
    await page.fill('#p2-fixture-cookie-row input[type=password]', 'edited');
    await page.click('#p2-fixture-cookie-row button:has-text("Update cookie")');
    await page.waitForFunction(() => document.querySelector('dialog.p2-dialog[open] .p2-status').textContent === 'Cookie updated.');
    // An explicit failure injection tests refusal and input retention without touching OS keychain.
    await page.evaluate(() => {
      window.__p2RealFetch = window.fetch; window.__p2RealConfirm = window.confirm; window.__p2PersistenceConfirmation = ''; window.confirm = message => { window.__p2PersistenceConfirmation = message; return true; };
      window.fetch = (...args) => args[0] === '/api/cookies/persistence' ? Promise.resolve(new Response(JSON.stringify({ error: { code: 'FIXTURE_SECURE_PERSISTENCE_UNAVAILABLE', message: 'Secure persistence unavailable (injected fixture failure)' } }), { status: 503, headers: { 'Content-Type': 'application/json' } })) : window.__p2RealFetch(...args);
      const consent = document.querySelector('dialog.p2-dialog[open] input[type=checkbox]'); consent.checked = true; consent.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('dialog.p2-dialog[open] button:has-text("Apply persistence choice")');
    await page.waitForFunction(() => document.querySelector('dialog.p2-dialog[open] .p2-status').textContent.includes('injected fixture failure'));
    assert.equal(await page.evaluate(() => document.querySelector('dialog.p2-dialog[open] input[type=checkbox]').checked), true);
    await page.evaluate(() => { window.fetch = window.__p2RealFetch; delete window.__p2RealFetch; window.confirm = window.__p2RealConfirm; delete window.__p2RealConfirm; });
    await closeNative(); await send(); assert.match(await readResponse(), new RegExp(`${cookieName}=edited`));
    cases.push('real cookie create/edit is sent to matching peer; explicit persistence failure retains opt-in choice and reports refusal');

    await page.selectOption('#req-method', 'POST'); await page.click('[data-tab="body"]');
    await page.click('input[name=body-mode][value=binary]');
    await page.setInputFiles('#p2-body-controls input[type=file]', fixtureFilePath);
    await page.waitForFunction(() => /bytes selected/.test(document.getElementById('p2-body-controls').textContent));
    await page.click('#btn-save-req');
    await page.waitForFunction(() => !document.getElementById('btn-save-req').disabled && !document.getElementById('dirty-badge').offsetParent);
    const selected = await latestRequest(); selectedFileId = selected.body.fileId; assert.ok(selectedFileId);
    assert.equal(selected.body.mode, 'binary'); assert.equal(JSON.stringify(selected).includes(fixtureFilePath), false);
    await send();
    const download = await page.evaluate(() => document.querySelector('#p2-response-inspector a[download]')?.getAttribute('href'));
    assert.match(download || '', /^\/api\/responses\/[^/]+$/);
    const artifact = await page.fetch(download); assert.equal(artifact.status, 200); assert.ok(artifact.body.length);
    const binaryEcho = JSON.parse(await readResponse());
    assert.equal(binaryEcho.bodyBase64, 'AAH/f0FCCg==', 'Peer received exactly the native-picked fixture bytes');
    assert.equal(binaryEcho.size, 7);
    const downloadedEcho = JSON.parse(artifact.body); assert.equal(downloadedEcho.bodyBase64, binaryEcho.bodyBase64);
    cases.push('native picker uploads chosen file to real backend, saved binary body uses selection ID, streamed response exposes working artifact download');

    await page.click('input[name=body-mode][value=raw-json]');
    await page.fill('#req-body-raw', '{"message":"P2 validated"}');
    await page.click('#p2-body-controls summary');
    await page.fill('#p2-body-controls textarea', '{"type":"object","required":["message"],"properties":{"message":{"type":"string"}},"additionalProperties":false}');
    await page.click('#p2-body-controls button:has-text("Apply schema and validate")');
    await page.waitForFunction(() => document.querySelector('#p2-body-controls [role=status]').textContent.includes('matches the schema'));
    await page.click('#btn-save-req');
    await page.waitForFunction(() => !document.getElementById('btn-save-req').disabled && !document.getElementById('dirty-badge').offsetParent);
    assert.equal((await latestRequest()).body.schema.required[0], 'message');
    await send(); assert.match(await readResponse(), /P2 validated/);
    await page.fill('#req-body-raw', '{"message":7}');
    await page.click('#p2-body-controls button:has-text("Apply schema and validate")');
    await page.waitForFunction(() => { const node = document.querySelector('#p2-body-controls [role=status]'); return node.textContent && !node.textContent.includes('matches the schema'); });
    cases.push('real JSON schema editor validates, persists supported schema, sends valid body, and exposes mismatched value error');
    return { verdict: 'PASS', cases, evidence: { collectionId, credentialId, selectedFileId, targetOrigin: target.origin } };
  } finally {
    await page.evaluate(() => { if (window.__p2RealFetch) { window.fetch = window.__p2RealFetch; delete window.__p2RealFetch; } if (window.__p2RealConfirm) { window.confirm = window.__p2RealConfirm; delete window.__p2RealConfirm; } document.querySelectorAll('dialog.p2-dialog').forEach(node => node.close()); }).catch(() => {});
    await call('/api/cookies', 'PUT', { url: target.href, cookie: `${cookieName}=; Path=/; Max-Age=0` }).catch(() => {});
    if (selectedFileId) await call(`/api/files/${encodeURIComponent(selectedFileId)}`, 'DELETE').catch(() => {});
    if (credentialId) await call(`/api/credentials/${encodeURIComponent(credentialId)}`, 'DELETE').catch(() => {});
    await call(`/api/collections/${collectionId}`, 'DELETE').catch(() => {});
  }
}

export async function verifyP2OAuthWorkflow(task, page, baseUrl, providerUrl) {
  const suffix=Date.now(),id='p2_oauth_'+suffix,label='P2 OAuth '+suffix;
  const call=async(route,method='GET',body)=>{const response=await page.fetch('/api/'+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.equal(response.status,200,route+': '+response.body);return JSON.parse(response.body);};
  await page.goto(baseUrl+'/studio');await page.waitForFunction(()=>performance.getEntriesByName('rea:studio-ready').length);
  await call('collections','POST',{id,name:label,variables:[],items:[{id,name:label,request:{id,name:label,url:providerUrl+'/echo',method:'GET',headers:[],queryParams:[],auth:{type:'none'},body:{mode:'none'}}}]});
  let connection,popup;
  try{
    await page.reload();await page.waitForFunction(()=>performance.getEntriesByName('rea:studio-ready').length);await page.fill('#collection-search',label);await page.click(`[aria-label="GET ${label}"]`);await page.click('#btn-oauth');
    await page.waitForFunction(()=>![...document.querySelectorAll('dialog[open] button')].find(x=>x.textContent==='Connect').disabled);
    const fill=async(label,value)=>{await page.evaluate(label=>{const el=[...document.querySelectorAll('dialog[open] label')].find(x=>x.querySelector('span')?.textContent===label)?.querySelector('input');if(!el)throw Error('Missing '+label);el.id='p2-oauth-field';},label);await page.fill('#p2-oauth-field',value);await page.evaluate(()=>document.getElementById('p2-oauth-field').removeAttribute('id'));};
    for(const [name,value] of [['Connection name',label],['Issuer URL',providerUrl],['Authorization endpoint',providerUrl+'/authorize'],['Token endpoint',providerUrl+'/token'],['Revocation endpoint (optional)',providerUrl+'/revoke'],['Client ID','p2-public-client'],['Resource origins (comma separated)',providerUrl]])await fill(name,value);
    await page.click('dialog[open] button:text-is("Connect")');await page.waitForSelector('dialog[open] a[target="_blank"]');
    const authUrl=await page.evaluate(()=>document.querySelector('dialog[open] a[target="_blank"]').href);const auth=new URL(authUrl);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.ok(auth.searchParams.get('state'));assert.ok(auth.searchParams.get('nonce'));assert.equal(new URL(auth.searchParams.get('redirect_uri')).origin,baseUrl);
    const opened=page.waitForEvent('popup');await page.click('dialog[open] a[target="_blank"]');popup=await opened;await popup.waitForLoadState();
    assert.match(await popup.evaluate(()=>document.body.textContent),/Authorization complete/);
    // A consumed callback cannot be replayed.
    await popup.reload();assert.match(await popup.evaluate(()=>document.body.textContent),/did not complete/);await popup.close();popup=undefined;
    await page.click('dialog[open] button:has-text("Refresh connections")');await page.waitForFunction(label=>[...document.querySelectorAll('dialog[open] .p2-card strong')].some(x=>x.textContent===label),label);
    connection=(await call('oauth')).connections.find(x=>x.label===label);assert.ok(connection);assert.ok(!JSON.stringify(connection).includes('fixture-only-oauth-token'));
    await page.click('dialog[open] button:has-text("Use connection")');await page.click('#btn-save-req');await page.waitForFunction(()=>!document.getElementById('dirty-badge').offsetParent);
    await page.click('#btn-send-main');await page.waitForFunction(()=>!document.getElementById('btn-send-main').disabled&&/^200/.test(document.getElementById('res-status').textContent));
    assert.equal(JSON.parse(await page.evaluate(()=>document.getElementById('res-body').textContent)).headers.authorization,'Bearer fixture-only-oauth-token');
    await call('oauth/'+connection.id+'/revoke','POST',{consent:true});assert.ok(!(await call('oauth')).connections.some(x=>x.id===connection.id));connection=undefined;
    return {verdict:'PASS',cases:['real OAuth dialog PKCE state/nonce and owned callback URL','provider navigation completes callback and rejects replay','stored connection metadata omits tokens; selected connection sends bearer to approved peer','explicit provider revoke clears connection'],provider:'disposable local fake provider; insecure HTTP is enabled only by fixture constructor'};
  }finally{if(popup)await popup.close().catch(()=>{});if(connection)await call('oauth/'+connection.id+'/clear','POST',{consent:true}).catch(()=>{});await call('collections/'+id,'DELETE').catch(()=>{});}
}
