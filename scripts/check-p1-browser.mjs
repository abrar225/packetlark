import assert from "node:assert/strict";

export async function verifyNativeIdentity(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  const source = JSON.parse(
    (await page.fetch("/api/collections/race_fixture")).body,
  );
  const native = {
    id: "native_browser",
    name: "Native browser",
    variables: [],
    items: [
      {
        id: "native_only",
        name: "Native first request",
        request: { method: "GET", url: source.items[1].request.url },
      },
    ],
  };
  assert.equal(
    (
      await page.fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(native),
      })
    ).status,
    200,
  );
  const originals = JSON.parse(
    (await page.fetch("/api/collections")).body,
  ).filter((col) => col.id !== native.id);
  try {
    for (const col of originals)
      assert.equal(
        (await page.fetch(`/api/collections/${col.id}`, { method: "DELETE" }))
          .status,
        200,
      );
    await page.goto(baseUrl + "/studio");
    await page.waitForFunction(
      () => performance.getEntriesByName("rea:studio-ready").length > 0,
    );
    assert.equal(
      await page.evaluate(
        () => document.getElementById("request-name").textContent,
      ),
      "Native first request",
    );
    await page.click("#btn-send-main");
    await page.waitForFunction(
      () => !document.getElementById("btn-send-main").disabled,
    );
    assert.equal(
      await page.evaluate(
        () => document.getElementById("res-status").textContent,
      ),
      "200 OK",
    );
    return {
      verdict: "PASS",
      cases: ["first native item auto-selects and executes with item identity"],
    };
  } finally {
    for (const col of originals) {
      delete col.revision;
      assert.equal(
        (
          await page.fetch("/api/collections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(col),
          })
        ).status,
        200,
      );
    }
    await page.fetch(`/api/collections/${native.id}`, { method: "DELETE" });
  }
}

