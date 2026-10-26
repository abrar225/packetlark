import assert from 'node:assert/strict';

// Public DOM/HTTP/IndexedDB checks. Use disposable p0-browser-fixture roots only.
const ready = async (page, base) => {
  await page.goto(base + '/studio');
  await page.waitForFunction(() => performance.getEntriesByName('packetlark:studio-ready').length);
  await page.evaluate(() => { window.__alerts = []; window.alert = (text) => window.__alerts.push(text); window.confirm = () => true; });
};
const api = async (base, route, method = 'GET', body) => {
  const res = await fetch(base + '/api/' + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(res.status, 200, `${method} ${route}`); return res.json();
};
const body = (page) => page.evaluate(() => document.getElementById('res-body').textContent);
const closed = (page) => page.waitForFunction(() => document.getElementById('modal-backdrop').style.display !== 'flex');
const examples = (page) => page.evaluate(async () => {
  const { id } = await (await fetch('/api/workspace/identity')).json();
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('packetlark-reviewed-examples-v1', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction('examples'); const req = tx.objectStore('examples').index('workspace').getAll(IDBKeyRange.only(id)); req.onsuccess = () => resolve(req.result); tx.oncomplete = () => db.close(); };
  });
});

export async function verifyWorkbench(page, base) {
  const cases = [];
  await ready(page, base);
  await page.click('[aria-label="GET Race A"]');
  // Hold only the HTTP adapter response; deliberately permit completion after switching tabs.
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await native(...args);
      if (args[0] === '/api/execute' && JSON.parse(args[1].body).request.id === 'race_a') {
        window.__aStarted = true;
        await new Promise((resolve) => window.__releaseA = resolve);
      }
      return res;
    };
  });
  await page.click('#btn-send-main'); await page.waitForFunction(() => window.__aStarted);
  await page.click('[aria-label="GET Race B"]'); await page.click('#btn-send-main');
  await page.waitForFunction(() => document.getElementById('res-body').textContent.includes('/fast-b'));
  await page.evaluate(() => window.__releaseA());
  await page.waitForFunction(() => !document.querySelector('[aria-label="Request tab: Race A"]').textContent.includes('…'));
  assert.match(await body(page), /fast-b/);
  await page.click('[aria-label="Request tab: Race A"]'); assert.match(await body(page), /slow-a/);
  cases.push('late execution retains its owning response while another tab remains selected');
  const original = await page.evaluate(() => document.getElementById('req-url').value);
  await page.fill('#req-url', original + '?undo=1'); await page.click('#btn-undo-draft');
  assert.equal(await page.evaluate(() => document.getElementById('req-url').value), original);
  cases.push('request undo restores the previous edit without changing identity');
  await page.evaluate(() => window.confirm = () => false);
  await page.click('[aria-label="Close request tab: Race A"]');
  assert.equal(await page.evaluate(() => !!document.querySelector('[aria-label="Request tab: Race A"]')), true);
  await page.evaluate(() => window.confirm = () => true);
  await page.click('[aria-label="Close request tab: Race A"]');
  assert.equal(await page.evaluate(() => !!document.querySelector('[aria-label="Request tab: Race A"]')), false);
  cases.push('dirty tab close supports cancel and explicit discard');
  await page.click('[aria-label="Request tab: Race B"]');
  const url = await page.evaluate(() => document.getElementById('req-url').value);
  await page.fill('#req-url', url + '?api_key=p1-example-credential-987654');
  await page.click('#btn-send-main');
  await page.waitForFunction(() => !document.getElementById('btn-send-main').disabled && document.getElementById('res-body').textContent.includes('p1-example-credential'));
  const before = await examples(page);
  await page.click('#btn-save-example');
  await page.waitForSelector('#modal-body pre');
  const preview = await page.evaluate(() => document.querySelector('#modal-body pre').textContent);
  assert.doesNotMatch(preview, /p1-example-credential-987654/);
  assert.equal((await examples(page)).length, before.length);
  await page.evaluate(() => window.confirm = () => false);
  await page.click('text="Save reviewed example"');
  assert.equal((await examples(page)).length, before.length);
  await page.evaluate(() => window.confirm = () => true);
  await page.click('text="Save reviewed example"'); await closed(page);
  assert.equal((await examples(page)).length, before.length + 1);
  cases.push('example preview excludes known credentials and writes only after explicit confirmation');
  await ready(page, base);
  await page.click('#btn-request-history');
  await page.waitForSelector('text="Reviewed examples"');
  assert.match(await page.evaluate(() => document.getElementById('modal-body').textContent), /Race B/);
  // After navigation only the reviewed example remains, because history is page-only.
  await page.click('#modal-body button:has-text("Race B")');
  await page.click('text="Open request copy (unsaved)"'); await closed(page);
  const copyName = await page.evaluate(() => document.getElementById('request-name').textContent);
  assert.match(copyName, /history copy/);
  assert.equal((await api(base, 'collections')).some((col) => JSON.stringify(col).includes('(history copy)')), false);
  await page.click(`[aria-label="Close request tab: ${copyName}"]`);
  assert.doesNotMatch(await page.evaluate(() => document.getElementById('collection-tree').textContent), /history copy/);
  cases.push('reviewed examples survive reload; reopening and discarding a copy never writes or leaves a phantom request');
  await page.click('#btn-request-history'); await page.waitForSelector('text="Delete example"');
  await page.click('text="Delete example"');
  await page.waitForFunction(() => ![...document.querySelectorAll('#modal-body button')].some((b) => b.textContent === 'Delete example'));
  assert.equal((await examples(page)).length, before.length);
  await page.keyboard.press('Escape');
  cases.push('saved example deletion is explicit and scoped to its record');
  await page.click('[aria-label="GET Race A"]');
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    window.fetch = (...args) => args[0] === '/api/execute'
      ? new Promise((_, reject) => args[1].signal.addEventListener('abort', () => reject(new DOMException('Cancelled by fixture', 'AbortError')), { once: true }))
      : native(...args);
  });
  await page.click('#btn-send-main');
  await page.waitForSelector('#cancel-request', { state: 'visible' }); await page.click('#cancel-request');
  await page.waitForFunction(() => !document.getElementById('btn-send-main').disabled);
  assert.match(await page.evaluate(() => document.getElementById('res-status').textContent), /Cancelled/);
  cases.push('selected execution cancellation remains visible and clears only its owning operation');
  return { verdict: 'PASS', cases };
}

