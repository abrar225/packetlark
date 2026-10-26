import assert from 'node:assert/strict';

// Disposable-workspace browser acceptance. OAuth metadata is explicitly doubled;
// parent settings, session credential storage and collection commits use real APIs.
export async function verifyP2InheritedAuth(page, baseUrl) {
  const id = `p2_inherited_${Date.now()}`, folderId = `${id}_folder`, cases = [];
  let credentialId;
  const call = async (route, method = 'GET', body) => {
    const response = await page.fetch(route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, `${method} ${route}: ${response.body}`); return JSON.parse(response.body);
  };
  const open = async folder => {
    await page.click('[aria-label="Manage collections"]');
    await page.selectOption('[aria-label="Collection"]', id);
    if (folder) await page.selectOption('[aria-label="Item"]', folderId);
    await page.selectOption('[aria-label="Action"]', 'settings');
  };
  const apply = async () => { await page.click('[data-workspace-authoring] button[type=submit]'); await page.waitForFunction(() => document.getElementById('modal-backdrop').style.display !== 'flex'); };
  const latest = () => call(`/api/collections/${id}`);
  try {
    await page.goto(baseUrl + '/studio'); await page.waitForFunction(() => Boolean(window.PacketLarkWorkspaceAuthoring));
    await call('/api/collections', 'POST', { id, name: id, auth: { type: 'bearer', bearerToken: 'p2-parent-plaintext' }, variables: [{ key: 'api_token', value: 'p2-variable-plaintext', secret: true }], items: [{ id: folderId, name: 'Parent folder', isFolder: true, auth: { type: 'unsupported', originalType: 'digest', postman: { digest: [{ key: 'realm', value: 'opaque' }] } }, items: [] }] });
    await page.goto(baseUrl + '/studio'); await page.waitForFunction(() => performance.getEntriesByName('packetlark:studio-ready').length > 0);
    await open(false);
    assert.equal(await page.evaluate(() => document.querySelector('#inherited-auth-controls input[type=password]').value), 'p2-parent-plaintext');
    assert.equal(await page.evaluate(() => document.querySelector('[aria-label="Inherited variables (JSON array)"]').hidden), true);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('[aria-label="Inherited auth (JSON)"]'))), false);
    await page.evaluate(() => { window.__p2ParentConfirm = window.confirm; window.__p2ParentMessage = ''; window.confirm = message => { window.__p2ParentMessage = message; return false; }; });
    await page.click('[data-workspace-authoring] button[type=submit]');
    assert.match(await page.evaluate(() => window.__p2ParentMessage), /plaintext/);
    assert.equal((await latest()).auth.bearerToken, 'p2-parent-plaintext');
    await page.evaluate(() => { window.confirm = message => { window.__p2ParentMessage = message; return true; }; });
    await page.click('[data-workspace-authoring] button:text-is("Reveal inherited variables")');
    assert.match(await page.evaluate(() => window.__p2ParentMessage), /Reveal plaintext/);
    await page.fill('[aria-label="Inherited variables (JSON array)"]', '[]');
    cases.push('parent auth uses sensitive input; sensitive variables require confirmed reveal; plaintext save cancellation retains source');

    await page.click('#inherited-auth-controls button:text-is("Store and replace with reference")');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('dialog.p2-dialog[open] label')].find(label => label.querySelector('span')?.textContent === 'Allowed origins (comma separated)').querySelector('input').value), '');
    await page.evaluate(() => { const node = [...document.querySelectorAll('dialog.p2-dialog[open] label')].find(label => label.querySelector('span')?.textContent === 'Allowed origins (comma separated)').querySelector('input'); node.id = 'p2-parent-origins'; });
    await page.fill('#p2-parent-origins', 'https://parent.example.test');
    await page.click('dialog.p2-dialog[open] button:text-is("Store and replace")');
    await page.waitForFunction(() => !document.querySelector('dialog.p2-dialog[open]'));
    const reference = await page.evaluate(() => document.querySelector('#inherited-auth-controls input[type=password]').value);
    assert.match(reference, /^\{\{secret:[^{}]+\}\}$/); credentialId = reference.slice(9, -2);
    await apply();
    const collection = await latest(); assert.equal(collection.auth.bearerToken, reference); assert.deepEqual(collection.variables, []);
    assert.equal(JSON.stringify(collection).includes('p2-parent-plaintext'), false);
    cases.push('parent store-and-replace requires entered origin and commits its session reference without plaintext');

    await open(true);
    assert.equal(await page.evaluate(() => document.querySelector('[aria-label="Inherited auth type"]').value), 'unsupported');
    const opaqueAuth = (await latest()).items[0].auth;
    await apply(); assert.deepEqual((await latest()).items[0].auth, opaqueAuth);
    cases.push('unsupported inherited authorization remains opaque and unchanged until an explicit mode change');
    await open(true); await page.selectOption('[aria-label="Inherited auth type"]', 'oauth2');
    await page.evaluate(() => { window.__p2ParentFetch = window.fetch; window.fetch = (...args) => args[0] === '/api/oauth' ? Promise.resolve(new Response(JSON.stringify({ connections: [{ id: '00000000-0000-4000-8000-000000000099', label: 'P2 parent OAuth metadata fixture' }] }), { headers: { 'Content-Type': 'application/json' } })) : window.__p2ParentFetch(...args); });
    await page.click('#inherited-auth-controls button:text-is("Manage OAuth connections")');
    await page.waitForFunction(() => [...document.querySelectorAll('dialog.p2-dialog[open] button')].some(button => button.textContent === 'Use connection' && !button.disabled));
    await page.click('dialog.p2-dialog[open] button:text-is("Use connection")');
    await apply();
    assert.deepEqual((await latest()).items[0].auth, { type: 'oauth2', oauthConnectionId: '00000000-0000-4000-8000-000000000099' });
    cases.push('OAuth metadata picker attaches to detached folder auth and Apply persists that same object');
    return { verdict: 'PASS', cases };
  } finally {
    await page.evaluate(() => { if (window.__p2ParentFetch) { window.fetch = window.__p2ParentFetch; delete window.__p2ParentFetch; } if (window.__p2ParentConfirm) { window.confirm = window.__p2ParentConfirm; delete window.__p2ParentConfirm; } document.querySelectorAll('dialog.p2-dialog').forEach(node => node.close()); }).catch(() => {});
    if (credentialId) await call(`/api/credentials/${credentialId}`, 'DELETE').catch(() => {});
    await call(`/api/collections/${id}`, 'DELETE').catch(() => {});
  }
}
