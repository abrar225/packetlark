import assert from "node:assert/strict";

// Run with ego-browser's Page API against scripts/p0-browser-fixture.mjs.
// Tests interact with DOM controls; fault injection is confined to the HTTP adapter.
export async function verifyOwnership(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.waitForSelector('[aria-label="GET Race A"]');
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    window.__faults = { alerts: [], gates: {}, completed: {} };
    window.alert = (message) => window.__faults.alerts.push(message);
    window.fetch = async (...args) => {
      const [url, options] = args;
      const faults = window.__faults;
      if (String(url).endsWith("/requests") && faults.failSave)
        return new Response(
          JSON.stringify({ error: "Injected disk failure" }),
          { status: 500 },
        );
      const request = options?.body
        ? JSON.parse(options.body).request
        : undefined;
      const gateKey =
        String(url) === "/api/execute"
          ? request.id
          : String(url).endsWith("/requests")
            ? "save"
            : null;
      const gate = faults.gates[gateKey];
      if (String(url) === "/api/execute" && gate) {
        gate.started = true;
        await gate.promise; // Deliberately ignores cancellation to exercise late completion.
        const response = new Response();
        response.json = async () => {
          faults.completed[gateKey] = true;
          return {
            status: 200,
            statusText: "OK",
            body: JSON.stringify({ owner: request.id }),
            headers: {},
            timings: { totalMs: 1 },
            sizeBytes: 18,
            testResults: [],
            logs: [],
          };
        };
        return response;
      }
      const response = await native(...args);
      if (gate) {
        gate.started = true;
        await gate.promise;
      }
      return response;
    };
  });
  const gate = (key) =>
    page.evaluate((key) => {
      let release;
      const promise = new Promise((resolve) => (release = resolve));
      window.__faults.gates[key] = { promise, release, started: false };
    }, key);
  const release = (key) =>
    page.evaluate((key) => window.__faults.gates[key].release(), key);
  const clickRequest = (name) => page.click(`[aria-label="GET Race ${name}"]`);
  const state = () =>
    page.evaluate(() => ({
      name: document.getElementById("request-name").textContent,
      url: document.getElementById("req-url").value,
      dirty: document
        .getElementById("btn-save-req")
        .classList.contains("is-dirty"),
      badgePresent: !!document.getElementById("dirty-badge"),
      status: document.getElementById("save-status").textContent,
      body: document.getElementById("res-body").textContent,
      sending: document.getElementById("btn-send-main").disabled,
      cancelVisible:
        document.getElementById("cancel-request").style.display !== "none",
    }));
  await clickRequest("A");
  await gate("save");
  await page.fill("#req-url", "http://example.test/a-snapshot");
  await page.click("#btn-save-req");
  await page.waitForFunction(() => window.__faults.gates.save.started);
  await clickRequest("B");
  await page.fill("#req-url", "http://example.test/b-draft");
  await release("save");
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="GET Race A"] .dirty-dot'),
  );
  let actual = await state();
  assert.equal(actual.name, "Race B");
  assert.equal(actual.dirty, true);
  assert.equal(actual.badgePresent, true);
  await clickRequest("A");
  await clickRequest("B");
  assert.equal((await state()).url, "http://example.test/b-draft");

  await gate("save");
  await page.click("#btn-save-req");
  await page.waitForFunction(() => window.__faults.gates.save.started);
  await page.fill("#req-url", "http://example.test/b-newer-draft");
  await release("save");
  await page.waitForFunction(
    () =>
      document.getElementById("save-status").textContent ===
      "Newer changes remain unsaved",
  );
  assert.equal((await state()).dirty, true);

  await page.evaluate(() => {
    delete window.__faults.gates.save;
    window.__faults.failSave = true;
  });
  await page.click("#btn-save-req");
  await page.waitForFunction(() => window.__faults.alerts.length > 0);
  await clickRequest("A");
  await clickRequest("B");
  actual = await state();
  assert.equal(actual.url, "http://example.test/b-newer-draft");
  assert.equal(actual.dirty, true);
  await page.evaluate(() => {
    window.__faults.failSave = false;
  });
  await page.click("#btn-save-req");
  await page.waitForFunction(
    () => document.getElementById("save-status").textContent === "Saved",
  );

  await clickRequest("A");
  await gate("race_a");
  await gate("race_b");
  await page.click("#btn-send-main");
  await page.waitForFunction(() => window.__faults.gates.race_a.started);
  await clickRequest("B");
  await page.click("#btn-send-main");
  await page.waitForFunction(() => window.__faults.gates.race_b.started);
  await release("race_a");
  await page.waitForFunction(() => window.__faults.completed.race_a);
  actual = await state();
  assert.equal(actual.name, "Race B");
  assert.equal(actual.sending, true);
  assert.equal(actual.cancelVisible, true);
  assert.equal(actual.body.includes("race_a"), false);
  await release("race_b");
  await page.waitForFunction(() =>
    document.getElementById("res-body").textContent.includes("race_b"),
  );
  actual = await state();
  assert.equal(actual.sending, false);
  assert.equal(actual.body.includes("race_a"), false);
  await clickRequest("A");
  assert.equal((await state()).body.includes("race_b"), false);
  return {
    verdict: "PASS",
    cases: [
      "late save retains selected draft",
      "draft restored on switch",
      "edits during save stay dirty",
      "failed save retains draft",
      "late response cannot render or clear another execution",
      "selection clears prior response",
    ],
  };
}

