// Run using Ego nodejs; requires scripts/test-server.mjs (isolated workspace).
const task = await taskSpace("PacketLark platform compatibility 2026-10-25");
const page = task.page("p1");
const assert = (await import("node:assert/strict")).default;
const collection = {
  info: { _postman_id: "platform-browser", name: "Platform browser checks" },
  variable: [{ key: "base", value: "http://localhost:4050" }],
  event: [
    {
      listen: "prerequest",
      script: { exec: ['pm.variables.set("path","/api/health");'] },
    },
    {
      listen: "test",
      script: {
        exec: [
          'pm.test("Inherited test",()=>pm.response.to.have.status(200));',
        ],
      },
    },
  ],
  item: [
    {
      name: "Local health",
      request: { method: "GET", url: "{{base}}{{path}}" },
      event: [
        {
          listen: "test",
          script: {
            exec: [
              'pm.test("Async test",async()=>{await new Promise(r=>setTimeout(r,1));pm.expect(pm.response.json()).to.have.deep.property("status","healthy");});',
            ],
          },
        },
      ],
    },
  ],
};
await page.goto("http://localhost:4050/studio");
const imported = await page.fetch("/api/import/postman", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(collection),
});
assert.equal(imported.status, 200);
await page.reload();
await page.click('loc=css:button[aria-label="GET Local health"]');
await page.click("loc=css:#btn-send-main");
await page.waitForFunction(
  () => document.getElementById("tests-count").textContent === "2",
  undefined,
  { timeout: 10000 },
);
assert.equal(
  await page.evaluate(() => document.getElementById("res-status").textContent),
  "200 OK",
);
console.log(
  "PASS: UI resolves inherited scripts, collection and local variables, async assertions",
);
await page.click("loc=css:#btn-runner-view");
await page.fill("loc=css:#run-data", '[{"row":"one"},{"row":"two"}]');
await page.click("loc=css:#start-run");
await page.waitForFunction(
  () =>
    document.getElementById("run-progress").textContent.startsWith("PASSED:"),
  undefined,
  { timeout: 10000 },
);
assert.match(
  await page.evaluate(
    () => document.getElementById("run-progress").textContent,
  ),
  /2 requests · 4 assertions passed/,
);
console.log(
  "PASS: UI data runner reports two iterations and inherited/async tests",
);
const fs = await import("node:fs/promises");
const axe = await fs.readFile(
  "/Users/abrarakhunji/Desktop/PacketLark/node_modules/axe-core/axe.min.js",
  "utf8",
);
await page.evaluate((source) => {
  const script = document.createElement("script");
  script.textContent = source;
  document.head.appendChild(script);
}, axe);
const a11y = await page.evaluate(async () => {
  const r = await axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
  });
  return {
    violations: r.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target),
    })),
    incomplete: r.incomplete.length,
  };
});
assert.deepEqual(a11y.violations, []);
console.log("PASS: Runner axe scan: " + JSON.stringify(a11y));
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
console.log("PASS: Runner 390px no document overflow");
await page.cdp("Emulation.clearDeviceMetricsOverride");
console.log(await page.snapshot());
