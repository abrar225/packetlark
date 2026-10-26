/** Page-only diagnostics: no app internals, no timing substitutions or sample removal. */
export async function diagnoseFrames(page, baseUrl, samples = 30) {
  await page.cdp('Page.bringToFront');
  const rows = [];
  for (let index = 0; index < samples; index++) {
    await page.goto(`${baseUrl}/studio?frame_diagnostic=${index}`);
    await page.waitForFunction(() => performance.getEntriesByName('packetlark:studio-ready').length > 0 && document.getElementById('req-url').value !== '');
    await page.click('#collection-search');
    const row = await page.evaluate((index) => new Promise((resolve) => {
      const longTasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: 'longtask', buffered: true });
      const start = performance.now();
      let timerMs = null;
      setTimeout(() => { timerMs = performance.now() - start; }, 0);
      const field = document.getElementById('collection-search');
      field.value = index % 2 ? '' : 'Benchmark';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      const work = performance.now() - start;
      requestAnimationFrame((timestamp) => {
        const first = performance.now();
        requestAnimationFrame((secondTimestamp) => {
          const second = performance.now();
          observer.disconnect();
          resolve({ index, start, ready: performance.getEntriesByName('packetlark:studio-ready')[0].startTime, work_ms: work, first_frame_ms: first - start, second_frame_ms: second - start, first_timestamp: timestamp, second_timestamp: secondTimestamp, zero_timer_ms: timerMs, long_tasks: longTasks.filter((task) => task.start + task.duration >= start), visibility: document.visibilityState, focused: document.hasFocus(), rendered_requests: document.querySelectorAll('.req-main-info').length });
        });
      });
    }), index);
    rows.push(row);
  }
  return { measured_at: new Date().toISOString(), methodology: '30 fresh navigations, ready mark plus nonempty request URL, real search-field click then alternating public filter input events. In-page zero-delay timer, two native animation frames and Long Tasks observer distinguish handler time/main-thread blockage from frame scheduling. All samples retained; this is diagnosis, not replacement of the event-to-first-frame gate.', rows };
}
