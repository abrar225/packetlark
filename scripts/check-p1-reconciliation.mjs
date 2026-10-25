import assert from "node:assert/strict";

export async function verifyExternalWorkspace(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.click('[aria-label="GET Race A"]');
  const original = JSON.parse(
    (await page.fetch("/api/collections/race_fixture")).body,
  );
  const update = async (edit) => {
    const current = JSON.parse(
      (await page.fetch("/api/collections/race_fixture")).body,
    );
    edit(current);
    const result = await page.fetch("/api/collections/race_fixture", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${current.revision}"`,
      },
      body: JSON.stringify(current),
    });
    assert.equal(result.status, 200);
  };
  let recoveredId;
  try {
    const external = new URL(original.items[0].request.url);
    external.pathname = "/external-a";
    await update((col) => {
      col.items[0].request.url = external.href;
    });
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForFunction(
      (url) => document.getElementById("req-url").value === url,
      external.href,
    );
    await page.fill("#req-url", "http://example.test/retained-local-draft");
    await update((col) => {
      col.items[0].request.url = "http://example.test/disk-version";
      col.testScript =
        'pm.test("new collection context", () => pm.expect(true).to.equal(true))';
    });
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForSelector('[aria-label="Review workspace changes"]');
    assert.equal(
      await page.evaluate(() => document.getElementById("req-url").value),
      "http://example.test/retained-local-draft",
    );
    await page.click('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Keep drafts with disk context"]');
    await page.click("#btn-save-req");
    await page.waitForFunction(
      () => document.getElementById("save-status").textContent === "Saved",
    );
    const saved = JSON.parse(
      (await page.fetch("/api/collections/race_fixture")).body,
    );
    assert.equal(
      saved.items[0].request.url,
      "http://example.test/retained-local-draft",
    );
    assert.equal(saved.testScript.includes("new collection context"), true);
    await page.fill("#req-url", "http://example.test/recovered-after-delete");
    assert.equal(
      (
        await page.fetch("/api/collections/race_fixture", {
          method: "DELETE",
          headers: { "If-Match": `"${saved.revision}"` },
        })
      ).status,
      200,
    );
    await page.click('[aria-label="Check workspace files"]');
    await page.click('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Save recovered collection copy"]');
    await page.waitForFunction(() =>
      document
        .getElementById("collection-name")
        .textContent.includes("recovered copy"),
    );
    assert.equal(
      await page.evaluate(() => document.getElementById("req-url").value),
      "http://example.test/recovered-after-delete",
    );
    const all = JSON.parse((await page.fetch("/api/collections")).body);
    const recovered = all.find((col) => col.name.includes("recovered copy"));
    recoveredId = recovered.id;
    assert.equal(
      recovered.items[0].request.url,
      "http://example.test/recovered-after-delete",
    );
    return {
      verdict: "PASS",
      cases: [
        "clean editor adopts disk edit",
        "dirty request survives external change",
        "explicit rebase preserves disk context",
        "externally deleted collection recovers as a separate saved copy",
      ],
    };
  } finally {
    if (recoveredId)
      await page.fetch(`/api/collections/${recoveredId}`, { method: "DELETE" });
    const existing = await page.fetch("/api/collections/race_fixture");
    delete original.revision;
    if (existing.status === 200)
      await page.fetch("/api/collections/race_fixture", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(original),
      });
    else
      await page.fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(original),
      });
  }
}