export async function verifyEnvironmentOwnership(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.selectOption("#env-select", "__manage__");
  await page.click(".env-item-select");
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    window.__envFault = { release, held: false, fail: false, alerts: [] };
    window.alert = (message) => window.__envFault.alerts.push(message);
    window.fetch = async (...args) => {
      const mutation =
        String(args[0]).startsWith("/api/environments/") &&
        args[1]?.method === "PUT";
      if (mutation && window.__envFault.fail)
        return new Response(
          JSON.stringify({ error: "Injected environment failure" }),
          { status: 500 },
        );
      const response = await native(...args);
      if (mutation && !window.__envFault.held) {
        window.__envFault.held = true;
        await gate;
      }
      return response;
    };
  });
  await page.fill("#env-edit-panel input.url-input", "Serialized environment");
  await page.press("#env-edit-panel input.url-input", "Tab");
  await page.waitForFunction(() => window.__envFault.held);
  const valueSelector =
    "#env-edit-panel tbody tr:first-child td:nth-child(3) input";
  await page.fill(valueSelector, "first pending value");
  await page.fill(valueSelector, "latest pending value");
  await page.evaluate(() => window.__envFault.release());
  await page.waitForFunction(
    () =>
      document.getElementById("env-save-status").textContent ===
      "Environment saved",
  );
  const response = await page.fetch("/api/environments");
  const environment = JSON.parse(response.body)[0];
  assert.equal(environment.name, "Serialized environment");
  assert.equal(environment.values[0].value, "latest pending value");
  await page.evaluate(() => {
    window.__envFault.fail = true;
  });
  await page.fill(valueSelector, "unsaved environment draft");
  await page.waitForFunction(() => window.__envFault.alerts.length > 0);
  await page.click('[aria-label="Close dialog"]');
  await page.selectOption("#env-select", "__manage__");
  await page.click(".env-item-select");
  const retained = await page.evaluate(
    (selector) => document.querySelector(selector).value,
    valueSelector,
  );
  assert.equal(retained, "unsaved environment draft");
  await page.evaluate(() => {
    window.__envFault.fail = false;
  });
  await page.fill(valueSelector, "final saved value");
  await page.waitForFunction(
    () =>
      document.getElementById("env-save-status").textContent ===
      "Environment saved",
  );
  await page.click('[aria-label="Close dialog"]');
  return {
    verdict: "PASS",
    cases: [
      "environment uses update endpoint",
      "edits serialize with current revision",
      "latest queued input persists",
      "failed environment save retains draft",
    ],
  };
}

export async function verifyCreateDelete(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.evaluate(() => {
    window.__alerts = [];
    window.alert = (message) => window.__alerts.push(message);
  });
  await page.click('[aria-label="GET Race A"]');
  await page.click('[aria-label="New Request"]');
  await page.acceptDialog("P0 created request");
  await page.waitForFunction(
    () =>
      document.getElementById("request-name").textContent ===
      "P0 created request",
  );
  await page.fill("#req-url", "http://example.test/new-request-draft");
  await page.click("#btn-save-req");
  await page.waitForFunction(
    () =>
      window.__alerts.length ||
      document.getElementById("save-status").textContent === "Saved",
  );
  assert.equal(
    await page.evaluate(
      () => document.getElementById("save-status").textContent,
    ),
    "Saved",
  );
  await page.fill("#req-url", "http://example.test/discard-after-confirmation");
  await page.click(
    '.request-item:has([aria-label="GET P0 created request"]) [data-delete-request]',
  );
  await page.acceptDialog();
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="GET P0 created request"]'),
  );
  // Reload must not prompt for the explicitly discarded draft.
  await page.reload();
  await page.waitForSelector('[aria-label="GET Race A"]');
  return {
    verdict: "PASS",
    cases: [
      "new request saves with returned collection revision",
      "confirmed deletion discards only owned draft without orphan unload guard",
    ],
  };
}

