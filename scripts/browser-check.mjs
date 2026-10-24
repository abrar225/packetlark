// Run with the isolated server: node scripts/test-server.mjs
// Then import this file with ego-browser nodejs -e, using its absolute file URL.
// This script uses Ego's injected taskSpace API, not standalone Node.
const fs = await import("node:fs/promises");
const assert = (await import("node:assert/strict")).default;
const cwd = (await import("node:url"))
  .fileURLToPath(new URL("../", import.meta.url))
  .replace(/\/$/, "");
const task = await taskSpace("Rea redesign and evaluation");
const page = task.page("p1");
const origin = "http://localhost:4050";
const checks = [];
const mark = (name) => {
  checks.push(name);
  console.log(`PASS: ${name}`);
};
const axeSource = await fs.readFile(
  `${cwd}/node_modules/axe-core/axe.min.js`,
  "utf8",
);
async function accessibility(name) {
  await page.evaluate((source) => {
    const script = document.createElement("script");
    script.textContent = source;
    document.head.appendChild(script);
  }, axeSource);
  const results = await page.evaluate(async () => {
    const result = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return {
      violations: result.violations.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
      incomplete: result.incomplete.length,
    };
  });
  assert.deepEqual(results.violations, [], JSON.stringify(results));
  mark(
    `${name}: representative axe scan (${results.incomplete} checks need manual review)`,
  );
}
await page.goto(`${origin}/`);
await page.waitForFunction(
  () =>
    document.querySelector(".hero-copy h1 span") &&
    getComputedStyle(document.querySelector(".hero-copy h1 span:last-child"))
      .opacity === "1",
);
await page.evaluate(async () => await document.fonts.ready);
await page.click('loc=css:[data-demo="projects"]');
await page.click("loc=css:#demo-send");
assert.equal(
  await page.evaluate(() => document.getElementById("demo-status").textContent),
  "200 OK · sample data",
);
assert.equal(
  await page.evaluate(() =>
    document.getElementById("demo-code").textContent.includes("projects"),
  ),
  true,
);
mark("Homepage sample request switching and response");
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
assert.equal(await page.evaluate(() => innerWidth), 1440);
await accessibility("Homepage desktop");
await page.evaluate(() => scrollTo(0, 0));
await page.waitForFunction(() => scrollY === 0);
await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
await page.screenshot({ path: `${cwd}/assets/homepage.png` });
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
assert.equal(
  await page.evaluate(
    () => document.documentElement.scrollWidth === innerWidth,
  ),
  true,
);
mark("Homepage 390px: no horizontal overflow");
await page.evaluate(() => scrollTo(0, 0));
await page.waitForFunction(() => scrollY === 0);
await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
await page.screenshot({ path: `${cwd}/assets/homepage-mobile.png` });
await page.cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
await page.waitForFunction(
  () => !document.documentElement.classList.contains("lenis"),
);
assert.deepEqual(
  await page.evaluate(() => ({
    visible: [...document.querySelectorAll("h1 span")].every(
      (e) => getComputedStyle(e).opacity === "1",
    ),
    smooth: document.documentElement.classList.contains("lenis"),
  })),
  { visible: true, smooth: false },
);
mark("Reduced motion: content visible, Lenis destroyed");
assert.deepEqual(
  await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((r) => r.name)
      .filter((url) => !url.startsWith(location.origin)),
  ),
  [],
);
mark("Homepage fonts, icons and scripts: no third-party network resources");
await page.goto(`${origin}/studio`);
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.waitForFunction(
  () =>
    document.getElementById("connection-state").textContent ===
    "Connected locally",
);
await page.evaluate(() => {
  window.qaErrors = [];
  window.addEventListener("error", (e) => window.qaErrors.push(e.message));
  window.addEventListener("unhandledrejection", (e) =>
    window.qaErrors.push(String(e.reason)),
  );
});
const collectionId = `col_browser_qa_${Date.now()}`;
const collection = {
  info: { _postman_id: collectionId, name: "Browser QA" },
  item: [
    {
      name: "Health check",
      request: { method: "GET", url: `${origin}/api/health`, header: [] },
      event: [
        {
          listen: "test",
          script: {
            exec: [
              'pm.test("Healthy", function () { pm.response.to.have.status(200); pm.expect(pm.response.json().status).to.equal("healthy"); });',
            ],
          },
        },
      ],
    },
  ],
};
try {
  await page.click('loc=css:button[onclick="openImportModal()"]');
  await page.fill("loc=css:#import-text", JSON.stringify(collection));
  await page.click("loc=css:#modal-footer button:first-child");
  await page.waitForFunction(
    () =>
      document.getElementById("request-name").textContent === "Health check",
  );
  mark("Postman import selects newly imported request");
  await page.click("loc=css:#btn-send-main");
  await page.waitForFunction(
    () => document.getElementById("tests-count").textContent === "1",
  );
  assert.equal(
    await page.evaluate(() =>
      document.getElementById("res-tests").textContent.includes("Healthy"),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => document.getElementById("res-status").textContent,
    ),
    "200 OK",
  );
  mark("Real local request and pm assertion pass");
  await page.click('loc=css:[data-res-tab="tests"]');
  await page.click('loc=css:[data-tab="headers"]');
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector(".response-pane .tab-btn.active")?.dataset
          .resTab,
    ),
    "tests",
  );
  mark("Request tabs preserve response tab selection");
  await page.fill("loc=css:#collection-search", "unlikely-no-match");
  assert.equal(
    await page.evaluate(
      () => document.querySelectorAll(".request-item").length,
    ),
    0,
  );
  await page.fill("loc=css:#collection-search", "");
  mark("Collection filtering");
  await page.click('loc=css:button[onclick="openCodeGeneratorModal()"]');
  assert.equal(
    await page.evaluate(() =>
      document.getElementById("snippet-textarea").value.includes("/api/health"),
    ),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() => document.querySelector("header").inert),
    false,
  );
  mark("Code snippet and Escape returns dialog focus");
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await accessibility("Workbench desktop");
  await page.click('loc=css:[data-tab="scripts"]');
  await page.click('loc=css:[data-res-tab="body"]');
  await page.screenshot({ path: `${cwd}/assets/preview.png` });
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth === innerWidth,
    ),
    true,
  );
  mark("Workbench 390px: no horizontal overflow");
  await page.screenshot({ path: `${cwd}/assets/studio-mobile.png` });
  await fetch("http://127.0.0.1:8095/http://localhost:4050/api/health");
  await page.click("loc=css:#btn-sniffer-view");
  await page.waitForFunction(
    () => Number(document.getElementById("sniff-count").textContent) > 0,
  );
  await page.click('loc=css:button[onclick="exportOpenApi()"]');
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector("#modal-body textarea")
        .value.includes('"openapi": "3.1.0"'),
    ),
    true,
  );
  await page.keyboard.press("Escape");
  mark("Forwarded traffic and OpenAPI preview");
  assert.deepEqual(await page.evaluate(() => window.qaErrors), []);
  mark("No runtime errors during tested studio workflows");
} finally {
  await fetch(`${origin}/api/collections/${collectionId}`, {
    method: "DELETE",
  });
}
await page.cdp("Emulation.setEmulatedMedia", { features: [] });
await page.cdp("Emulation.clearDeviceMetricsOverride");
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