export async function verifyLateWorkspaceSnapshot(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.click('[aria-label="GET Race A"]');
  const original = await page.evaluate(
    () => document.getElementById("req-url").value,
  );
  await page.waitForFunction(
    () => !document.getElementById("btn-check-workspace").disabled,
  );
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    window.__snapshotFault = { release, held: false, arm: true };
    window.fetch = async (...args) => {
      if (String(args[0]) === "/api/workspace" && window.__snapshotFault.arm) {
        window.__snapshotFault.arm = false;
        const response = await native(args[0], { ...args[1], headers: {} });
        window.__snapshotFault.held = true;
        await gate;
        return response;
      }
      return native(...args);
    };
  });
  await page.click('[aria-label="Check workspace files"]');
  await page.waitForFunction(() => window.__snapshotFault.held);
  await page.fill("#req-url", "http://example.test/newer-than-snapshot");
  await page.click("#btn-save-req");
  await page.waitForFunction(
    () => document.getElementById("save-status").textContent === "Saved",
  );
  await page.evaluate(() => window.__snapshotFault.release());
  await page.waitForFunction(
    () => !document.getElementById("btn-check-workspace").disabled,
  );
  await page.click('[aria-label="GET Race B"]');
  await page.click('[aria-label="GET Race A"]');
  assert.equal(
    await page.evaluate(() => document.getElementById("req-url").value),
    "http://example.test/newer-than-snapshot",
  );
  await page.fill("#req-url", original);
  await page.click("#btn-save-req");
  await page.waitForFunction(
    () => document.getElementById("save-status").textContent === "Saved",
  );
  return {
    verdict: "PASS",
    cases: ["late disk snapshot cannot replace a newer saved request"],
  };
}

export async function verifyEnvironmentRecovery(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  const original = JSON.parse(
    (await page.fetch("/api/environments/env_dev_1")).body,
  );
  let recoveredId;
  try {
    await page.selectOption("#env-select", "env_dev_1");
    await page.selectOption("#env-select", "__manage__");
    await page.click(".env-item-select");
    await page.evaluate(() => {
      const native = window.fetch.bind(window);
      window.__envRecoveryFault = { fail: true, alerts: [] };
      window.alert = (message) =>
        window.__envRecoveryFault.alerts.push(message);
      window.fetch = (...args) =>
        window.__envRecoveryFault.fail &&
        String(args[0]).startsWith("/api/environments/") &&
        args[1]?.method === "PUT"
          ? Promise.resolve(
              new Response(JSON.stringify({ error: "Injected save failure" }), {
                status: 503,
              }),
            )
          : native(...args);
    });
    await page.fill(
      "#env-edit-panel tbody tr:first-child td:nth-child(3) input",
      "http://example.test/local-environment",
    );
    await page.waitForFunction(
      () => window.__envRecoveryFault.alerts.length > 0,
    );
    await page.click('[aria-label="Close dialog"]');
    await page.evaluate(() => {
      window.__envRecoveryFault.fail = false;
    });
    const disk = structuredClone(original);
    disk.name = "Disk environment";
    disk.values[0].value = "http://example.test/disk-environment";
    assert.equal(
      (
        await page.fetch("/api/environments/env_dev_1", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": `"${original.revision}"`,
          },
          body: JSON.stringify(disk),
        })
      ).status,
      200,
    );
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForSelector('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Save recovered environment copy"]');
    await page.waitForFunction(() =>
      document
        .querySelector("#env-select option:checked")
        .textContent.includes("recovered copy"),
    );
    const all = JSON.parse((await page.fetch("/api/environments")).body);
    const copy = all.find((env) => env.name.includes("recovered copy"));
    recoveredId = copy.id;
    assert.equal(copy.values[0].value, "http://example.test/local-environment");
    assert.equal(
      all.find((env) => env.id === "env_dev_1").values[0].value,
      "http://example.test/disk-environment",
    );
    return {
      verdict: "PASS",
      cases: [
        "failed environment draft survives disk conflict",
        "recovered environment copy preserves both versions",
      ],
    };
  } finally {
    if (recoveredId)
      await page.fetch(`/api/environments/${recoveredId}`, {
        method: "DELETE",
      });
    delete original.revision;
    await page.fetch("/api/environments/env_dev_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(original),
    });
  }
}

