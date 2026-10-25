// Ego Page API only; measurements dispatch public DOM events, never call application internals.
export async function measureBrowser(page, baseUrl, samples = 30) {
  await page.cdp("Network.enable");
  await page.cdp("Network.setCacheDisabled", { cacheDisabled: true });
  const startup = [],
    filter = [],
    selection = [];
  let surface;
  for (let i = 0; i < samples; i++) {
    await page.goto(`${baseUrl}/studio?benchmark_round=${i}`);
    await page.waitForFunction(
      () =>
        performance.getEntriesByName("rea:studio-ready").length > 0 &&
        document.getElementById("req-url").value !== "",
    );
    const state = await page.evaluate(() => ({
      ready_ms: performance.getEntriesByName("rea:studio-ready")[0].startTime,
      rendered_requests: document.querySelectorAll(".req-main-info").length,
      viewport: [innerWidth, innerHeight],
      visibility: document.visibilityState,
      browser: navigator.userAgent,
    }));
    startup.push(state.ready_ms);
    surface = state;
    if ((i + 1) % 10 === 0) console.log(`startup ${i + 1}/${samples}`);
  }
  for (let i = 0; i < samples; i++) {
    filter.push(
      await page.evaluate(
        (i) =>
          new Promise((resolve) => {
            const field = document.getElementById("collection-search");
            const start = performance.now();
            field.value = i % 2 ? "" : "Benchmark";
            field.dispatchEvent(new Event("input", { bubbles: true }));
            requestAnimationFrame(() => resolve(performance.now() - start));
          }),
        i,
      ),
    );
  }
  await page.evaluate(() => {
    const field = document.getElementById("collection-search");
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (let i = 0; i < samples; i++) {
    selection.push(
      await page.evaluate(
        (i) =>
          new Promise((resolve, reject) => {
            const target = document.querySelector(
              `[aria-label="GET Benchmark request ${i % 2 ? 1 : 0}"]`,
            );
            if (!target) {
              reject(new Error("Benchmark request missing"));
              return;
            }
            const start = performance.now();
            target.click();
            requestAnimationFrame(() => resolve(performance.now() - start));
          }),
        i,
      ),
    );
  }
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      samples: values.length,
      p50_ms: +sorted[Math.ceil(values.length * 0.5) - 1].toFixed(3),
      p95_ms: +sorted[Math.ceil(values.length * 0.95) - 1].toFixed(3),
      raw_ms: values.map((value) => +value.toFixed(3)),
    };
  };
  return {
    measured_at: new Date().toISOString(),
    methodology:
      "30 navigations with browser HTTP cache disabled; studio-ready mark after environments, collections and health load. Filter and selection timings are DOM-event dispatch to next animation frame, not physical input latency or guaranteed paint completion. Existing browser process/OS caches are warm; no competitor comparison.",
    surface,
    startup: stats(startup),
    filter: stats(filter),
    selection: stats(selection),
  };
}