export async function verifyTabLimit(page, base) {
  const id = 'p1_tab_limit';
  await api(base, 'collections', 'POST', { id, name: 'Tab limit', variables: [], items: Array.from({ length: 22 }, (_, i) => ({ id: 'limit_' + i, name: 'Limit ' + i, request: { id: 'limit_' + i, name: 'Limit ' + i, method: 'GET', url: 'https://example.test/' + i, headers: [], queryParams: [], body: { mode: 'none' }, auth: { type: 'none' } } })) });
  try {
    await ready(page, base);
    for (let i = 0; i < 20; i++) { await page.fill('#collection-search', 'Limit ' + i); await page.click(`[aria-label="GET Limit ${i}"]`); }
    assert.equal(await page.evaluate(() => document.querySelectorAll('#request-tabs [role="tab"]').length), 20);
    assert.match(await page.evaluate(() => window.__alerts.join(' ')), /20 request tabs/);
    await page.click('[aria-label="Close request tab: Limit 0"]');
    await page.fill('#collection-search', 'Limit 21'); await page.click('[aria-label="GET Limit 21"]');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#request-tabs [role="tab"]').length), 20);
    await page.press('[aria-label="Request tab: Limit 21"]', 'Home');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'tab');
    return { verdict: 'PASS', cases: ['20-tab limit refuses another tab without losing existing drafts', 'closing a tab frees capacity and tabs support keyboard navigation'] };
  } finally { await api(base, 'collections/' + id, 'DELETE'); }
}

