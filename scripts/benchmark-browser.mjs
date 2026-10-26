// Ego Page API only; measurements dispatch public DOM events, never call application internals.
export async function measureBrowser(page, baseUrl, samples = 30, options = {}) {
  if (!Number.isInteger(samples) || samples < 1) throw new Error("samples must be a positive integer");
  await page.cdp("Page.bringToFront");
  await page.cdp("Network.enable");
  await page.cdp("Network.setCacheDisabled", { cacheDisabled: true });
  const startup = [],
    filter = [],
    selection = [],
    filterWork = [],
    filterFrames = [],
    startupSurfaces = [],
    hostObservations = [];
  // Optional host precondition checks run outside each measured interval.
  // DOM focus/visibility alone do not establish OS foreground ownership.
  const observeHost = async (phase, index, boundary) => {
    if (options.observeHost)
      hostObservations.push({ phase, index, boundary, ...await options.observeHost({ phase, index, boundary }) });
  };
  let surface;
  for (let i = 0; i < samples; i++) {
    await observeHost("startup", i, "before");
    await page.goto(`${baseUrl}/studio?benchmark_round=${i}`);
    await page.waitForFunction(
      () =>
        performance.getEntriesByName("packetlark:studio-ready").length > 0 &&
        document.getElementById("req-url").value !== "",
    );
    const state = await page.evaluate(() => ({
      ready_ms: performance.getEntriesByName("packetlark:studio-ready")[0].startTime,
      rendered_requests: document.querySelectorAll(".req-main-info").length,
      viewport: [innerWidth, innerHeight],
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      browser: navigator.userAgent,
      device_pixel_ratio: devicePixelRatio,
      hardware_concurrency: navigator.hardwareConcurrency,
      tree_height: document.getElementById("collection-tree").clientHeight,
    }));
    startup.push(state.ready_ms);
    startupSurfaces.push(state);
    surface = state;
    await observeHost("startup", i, "after");
    if ((i + 1) % 10 === 0) console.log(`startup ${i + 1}/${samples}`);
  }
  if (options.focusBeforeInteractions) await page.click("#collection-search");
  const interactionSurface = await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() }));
  for (let i = 0; i < samples; i++) {
    await observeHost("filter", i, "before");
    const measured = await page.evaluate(
        (i) =>
          new Promise((resolve) => {
            const field = document.getElementById("collection-search");
            const start = performance.now();
            field.value = i % 2 ? "" : "Benchmark";
            field.dispatchEvent(new Event("input", { bubbles: true }));
            const work = performance.now() - start;
            requestAnimationFrame((timestamp) => resolve({ total: performance.now() - start, start, frameTimestamp: timestamp, work, visibility: document.visibilityState, focused: document.hasFocus() }));
          }),
        i,
      );
    filter.push(measured.total);
    filterWork.push(measured.work);
    filterFrames.push({ visibility: measured.visibility, focused: measured.focused, start_ms: measured.start, frame_timestamp_ms: measured.frameTimestamp });
    await observeHost("filter", i, "after");
  }
  await page.evaluate(() => {
    const field = document.getElementById("collection-search");
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (let i = 0; i < samples; i++) {
    await observeHost("selection", i, "before");
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
    await observeHost("selection", i, "after");
  }
  const snapshot = JSON.parse((await page.fetch("/api/collections")).body);
  const count = (items) =>
    items.reduce(
      (total, item) => total + (item.request ? 1 : count(item.items || [])),
      0,
    );
  surface.workspace_requests = snapshot.reduce(
    (total, collection) => total + count(collection.items || []),
    0,
  );
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
      `Foreground QA tab; ${samples} navigations with browser HTTP cache disabled; studio-ready mark after environments, collections and health load. Filter and selection timings are DOM-event dispatch to next animation frame, not physical input latency or guaranteed paint completion. Existing browser process/OS caches are warm; no competitor comparison. No warmup or samples are removed.`,
    surface,
    startup_surfaces: startupSurfaces,
    host_observations: hostObservations,
    interactionSurface,
    focus_before_interactions: !!options.focusBeforeInteractions,
    startup: stats(startup),
    filter: stats(filter),
    filter_synchronous_work: stats(filterWork),
    filter_frame_state: filterFrames,
    selection: stats(selection),
  };
}