export async function verifyDiscardWorkspaceDraft(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.click('[aria-label="GET Race A"]');
  const original = JSON.parse(
    (await page.fetch("/api/collections/race_fixture")).body,
  );
  try {
    await page.fill("#req-url", "http://example.test/to-discard");
    const disk = structuredClone(original);
    disk.items[0].request.url = "http://example.test/accepted-disk-version";
    assert.equal(
      (
        await page.fetch("/api/collections/race_fixture", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": `"${original.revision}"`,
          },
          body: JSON.stringify(disk),
        })
      ).status,
      200,
    );
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForSelector('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Load disk and discard local drafts"]');
    await page.acceptDialog();
    await page.waitForFunction(
      () =>
        document.getElementById("req-url").value ===
        "http://example.test/accepted-disk-version",
    );
    assert.equal(
      await page.evaluate(() =>
        document.getElementById("btn-save-req").classList.contains("is-dirty"),
      ),
      false,
    );
    await page.reload();
    await page.waitForSelector('[aria-label="GET Race A"]');
    return {
      verdict: "PASS",
      cases: ["explicit discard loads disk and removes the owned unload guard"],
    };
  } finally {
    delete original.revision;
    await page.fetch("/api/collections/race_fixture", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(original),
    });
  }
}

export async function verifyCleanSiblingAfterRebase(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  const original = JSON.parse(
    (await page.fetch("/api/collections/race_fixture")).body,
  );
  try {
    await page.click('[aria-label="GET Race A"]');
    await page.click('[aria-label="GET Race B"]');
    await page.fill("#req-url", "http://example.test/local-b");
    const disk = structuredClone(original);
    disk.items[0].request.url = "http://example.test/new-disk-a";
    assert.equal(
      (
        await page.fetch("/api/collections/race_fixture", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": `"${original.revision}"`,
          },
          body: JSON.stringify(disk),
        })
      ).status,
      200,
    );
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForSelector('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Keep drafts with disk context"]');
    await page.click('[aria-label="GET Race A"]');
    assert.equal(
      await page.evaluate(() => document.getElementById("req-url").value),
      "http://example.test/new-disk-a",
    );
    return {
      verdict: "PASS",
      cases: ["rebasing dirty B reloads cached clean A from disk"],
    };
  } finally {
    await page.click('[aria-label="GET Race B"]');
    await page.click("#btn-save-req");
    await page.waitForFunction(
      () => document.getElementById("save-status").textContent === "Saved",
    );
    delete original.revision;
    await page.fetch("/api/collections/race_fixture", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(original),
    });
  }
}

export async function verifyFailedBusySaveConflict(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.click('[aria-label="GET Race A"]');
  const original = JSON.parse(
    (await page.fetch("/api/collections/race_fixture")).body,
  );
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    window.__busySaveFault = {
      release,
      started: false,
      alerts: [],
      forceFull: false,
    };
    window.alert = (message) => window.__busySaveFault.alerts.push(message);
    window.fetch = async (...args) => {
      if (
        String(args[0]).endsWith("/requests") &&
        args[1]?.method === "POST" &&
        !window.__busySaveFault.started
      ) {
        window.__busySaveFault.started = true;
        await gate;
      }
      if (
        String(args[0]) === "/api/workspace" &&
        window.__busySaveFault.forceFull
      )
        return native(args[0], { ...args[1], headers: {} });
      return native(...args);
    };
  });
  try {
    await page.fill("#req-url", "http://example.test/busy-draft");
    await page.click("#btn-save-req");
    await page.waitForFunction(() => window.__busySaveFault.started);
    const disk = structuredClone(original);
    disk.items[1].request.url = "http://example.test/changed-while-busy";
    assert.equal(
      (
        await page.fetch("/api/collections/race_fixture", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": `"${original.revision}"`,
          },
          body: JSON.stringify(disk),
        })
      ).status,
      200,
    );
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForFunction(
      () => !document.getElementById("btn-check-workspace").disabled,
    );
    await page.evaluate(() => window.__busySaveFault.release());
    await page.waitForFunction(() => window.__busySaveFault.alerts.length > 0);
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForFunction(
      () => !document.getElementById("btn-review-workspace").hidden,
    );
    assert.equal(
      await page.evaluate(() => document.getElementById("req-url").value),
      "http://example.test/busy-draft",
    );
    return {
      verdict: "PASS",
      cases: [
        "failed busy save exposes conflict after an unchanged-disk refresh",
      ],
    };
  } finally {
    await page.evaluate(() => {
      window.__busySaveFault.release();
      window.__busySaveFault.forceFull = true;
    });
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForFunction(
      () => !document.getElementById("btn-review-workspace").hidden,
    );
    await page.click('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Keep drafts with disk context"]');
    await page.click("#btn-save-req");
    await page.waitForFunction(
      () => document.getElementById("save-status").textContent === "Saved",
    );
    delete original.revision;
    await page.fetch("/api/collections/race_fixture", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(original),
    });
  }
}