export async function verifyPendingEnvironment(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.click('[aria-label="GET Race A"]');
  const targetOrigin = await page.evaluate(
    () => new URL(document.getElementById("req-url").value).origin,
  );
  await page.selectOption("#env-select", "env_dev_1");
  await page.selectOption("#env-select", "__manage__");
  await page.click(".env-item-select");
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    window.__pendingEnv = { release, held: false, executeStarted: false };
    window.fetch = async (...args) => {
      if (
        String(args[0]).startsWith("/api/environments/") &&
        args[1]?.method === "PUT"
      ) {
        window.__pendingEnv.held = true;
        await gate;
      }
      if (String(args[0]) === "/api/execute")
        window.__pendingEnv.executeStarted = true;
      return native(...args);
    };
  });
  await page.fill(
    "#env-edit-panel tbody tr:first-child td:nth-child(3) input",
    targetOrigin + "/pending-env",
  );
  await page.waitForFunction(() => window.__pendingEnv.held);
  await page.click('[aria-label="Close dialog"]');
  await page.fill("#req-url", "{{baseUrl}}");
  await page.click("#btn-send-main");
  assert.equal(
    await page.evaluate(() => window.__pendingEnv.executeStarted),
    false,
  );
  await page.evaluate(() => window.__pendingEnv.release());
  await page.waitForFunction(() =>
    document.getElementById("res-body").textContent.includes("/pending-env"),
  );
  assert.equal(
    await page.evaluate(
      () => document.getElementById("res-status").textContent,
    ),
    "200 OK",
  );
  await page.click("#btn-save-req");
  await page.waitForFunction(
    () => document.getElementById("save-status").textContent === "Saved",
  );
  return {
    verdict: "PASS",
    cases: [
      "Send waits for pending environment save",
      "execution uses latest saved environment revision and value",
    ],
  };
}

export async function verifyStaleDeletes(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.evaluate(() => {
    window.__deleteAlerts = [];
    window.alert = (message) => window.__deleteAlerts.push(message);
  });
  const read = await page.fetch("/api/collections/race_fixture");
  const collection = JSON.parse(read.body);
  await page.fetch("/api/collections/race_fixture", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "If-Match": `"${collection.revision}"`,
    },
    body: JSON.stringify({ name: "Externally edited collection" }),
  });
  await page.click(
    '.request-item:has([aria-label="GET Race A"]) [data-delete-request]',
  );
  await page.acceptDialog();
  await page.waitForFunction(() => window.__deleteAlerts.length === 1);
  assert.equal(
    await page.evaluate(
      () => !!document.querySelector('[aria-label="GET Race A"]'),
    ),
    true,
  );
  const retainedCollection = JSON.parse(
    (await page.fetch("/api/collections/race_fixture")).body,
  );
  assert.equal(
    retainedCollection.items.some((item) => item.request?.id === "race_a"),
    true,
  );
  await page.selectOption("#env-select", "env_dev_1");
  await page.selectOption("#env-select", "__manage__");
  const environment = JSON.parse(
    (await page.fetch("/api/environments/env_dev_1")).body,
  );
  await page.fetch("/api/environments/env_dev_1", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "If-Match": `"${environment.revision}"`,
    },
    body: JSON.stringify({ name: "Externally edited environment" }),
  });
  await page.click('[aria-label="Delete environment"]');
  await page.acceptDialog();
  await page.waitForFunction(() => window.__deleteAlerts.length === 2);
  assert.equal((await page.fetch("/api/environments/env_dev_1")).status, 200);
  assert.equal(
    await page.evaluate(() => document.getElementById("env-select").value),
    "env_dev_1",
  );
  await page.click('[aria-label="Close dialog"]');
  return {
    verdict: "PASS",
    cases: [
      "stale request deletion preserves request",
      "stale environment deletion reports conflict and preserves selection",
    ],
  };
}