export async function verifyInheritedMove(page, base) {
  const cols = await api(base, 'collections'); const race = cols.find((c) => c.id === 'race_fixture');
  const source = { ...race, items: [{ id: 'scope_folder', name: 'Scope folder', isFolder: true, variables: [{ key: 'scope', value: 'folder' }], auth: { type: 'bearer', bearerToken: 'p1-inherited-token' }, preRequestScript: 'pm.variables.set("scope", "runtime");', testScript: 'pm.test("inherited assertion", () => pm.expect(pm.response.code).to.equal(200));', items: [{ ...race.items[1], request: { ...race.items[1].request, auth: { type: 'inherit' }, url: race.items[1].request.url + '?scope={{scope}}' } }] }] };
  const dest = { id: 'p1_move_destination', name: 'Move destination', variables: [], items: [] };
  await api(base, 'collections/race_fixture', 'PUT', source); await api(base, 'collections', 'POST', dest);
  await api(base, 'environments', 'POST', { id: 'p1_scope_env', name: 'Scope environment', values: [{ key: 'scope', value: 'environment', enabled: true }] });
  try {
    await ready(page, base); await page.selectOption('#env-select', 'p1_scope_env'); await page.click('[aria-label="GET Race B"]'); await page.click('#btn-send-main');
    await page.waitForFunction(() => document.getElementById('res-body').textContent.includes('scope=runtime'));
    assert.match(await body(page), /p1-inherited-token/);
    await page.click('[data-res-tab="tests"]');
    assert.match(await page.evaluate(() => document.getElementById('res-tests').textContent), /inherited assertion/);
    await page.click('[aria-label="Manage collections"]'); await page.selectOption('[aria-label="Collection"]', 'race_fixture'); await page.selectOption('[aria-label="Item"]', 'race_b'); await page.selectOption('[aria-label="Action"]', 'crossMove'); await page.selectOption('[aria-label="Destination collection"]', dest.id); await page.selectOption('[aria-label="Destination folder"]', '');
    await page.click('[data-workspace-authoring] button[type="submit"]'); await closed(page);
    assert.equal(await page.evaluate(() => document.getElementById('collection-name').textContent), dest.name);
    await page.click('[data-res-tab="body"]'); assert.match(await body(page), /scope=runtime/);
    const current = await api(base, 'collections');
    assert.equal(current.find((c) => c.id === dest.id).items[0].request.id, 'race_b');
    assert.equal(current.find((c) => c.id === 'race_fixture').items[0].items.length, 0);
    return { verdict: 'PASS', cases: ['inherited folder authentication, runtime variables and scripts affect real transport', 'manifest cross-collection move preserves request identity, selected tab and owned response'] };
  } finally {
    const latest = (await api(base, 'collections')).find((col) => col.id === race.id);
    await api(base, 'collections/race_fixture', 'PUT', { ...race, revision: latest.revision }); await api(base, 'collections/' + dest.id, 'DELETE'); await api(base, 'environments/p1_scope_env', 'DELETE');
  }
}

export async function verifyEnvironmentCrud(page, base) {
  await ready(page, base);
  await page.selectOption('#env-select', '__manage__');
  await page.evaluate(() => {
    window.prompt = () => 'P1 environment';
    const native = window.fetch.bind(window);
    window.__failCreate = true;
    window.fetch = (...args) => args[0] === '/api/environments' && args[1]?.method === 'POST' && window.__failCreate
      ? Promise.resolve(new Response(JSON.stringify({ error: 'Injected create failure' }), { status: 500 })) : native(...args);
  });
  await page.click('text="+ New Environment"');
  await page.waitForFunction(() => window.__alerts.some((text) => text.includes('not created')));
  assert.equal((await api(base, 'environments')).some((env) => env.name === 'P1 environment'), false);
  await page.evaluate(() => window.__failCreate = false);
  await page.click('text="+ New Environment"'); await page.waitForSelector('[aria-label="Environment name"]');
  const env = (await api(base, 'environments')).find((env) => env.name === 'P1 environment'); assert.ok(env);
  try {
    await page.fill('[aria-label="Environment name"]', 'P1 environment renamed');
    await page.click('text="+ Add Variable"');
    await page.fill('[aria-label="Variable name 2"]', 'fixtureCredential');
    await page.fill('[aria-label="Variable value 2"]', 'p1-hidden-value-987654');
    await page.click('[aria-label="Mark variable secret"] >> nth=1');
    await page.waitForFunction(() => document.getElementById('env-save-status').textContent === 'Environment saved');
    assert.equal(await page.evaluate(() => document.querySelector('[aria-label="Variable value 2"]').type), 'password');
    let saved = (await api(base, 'environments')).find((value) => value.id === env.id);
    assert.equal(saved.name, 'P1 environment renamed'); assert.equal(saved.values[1].secret, true); assert.equal(saved.values[1].value, 'p1-hidden-value-987654');
    assert.match(await page.evaluate(() => document.querySelector('.scope-diagnostics').textContent), /plaintext.*P2/);
    await page.click('text="Done"'); await page.selectOption('#env-select', env.id); await page.click('[aria-label="Environment variables"]');
    assert.doesNotMatch(await page.evaluate(() => document.getElementById('modal-body').textContent), /p1-hidden-value-987654/);
    await page.keyboard.press('Escape'); await page.selectOption('#env-select', '__manage__');
    await page.click('[aria-label="Remove variable 2"]');
    await page.waitForFunction(() => document.getElementById('env-save-status').textContent === 'Environment saved');
    saved = (await api(base, 'environments')).find((value) => value.id === env.id); assert.equal(saved.values.length, 1);
    // Hold the HTTP deletion response, close its manager, then open another dialog.
    await page.evaluate(() => {
      const native = window.fetch.bind(window);
      window.fetch = async (...args) => { const response = await native(...args); if (args[1]?.method === 'DELETE' && String(args[0]).startsWith('/api/environments/')) { window.__deleteStarted = true; await new Promise((resolve) => window.__releaseDelete = resolve); } return response; };
      [...document.querySelectorAll('.env-item-select')].find((button) => button.textContent.includes('P1 environment renamed')).parentElement.querySelector('[aria-label="Delete environment"]').click();
    });
    await page.waitForFunction(() => window.__deleteStarted);
    await page.keyboard.press('Escape'); await page.click('#btn-request-history');
    await page.evaluate(() => window.__releaseDelete());
    await page.waitForFunction((id) => ![...document.querySelectorAll('#env-select option')].some((option) => option.value === id), env.id);
    assert.equal(await page.evaluate(() => document.getElementById('modal-title').textContent), 'Request history and examples');
    assert.equal((await api(base, 'environments')).some((value) => value.id === env.id), false);
    return { verdict: 'PASS', cases: ['failed environment create reports failure without adding a phantom environment', 'environment create/rename/variable edit/remove and secret preview masking persist correctly', 'late environment deletion never replaces a subsequently opened dialog'] };
  } finally { if ((await api(base, 'environments')).some((value) => value.id === env.id)) await api(base, 'environments/' + env.id, 'DELETE'); }
}