export async function verifyCopyResolutionLock(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.click('[aria-label="GET Race A"]');
  const original = JSON.parse(
    (await page.fetch("/api/collections/race_fixture")).body,
  );
  let recoveredId;
  try {
    await page.fill("#req-url", "http://example.test/copy-snapshot");
    const disk = structuredClone(original);
    disk.name = "Changed before copy";
    assert.equal(
      (
        await page.fetch("/api/collections/race_fixture", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": `"${original.revision}"`,
          },
          body: JSON.stringify(disk),
        })
      ).status,
      200,
    );
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForSelector('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Review workspace changes"]');
    await page.evaluate(() => {
      const native = window.fetch.bind(window);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      window.__copyFault = { release, held: false };
      window.fetch = async (...args) => {
        if (
          String(args[0]) === "/api/collections" &&
          args[1]?.method === "POST"
        ) {
          window.__copyFault.held = true;
          await gate;
        }
        return native(...args);
      };
    });
    await page.click('[aria-label="Save recovered collection copy"]');
    await page.waitForFunction(() => window.__copyFault.held);
    await page.keyboard.press("Escape");
    assert.equal(
      await page.evaluate(
        () => document.getElementById("modal-backdrop").style.display,
      ),
      "flex",
    );
    assert.equal(
      await page.evaluate(() => document.querySelector(".app-body").inert),
      true,
    );
    return {
      verdict: "PASS",
      cases: [
        "copy resolution prevents closing and editing until its bounded request settles",
      ],
    };
  } finally {
    await page.evaluate(() => window.__copyFault?.release());
    await page.waitForFunction(() =>
      document
        .getElementById("collection-name")
        .textContent.includes("recovered copy"),
    );
    const all = JSON.parse((await page.fetch("/api/collections")).body);
    recoveredId = all.find((col) => col.name.includes("recovered copy"))?.id;
    if (recoveredId)
      await page.fetch(`/api/collections/${recoveredId}`, { method: "DELETE" });
    delete original.revision;
    await page.fetch("/api/collections/race_fixture", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(original),
    });
  }
}

export async function verifyWorkspacePreviewMask(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.click('[aria-label="GET Race A"]');
  const original = JSON.parse(
    (await page.fetch("/api/collections/race_fixture")).body,
  );
  try {
    await page.fill("#req-url", "http://example.test/preview-draft");
    const disk = structuredClone(original);
    disk.auth = {
      type: "apikey",
      apiKeyName: "X-Key",
      apiKeyValue: "preview-seed-api-key",
    };
    disk.variables.push(
      { key: "apiKey", value: "preview-seed-variable", enabled: true },
      {
        key: "opaque",
        value: "preview-seed-marked-secret",
        type: "secret",
        enabled: true,
      },
    );
    assert.equal(
      (
        await page.fetch("/api/collections/race_fixture", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": `"${original.revision}"`,
          },
          body: JSON.stringify(disk),
        })
      ).status,
      200,
    );
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForSelector('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Review workspace changes"]');
    const text = await page.evaluate(
      () => document.querySelector(".workspace-previews").textContent,
    );
    for (const secret of [
      "preview-seed-api-key",
      "preview-seed-variable",
      "preview-seed-marked-secret",
    ])
      assert.equal(text.includes(secret), false);
    return {
      verdict: "PASS",
      cases: ["review masks API-key fields and marked secret variable values"],
    };
  } finally {
    await page.click('[aria-label="Load disk and discard local drafts"]');
    await page.acceptDialog();
    await page.waitForFunction(
      () => document.getElementById("modal-backdrop").style.display === "none",
    );
    delete original.revision;
    await page.fetch("/api/collections/race_fixture", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(original),
    });
  }
}