export async function verifyNestedSearch(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  const collection = {
    id: "nested_browser",
    name: "Nested browser",
    variables: [],
    items: [
      {
        id: "parent_folder",
        name: "Parent folder",
        isFolder: true,
        items: [
          {
            id: "child_folder",
            name: "Child folder",
            isFolder: true,
            items: [
              {
                id: "nested_item",
                name: "Wrapper label",
                request: {
                  id: "nested_request",
                  name: "Displayed native label",
                  method: "GET",
                  url: "http://example.test/original",
                },
              },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(
    (
      await page.fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collection),
      })
    ).status,
    200,
  );
  try {
    await page.goto(baseUrl + "/studio");
    await page.fill("#collection-search", "Displayed native label");
    await page.click('[aria-label="GET Displayed native label"]');
    await page.fill("#req-url", "http://example.test/unsaved-search-target");
    await page.fill("#collection-search", "unsaved-search-target");
    await page.click('[aria-label="GET Displayed native label"]');
    assert.equal(
      await page.evaluate(() => document.getElementById("req-url").value),
      "http://example.test/unsaved-search-target",
    );
    await page.fill("#collection-search", "Nested browser");
    await page.click('[aria-label="Folder: Parent folder"]');
    await page.waitForFunction(
      () =>
        !document.querySelector('[aria-label="GET Displayed native label"]'),
    );
    await page.press('[aria-label="Folder: Parent folder"]', "Enter");
    await page.waitForSelector('[aria-label="GET Displayed native label"]');
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector('[aria-label="Folder: Parent folder"]')
          .getAttribute("aria-expanded"),
      ),
      "true",
    );
    return {
      verdict: "PASS",
      cases: [
        "search matches displayed native label",
        "search matches unsaved URL",
        "nested folders collapse and expand with Enter",
      ],
    };
  } finally {
    // Delete through the UI so the intentionally dirty draft is explicitly discarded.
    await page.fill("#collection-search", "Nested browser");
    const collapsed = await page.evaluate(
      () =>
        document
          .querySelector('[aria-label="Folder: Parent folder"]')
          ?.getAttribute("aria-expanded") === "false",
    );
    if (collapsed) await page.click('[aria-label="Folder: Parent folder"]');
    const remove =
      '.request-item:has([aria-label="GET Displayed native label"]) [data-delete-request]';
    if (
      await page.evaluate(
        (selector) => !!document.querySelector(selector),
        remove,
      )
    ) {
      await page.click(remove);
      await page.acceptDialog();
      await page.waitForFunction(
        () =>
          !document.querySelector('[aria-label="GET Displayed native label"]'),
      );
    }
    await page.fetch(`/api/collections/${collection.id}`, { method: "DELETE" });
  }
}
export async function verifyLargeWorkspace(page, baseUrl) {
  await page.goto(baseUrl + "/studio");
  await page.waitForFunction(
    () => performance.getEntriesByName("rea:studio-ready").length > 0,
  );
  const count = await page.evaluate(
    () => document.querySelectorAll(".request-item").length,
  );
  assert.ok(
    count <= 100,
    `Expected a bounded visible request window, rendered ${count}`,
  );
  const first = await page.evaluate(() =>
    [...document.querySelectorAll(".req-main-info")].map((button) =>
      button.getAttribute("aria-label"),
    ),
  );
  await page.evaluate(() => {
    const tree = document.getElementById("collection-tree");
    tree.scrollTop = tree.scrollHeight;
  });
  await page.waitForFunction(
    (first) =>
      [...document.querySelectorAll(".req-main-info")].some(
        (button) => !first.includes(button.getAttribute("aria-label")),
      ),
    first,
  );
  assert.ok(
    await page.evaluate(
      () => document.querySelectorAll(".request-item").length <= 100,
    ),
  );
  await page.fill("#collection-search", "Benchmark request 9999");
  await page.click('[aria-label="GET Benchmark request 9999"]');
  const original = await page.evaluate(
    () => document.getElementById("req-url").value,
  );
  await page.fill("#req-url", "http://example.test/virtual-draft");
  await page.fill("#collection-search", "Benchmark request 0");
  await page.click('[aria-label="GET Benchmark request 0"]');
  await page.fill("#collection-search", "Benchmark request 9999");
  await page.click('[aria-label="GET Benchmark request 9999"]');
  assert.equal(
    await page.evaluate(() => document.getElementById("req-url").value),
    "http://example.test/virtual-draft",
  );
  await page.fill("#req-url", original);
  await page.click("#btn-save-req");
  await page.waitForFunction(
    () => document.getElementById("save-status").textContent === "Saved",
  );
  await page.fill("#collection-search", "");
  await page.focus("#collection-tree");
  await page.press("#collection-tree", "Home");
  await page.press(".req-main-info:focus", "End");
  await page.focus("#collection-tree");
  await page.press("#collection-tree", "ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "GET Race A");
  await page.press(".req-main-info:focus", "End");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.getAttribute("aria-label"),
    ),
    "GET Race B",
  );
  await page.press(".req-main-info:focus", "Enter");
  assert.equal(
    await page.evaluate(
      () => document.getElementById("request-name").textContent,
    ),
    "Race B",
  );
  await page.press(".req-main-info:focus", "Home");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.getAttribute("aria-label"),
    ),
    "GET Benchmark request 0",
  );
  await page.press(".req-main-info:focus", "Enter");
  assert.equal(
    await page.evaluate(
      () => document.getElementById("request-name").textContent,
    ),
    "Benchmark request 0",
  );
  await page.evaluate(() => {
    const tree = document.getElementById("collection-tree");
    tree.scrollTop = tree.scrollHeight;
  });
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="GET Benchmark request 0"]'),
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "collection-tree",
  );
  await page.press("#collection-tree", "ArrowDown");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.getAttribute("aria-label"),
    ),
    "GET Benchmark request 1",
  );
  await page.press(".req-main-info:focus", "Enter");
  assert.equal(
    await page.evaluate(
      () => document.getElementById("request-name").textContent,
    ),
    "Benchmark request 1",
  );
  return {
    verdict: "PASS",
    cases: [
      "bounded DOM for 10k workspace",
      "scroll reaches later requests",
      "search finds offscreen request",
      "draft ownership survives window changes",
      "Home/End and Enter select exact requests",
      "scroll-away retains logical keyboard focus and arrow navigation",
    ],
  };
}