export async function verifyDragAuthoring(page, base) {
  const id = 'p1_drag_fixture';
  const request = (key) => ({ id: key.replaceAll(' ', '_').toLowerCase(), name: key, request: { id: key.replaceAll(' ', '_').toLowerCase(), name: key, method: 'GET', url: 'https://example.test/' + encodeURIComponent(key), headers: [], queryParams: [], body: { mode: 'none' }, auth: { type: 'inherit' } } });
  await api(base, 'collections', 'POST', { id, name: 'Drag fixture', variables: [], items: [request('Drag A'), request('Drag B'), { id: 'drag_folder', name: 'Drag folder', isFolder: true, items: [{ id: 'drag_child', name: 'Drag child', isFolder: true, items: [] }] }] });
  const read = async () => (await api(base, 'collections')).find((col) => col.id === id);
  const row = async (name) => {
    const index = await page.evaluate((name) => document.querySelector(`[aria-label="Actions for ${name}"]`).closest('[data-tree-index]').dataset.treeIndex, name);
    return `[data-tree-index="${index}"]`;
  };
  const drag = async (source, target) => page.dragAndDrop(await row(source), await row(target));
  try {
    await ready(page, base); await page.fill('#collection-search', 'Drag fixture');
    await drag('Drag A', 'Drag folder');
    await page.waitForFunction(async () => (await (await fetch('/api/collections/p1_drag_fixture')).json()).items.find((item) => item.id === 'drag_folder').items.some((item) => item.id === 'drag_a'));
    await drag('Drag B', 'Drag A');
    await page.waitForFunction(async () => (await (await fetch('/api/collections/p1_drag_fixture')).json()).items.find((item) => item.id === 'drag_folder').items[1]?.id === 'drag_b');
    let current = await read();
    assert.deepEqual(current.items[0].items.map((item) => item.id), ['drag_child', 'drag_b', 'drag_a']);
    const before = structuredClone(current);
    await drag('Drag folder', 'Drag child');
    await page.waitForFunction(() => window.__alerts.some((text) => text.includes('descendants')));
    assert.deepEqual(await read(), before);
    await page.click('[aria-label="GET Drag A"]'); await page.fill('#req-url', 'https://example.test/dirty-drag');
    await drag('Drag A', 'Drag fixture');
    await page.waitForFunction(() => window.__alerts.some((text) => text.includes('drafts')));
    assert.deepEqual(await read(), before);
    assert.equal(await page.evaluate(() => document.getElementById('req-url').value), 'https://example.test/dirty-drag');
    await ready(page, base); await page.fill('#collection-search', 'Drag fixture');
    await page.evaluate(() => {
      const native = window.fetch.bind(window);
      window.fetch = (...args) => args[0] === '/api/collections/p1_drag_fixture' && args[1]?.method === 'PUT' ? Promise.resolve(new Response(JSON.stringify({ error: 'Injected drag write failure' }), { status: 500 })) : native(...args);
    });
    await drag('Drag A', 'Drag fixture');
    await page.waitForFunction(() => window.__alerts.some((text) => text.includes('Injected drag write failure')));
    assert.deepEqual(await read(), before);
    return { verdict: 'PASS', input: 'Ego Page.dragAndDrop native HTML5 gesture', cases: ['native drag moves a request into a folder without changing IDs', 'drop on a request inserts before it in canonical order', 'folder cycle drop is rejected without mutation', 'dirty draft blocks structural drop and retains its input', 'failed drop commit preserves the canonical collection'] };
  } finally { await api(base, 'collections/' + id, 'DELETE'); }
}

