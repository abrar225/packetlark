import assert from 'node:assert/strict';

/** Ego Page API harness; use only against the disposable P1 fixture server. */
export async function verifyWorkspaceAuthoring(page, baseUrl) {
  await page.goto(baseUrl + '/studio');
  const created = [];
  const open = async (id, itemId = '') => {
    await page.click('[aria-label="Manage collections"]');
    await page.selectOption('[aria-label="Collection"]', id);
    if (itemId) await page.selectOption('[aria-label="Item"]', itemId);
  };
  const submit = async () => {
    await page.click('[data-workspace-authoring] button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('modal-backdrop').style.display !== 'flex');
  };
  const list = async () => JSON.parse((await page.fetch('/api/collections')).body);
  let cases = 0;
  try {
    await open('');
    await page.selectOption('[aria-label="Action"]', 'createCollection');
    const name = `Authoring disposable ${Date.now()}`;
    await page.fill('[aria-label="Name"]', name);
    await submit();
    let col = (await list()).find((col) => col.name === name);
    assert.ok(col); created.push(col.id); cases++;

    await open(col.id);
    await page.selectOption('[aria-label="Action"]', 'createFolder');
    await page.fill('[aria-label="Name"]', 'Nested <script>safe</script>');
    await submit();
    col = (await list()).find((item) => item.id === col.id);
    const folderId = col.items[0].id;
    assert.equal(col.items[0].name, 'Nested <script>safe</script>'); cases++;

    await open(col.id, folderId);
    await page.selectOption('[aria-label="Action"]', 'createRequest');
    await page.fill('[aria-label="Name"]', 'Authored request');
    await page.selectOption('[aria-label="Destination folder"]', folderId);
    await submit();
    col = (await list()).find((item) => item.id === col.id);
    const requestId = col.items[0].items[0].id;
    assert.equal(col.items[0].items[0].request.auth.type, 'inherit'); cases++;

    await open(col.id, requestId);
    await page.selectOption('[aria-label="Action"]', 'duplicate');
    await page.fill('[aria-label="Name"]', 'Duplicated request');
    await page.selectOption('[aria-label="Destination folder"]', folderId);
    await submit();
    col = (await list()).find((item) => item.id === col.id);
    assert.equal(col.items[0].items.length, 2);
    const duplicate = col.items[0].items[1];
    assert.notEqual(duplicate.id, requestId);
    assert.notEqual(duplicate.request.id, col.items[0].items[0].request.id); cases++;

    await open(col.id, duplicate.id);
    await page.selectOption('[aria-label="Action"]', 'move');
    await page.selectOption('[aria-label="Destination folder"]', '');
    await page.fill('[aria-label="Position (zero based; blank appends)"]', '0');
    await submit();
    col = (await list()).find((item) => item.id === col.id);
    assert.equal(col.items[0].id, duplicate.id); cases++;

    await open(col.id, folderId);
    await page.selectOption('[aria-label="Action"]', 'settings');
    await page.selectOption('[aria-label="Inherited auth type"]', 'bearer');
    await page.fill('#inherited-auth-controls input[type=password]', 'fixture');
    await page.fill('[aria-label="Inherited variables (JSON array)"]', '[{"key":"fixture","value":"retained"}]');
    await page.fill('[aria-label="Inherited test script"]', 'pm.test("folder",()=>{});');
    await page.evaluate(() => { window.__authoringConfirm = window.confirm; window.__authoringPlaintextConsent = ''; window.confirm = message => { window.__authoringPlaintextConsent = message; return true; }; });
    await submit();
    assert.match(await page.evaluate(() => window.__authoringPlaintextConsent), /plaintext/);
    await page.evaluate(() => { window.confirm = window.__authoringConfirm; delete window.__authoringConfirm; delete window.__authoringPlaintextConsent; });
    col = (await list()).find((item) => item.id === col.id);
    assert.equal(col.items[1].auth.bearerToken, 'fixture');
    assert.equal(col.items[1].testScript, 'pm.test("folder",()=>{});'); cases++;

    await open(col.id, folderId);
    await page.selectOption('[aria-label="Action"]', 'move');
    await page.selectOption('[aria-label="Destination folder"]', folderId);
    await page.click('[data-workspace-authoring] button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('[data-workspace-authoring] [role="status"]').textContent.includes('descendants'));
    assert.equal(await page.evaluate(() => document.querySelector('[aria-label="Destination folder"]').value), folderId);
    await page.click('[data-workspace-authoring] button:text-is("Close")'); cases++;

    await open(col.id, duplicate.id);
    await page.selectOption('[aria-label="Action"]', 'delete');
    await page.click('[aria-label="Confirm deletion"]');
    await submit();
    col = (await list()).find((item) => item.id === col.id);
    assert.equal(col.items.length, 1); assert.equal(col.items[0].id, folderId); cases++;
    return { cases, verdict: 'PASS' };
  } finally {
    await page.evaluate(() => { if (window.__authoringConfirm) { window.confirm = window.__authoringConfirm; delete window.__authoringConfirm; delete window.__authoringPlaintextConsent; } }).catch(() => {});
    // Only remove the uniquely created disposable collections, with latest revisions.
    for (const id of created) {
      const col = (await list()).find((item) => item.id === id);
      if (col) await page.fetch(`/api/collections/${id}`, { method: 'DELETE', headers: { 'If-Match': `"${col.revision}"` } });
    }
  }
}
