import assert from "node:assert/strict";

// Public DOM/HTTP/IndexedDB boundaries, disposable fixture only. Storage cleanup
// deletes only this fixture workspace's recovery keys; never clears site/profile data.
async function storage(page, action = "read", value) {
  return page.evaluate(async ({ action, value }) => {
    const { id } = await (await fetch("/api/workspace/identity")).json();
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("rea-draft-recovery-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("records", action === "read" ? "readonly" : "readwrite");
        const store = transaction.objectStore("records");
        let result;
        const request = store.index("workspace").getAll(IDBKeyRange.only(id));
        request.onsuccess = () => {
          const records = request.result;
          result = records.filter((record) => record.snapshot);
          if (action === "reset") for (const record of records) store.delete(record.id);
          if (action === "put") store.put({ ...value, workspace: id });
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, { action, value });
}

async function ready(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.waitForFunction(() => performance.getEntriesByName("rea:studio-ready").length > 0);
  await page.evaluate(() => {
    window.confirm = () => true;
    window.__recoveryAlerts = [];
    window.alert = (text) => window.__recoveryAlerts.push(text);
    window.__recoveryWrites = [];
    const native = window.fetch.bind(window);
    window.fetch = (...args) => {
      if (["POST", "PUT", "DELETE"].includes(args[1]?.method)) window.__recoveryWrites.push(String(args[0]));
      return native(...args);
    };
  });
}

async function fresh(page, baseUrl) {
  await ready(page, baseUrl);
  await storage(page, "reset");
  await ready(page, baseUrl);
  await page.fill("#collection-search", "Race A");
  await page.click('[aria-label="GET Race A"]');
}

async function enable(page) {
  await page.click("#btn-draft-recovery");
  await page.click('text="Enable local draft recovery"');
  await page.click('[aria-label="Close dialog"]');
}

const saved = (page) => page.waitForFunction(() => document.getElementById("draft-recovery-status").textContent === "Draft recovery saved locally");
const state = (page) => page.evaluate(() => ({ url: document.getElementById("req-url").value, dirty: document.getElementById("btn-save-req").classList.contains("is-dirty"), alerts: window.__recoveryAlerts, writes: window.__recoveryWrites }));
async function restore(page, id) {
  await page.click("#btn-draft-recovery");
  await page.click(`[data-recovery-id="${id}"] button:first-of-type`);
}

export async function verifyRecoveryPersistence(page, baseUrl) {
  await fresh(page, baseUrl);
  const original = (await page.fetch("/api/collections/race_fixture")).body;
  const url = "http://example.test/recovered-request";
  await page.fill("#req-url", url);
  assert.equal((await storage(page)).length, 0);
  assert.equal(await page.evaluate(() => document.getElementById("draft-recovery-status").textContent), "Draft recovery off");
  await enable(page);
  await saved(page);
  const [record] = await storage(page);
  await ready(page, baseUrl);
  assert.notEqual((await state(page)).url, url);
  await restore(page, record.id);
  await page.waitForFunction((url) => document.getElementById("req-url").value === url, url);
  assert.equal((await state(page)).dirty, true);
  assert.deepEqual((await state(page)).writes, []);
  assert.equal((await page.fetch("/api/collections/race_fixture")).body, original);
  await saved(page);
  return { verdict: "PASS", cases: ["recovery stores nothing before local consent", "acknowledged recovery survives reload", "explicit restoration retains dirty request without canonical writes or execution"] };
}

export async function verifyRecoveryConcurrency(task, page, baseUrl) {
  await fresh(page, baseUrl);
  await enable(page);
  await page.fill("#req-url", "http://example.test/page-one");
  await saved(page);
  const [first] = await storage(page);
  const second = await task.newPage();
  try {
    await ready(second, baseUrl);
    await second.fill("#collection-search", "Race B");
    await second.click('[aria-label="GET Race B"]');
    await second.fill("#req-url", "http://example.test/page-two");
    await saved(second);
    const records = await storage(page);
    assert.equal(records.length, 2);
    assert.equal(new Set(records.map((record) => record.session)).size, 2);
    const other = records.find((record) => record.id !== first.id);
    await ready(page, baseUrl);
    await restore(page, first.id);
    await saved(page);
    assert.equal((await state(page)).url, "http://example.test/page-one");
    assert.equal((await state(second)).url, "http://example.test/page-two");
    assert.deepEqual((await storage(page)).find((record) => record.id === other.id), other);
    return { verdict: "PASS", cases: ["concurrent pages retain separate recovery records", "restoring a page never overwrites another live page's recovery"] };
  } finally { await second.close(); }
}

export async function verifyRecoveryConflict(page, baseUrl) {
  await fresh(page, baseUrl);
  const original = JSON.parse((await page.fetch("/api/collections/race_fixture")).body);
  try {
    await enable(page);
    await page.fill("#req-url", "http://example.test/original-context-draft");
    await saved(page);
    const [record] = await storage(page);
    const external = structuredClone(original);
    external.testScript = `${original.testScript || ""}\n// changed disk context ${crypto.randomUUID()}`;
    assert.equal((await page.fetch("/api/collections/race_fixture", { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": `"${original.revision}"` }, body: JSON.stringify(external) })).status, 200);
    await ready(page, baseUrl);
    await restore(page, record.id);
    await page.waitForSelector('[aria-label="Review workspace changes"]');
    await page.click("#btn-save-req");
    await page.waitForFunction(() => window.__recoveryAlerts.length > 0);
    assert.match((await state(page)).alerts[0], /Workspace changed/);
    assert.equal((await state(page)).dirty, true);
    const disk = JSON.parse((await page.fetch("/api/collections/race_fixture")).body);
    assert.equal(disk.testScript, external.testScript);
    assert.equal(disk.items[0].request.url, original.items[0].request.url);
    return { verdict: "PASS", cases: ["recovered draft retains original context and detects changed disk revision", "stale recovered save is rejected while retaining both disk and draft"] };
  } finally {
    await page.fetch("/api/collections/race_fixture", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(original) });
  }
}

export async function verifyRecoveryLimitsAndCorruption(page, baseUrl) {
  await fresh(page, baseUrl);
  await enable(page);
  await page.fill("#req-url", "http://example.test/last-acknowledged-recovery");
  await saved(page);
  const [record] = await storage(page);
  await page.evaluate(() => {
    const field = document.getElementById("req-test-script");
    field.value = "x".repeat(8 * 1024 * 1024);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById("draft-recovery-status").textContent.includes("exceeds 8 MiB"));
  assert.deepEqual((await storage(page)).find((item) => item.id === record.id), record);
  await ready(page, baseUrl);
  const environment = JSON.parse((await page.fetch("/api/environments/env_dev_1")).body);
  const malformed = structuredClone(environment);
  delete malformed.revision;
  const invalid = { ...record, id: record.workspace + ":invalid-test-record", session: "invalid-test-record", snapshot: { version: 1, collections: [], drafts: [], environments: [malformed] } };
  await storage(page, "put", invalid);
  await restore(page, invalid.id);
  await page.waitForFunction(() => window.__recoveryAlerts.length > 0);
  assert.match((await state(page)).alerts[0], /malformed format/);
  assert.equal((await state(page)).dirty, false);
  assert.deepEqual((await state(page)).writes, []);
  assert.deepEqual(JSON.parse((await page.fetch("/api/environments/env_dev_1")).body), environment);
  return { verdict: "PASS", cases: ["oversized recovery reports failure and preserves last acknowledged snapshot", "missing environment revision rejects the whole recovery before state mutation"] };
}

export async function cleanupRecoveryFixture(page, baseUrl) {
  await ready(page, baseUrl);
  await storage(page, "reset");
  await ready(page, baseUrl);
}

export async function verifyFailedEnvironmentRecovery(page, baseUrl) {
  await fresh(page, baseUrl);
  const original = (await page.fetch("/api/environments/env_dev_1")).body;
  await enable(page);
  await page.selectOption("#env-select", "__manage__");
  await page.click(".env-item-select");
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    window.fetch = (...args) => String(args[0]).startsWith("/api/environments/") && args[1]?.method === "PUT"
      ? Promise.resolve(new Response(JSON.stringify({ error: "Injected environment save failure" }), { status: 503 }))
      : native(...args);
  });
  await page.fill("#env-edit-panel tbody tr:first-child td:nth-child(3) input", "http://example.test/durable-failed-environment");
  await page.waitForFunction(() => window.__recoveryAlerts.length > 0);
  await saved(page);
  const [record] = await storage(page);
  assert.equal(record.snapshot.environments[0].values[0].value, "http://example.test/durable-failed-environment");
  await ready(page, baseUrl);
  await restore(page, record.id);
  await page.selectOption("#env-select", "__manage__");
  await page.click(".env-item-select");
  assert.equal(await page.evaluate(() => document.querySelector("#env-edit-panel tbody tr:first-child td:nth-child(3) input").value), "http://example.test/durable-failed-environment");
  assert.equal((await page.fetch("/api/environments/env_dev_1")).body, original);
  return { verdict: "PASS", cases: ["failed environment edits are durably acknowledged", "environment recovery survives reload without automatically overwriting canonical values"] };
}

export async function verifyRecoveryStorageFailure(page, baseUrl) {
  await fresh(page, baseUrl);
  await enable(page);
  await page.fill("#req-url", "http://example.test/acknowledged-before-provider-failure");
  await saved(page);
  const [record] = await storage(page);
  await page.evaluate(() => {
    const native = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (args[1] === "readwrite") throw new DOMException("Injected provider failure", "QuotaExceededError");
      return native.apply(this, args);
    };
  });
  await page.fill("#req-url", "http://example.test/not-yet-durable");
  await page.waitForFunction(() => document.getElementById("draft-recovery-status").textContent.includes("Injected provider failure"));
  assert.deepEqual((await storage(page)).find((item) => item.id === record.id), record);
  assert.equal((await state(page)).dirty, true);
  return { verdict: "PASS", cases: ["storage-provider failure is visible and leaves the live draft dirty", "failed storage transaction preserves the previous acknowledged recovery"] };
}

export async function verifyRecoveryControlsAndRetention(task, page, baseUrl) {
  await fresh(page, baseUrl);
  await enable(page);
  await page.fill("#req-url", "http://example.test/retained-before-disable");
  await saved(page);
  const [record] = await storage(page);
  await page.click("#btn-draft-recovery");
  await page.click('text="Disable draft recovery"');
  await page.click('[aria-label="Close dialog"]');
  await page.fill("#req-url", "http://example.test/live-edit-after-disable");
  assert.deepEqual((await storage(page)).find((item) => item.id === record.id), record);
  await page.click("#btn-draft-recovery");
  await page.click(`[data-recovery-id="${record.id}"] button:last-of-type`);
  await page.waitForFunction(() => !document.querySelector("[data-recovery-id]"));
  assert.equal((await storage(page)).length, 0);
  await page.click('[aria-label="Close dialog"]');
  assert.equal((await state(page)).url, "http://example.test/live-edit-after-disable");
  assert.equal((await state(page)).dirty, true);
  await fresh(page, baseUrl);
  await enable(page);
  await page.fill("#req-url", "http://example.test/retention-source");
  await saved(page);
  const [source] = await storage(page);
  for (let i = 0; i < 15; i++) await storage(page, "put", { ...source, id: source.workspace + ":retention-" + i, session: "retention-" + i });
  const previous = await storage(page);
  assert.equal(previous.length, 16);
  const next = await task.newPage();
  try {
    await ready(next, baseUrl);
    await next.fill("#req-url", "http://example.test/seventeenth-page");
    await next.waitForFunction(() => document.getElementById("draft-recovery-status").textContent.includes("Recovery limit reached"));
    assert.deepEqual(await storage(page), previous);
    assert.equal((await state(next)).dirty, true);
  } finally { await next.close(); }
  return { verdict: "PASS", cases: ["disabling recovery preserves stored records and stops future edit writes", "explicit discard deletes only recovery while retaining the live dirty draft", "a seventeenth page is refused without evicting sixteen prior recovery records"] };
}