export async function verifyRunnerContextAdmission(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  const original = JSON.parse(
    (await page.fetch("/api/collections/race_fixture")).body,
  );
  await page.click('button[onclick="openRunner()"]');
  await page.selectOption("#run-collection", "race_fixture");
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    window.__runAdmissionFault = { release, calls: 0, payload: null };
    window.fetch = async (...args) => {
      if (String(args[0]) === "/api/runs" && args[1]?.method === "POST") {
        window.__runAdmissionFault.calls++;
        window.__runAdmissionFault.payload = JSON.parse(args[1].body);
        await gate;
      }
      return native(...args);
    };
  });
  try {
    await page.click("#start-run");
    await page.waitForFunction(() => window.__runAdmissionFault.calls === 1);
    assert.equal(
      await page.evaluate(() => document.getElementById("start-run").disabled),
      true,
    );
    await page.press("#run-iterations", "Enter");
    assert.equal(
      await page.evaluate(() => window.__runAdmissionFault.calls),
      1,
    );
    assert.equal(
      await page.evaluate(
        () => window.__runAdmissionFault.payload.collectionRevision,
      ),
      original.revision,
    );
    const disk = structuredClone(original);
    disk.name = "New context while run was pending";
    assert.equal(
      (
        await page.fetch("/api/collections/race_fixture", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": `"${original.revision}"`,
          },
          body: JSON.stringify(disk),
        })
      ).status,
      200,
    );
    await page.evaluate(() => window.__runAdmissionFault.release());
    await page.waitForFunction(() =>
      document
        .getElementById("run-progress")
        .textContent.includes("Collection changed"),
    );
    assert.equal(
      JSON.parse((await page.fetch("/api/health")).body).activeWork,
      0,
    );
    return {
      verdict: "PASS",
      cases: [
        "runner admits one pending submission",
        "runner sends reviewed revision and reports a stale context before transport",
      ],
    };
  } finally {
    await page.evaluate(() => window.__runAdmissionFault.release());
    delete original.revision;
    await page.fetch("/api/collections/race_fixture", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(original),
    });
  }
}

export async function verifyReviewFooterIsolation(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.click('button[onclick="openImportModal()"]');
  await page.click('[aria-label="Close dialog"]');
  await page.click('[aria-label="GET Race A"]');
  const original = JSON.parse(
    (await page.fetch("/api/collections/race_fixture")).body,
  );
  try {
    await page.fill("#req-url", "http://example.test/footer-draft");
    const disk = structuredClone(original);
    disk.name = "Footer conflict";
    assert.equal(
      (
        await page.fetch("/api/collections/race_fixture", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": `"${original.revision}"`,
          },
          body: JSON.stringify(disk),
        })
      ).status,
      200,
    );
    await page.click('[aria-label="Check workspace files"]');
    await page.waitForSelector('[aria-label="Review workspace changes"]');
    await page.click('[aria-label="Review workspace changes"]');
    assert.equal(
      await page.evaluate(
        () => document.getElementById("modal-footer").children.length,
      ),
      0,
    );
    return {
      verdict: "PASS",
      cases: ["review never retains another dialog's footer actions"],
    };
  } finally {
    await page.click('[aria-label="Load disk and discard local drafts"]');
    await page.acceptDialog();
    await page.waitForFunction(
      () => document.getElementById("modal-backdrop").style.display === "none",
    );
    delete original.revision;
    await page.fetch("/api/collections/race_fixture", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(original),
    });
  }
}