export async function verifyAutomaticWorkspaceWatch(page, base) {
  const id = 'p1_polling_fixture';
  let col = await api(base, 'collections', 'POST', { id, name: 'Polling fixture', variables: [], items: [{ id: 'polling_request', name: 'Polling request', request: { id: 'polling_request', name: 'Polling request', method: 'GET', url: 'https://example.test/original', headers: [], queryParams: [], body: { mode: 'none' }, auth: { type: 'none' } } }] });
  try {
    await ready(page, base); await page.fill('#collection-search', 'Polling fixture'); await page.click('[aria-label="GET Polling request"]');
    for (const url of ['https://example.test/intermediate', 'https://example.test/last-external']) {
      col.items[0].request.url = url; col = await api(base, 'collections/' + id, 'PUT', col);
    }
    await page.waitForFunction(() => document.getElementById('req-url').value === 'https://example.test/last-external', undefined, { timeout: 12000 });
    await page.fill('#req-url', 'https://example.test/local-dirty');
    col.items[0].request.url = 'https://example.test/new-external-context'; await api(base, 'collections/' + id, 'PUT', col);
    await page.waitForSelector('[aria-label="Review workspace changes"]', { timeout: 12000 });
    assert.equal(await page.evaluate(() => document.getElementById('req-url').value), 'https://example.test/local-dirty');
    return { verdict: 'PASS', cases: ['automatic conditional polling observes the latest external revision without a manual refresh', 'automatic change detection retains dirty input and presents explicit conflict review'] };
  } finally { await api(base, 'collections/' + id, 'DELETE'); }
}

export async function verifyBusyWorkspaceWatch(page, base) {
  let col = (await api(base, 'collections')).find((col) => col.id === 'race_fixture');
  const original = structuredClone(col);
  try {
    await ready(page, base); await page.click('[aria-label="GET Race A"]');
    const originalUrl = await page.evaluate(() => document.getElementById('req-url').value);
    await page.evaluate(() => {
      const native = window.fetch.bind(window);
      window.fetch = async (...args) => { const response = await native(...args); if (args[0] === '/api/execute') { window.__busyStarted = true; await new Promise((resolve) => window.__releaseBusy = resolve); } return response; };
    });
    await page.click('#btn-send-main'); await page.waitForFunction(() => window.__busyStarted);
    col.items[0].request.url = originalUrl + '?external=updated'; await api(base, 'collections/race_fixture', 'PUT', col);
    await page.click('#btn-check-workspace'); await page.waitForFunction(() => !document.getElementById('btn-check-workspace').disabled);
    assert.equal(await page.evaluate(() => document.getElementById('req-url').value), originalUrl);
    await page.click('[aria-label="GET Race B"]'); await page.click('[aria-label="Request tab: Race A"]');
    assert.equal(await page.evaluate(() => document.getElementById('btn-send-main').disabled), true);
    await page.evaluate(() => window.__releaseBusy());
    await page.waitForFunction(() => !document.getElementById('btn-send-main').disabled);
    assert.match(await body(page), /slow-a/);
    await page.click('#btn-check-workspace');
    await page.waitForFunction((url) => document.getElementById('req-url').value === url, originalUrl + '?external=updated');
    assert.match(await body(page), /context changed on disk/);
    return { verdict: 'PASS', cases: ['external refresh retains a clean running draft and its controller across tab switches', 'settled execution invalidates the polling ETag and clears an old-context response when adopting disk changes'] };
  } finally {
    const latest = (await api(base, 'collections')).find((value) => value.id === col.id);
    await api(base, 'collections/' + col.id, 'PUT', { ...original, revision: latest.revision });
  }
}
