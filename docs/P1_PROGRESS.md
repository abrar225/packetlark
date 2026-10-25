# P1 workspace foundation

Status: **in progress**. P0's scoped local-core gate is recorded in [P0_GATE.json](P0_GATE.json). The first P1 increment fixes large-workspace rendering; it does not close the whole phase.

## Implemented increment

Source: `096121507ef1f27fb345dbcf0ffbead4ea21f2db`.

- Native-scroll collection rendering retains only viewport rows plus overscan. Search still covers the complete workspace, nested folders and unsaved request URLs. Collapsed folders can be expanded using Enter.
- Selection/dirty state updates avoid rebuilding the entire collection tree. Save commits refresh collection revision ownership before subsequent edits.
- Home, End and arrow navigation reach offscreen requests; recycled focused rows transfer focus to the stable list container. Enter selects the exact focused request.
- Native items without a separate request ID use the item ID for initial selection, execution and subsequent editing. Ambiguous cross-item ID aliases are rejected before commit, preserving the previous file. Existing malformed canonical files remain explicit repair errors; IDs are not silently rewritten.

## Observed verification

`npm run check`: **119 tests across 17 files passed**. Two new public API/restart cases cover native identity and rejection of ambiguous IDs. Browser checks observed: the existing 16 P0 ownership cases, six large-workspace cases, native first-load execution, and three nested/search/folder cases (**26 cases** total). The browser harness is a manual Ego Page API runner, not part of headless CI.

[P1_BROWSER.json](verification/P1_BROWSER.json) records a fresh server built from the source above, with 10,004 requests across 22 collections and 30 samples per operation. The last observed viewport rendered **31 request rows**. Startup p95 was **148.7 ms**, filter event-to-next-frame p95 **36.1 ms**, and selection **48.3 ms**, within the reference 100 ms interaction target. The older [P0 browser baseline](verification/P0_BROWSER_BASELINE.json) recorded 490/801/805.5 ms respectively with all 10,004 rows rendered.

These are synthetic DOM-event timings on one reference browser/machine, not physical-input INP, guaranteed completed paints, a cross-device performance promise or a Postman comparison. The P0 baseline has explicit source limitations, and the new harness brings the QA tab to the foreground; the samples are informative rather than a controlled causal A/B study. The final recorded document was visible but did not report focus. No samples were removed from either published run.

An earlier uncommitted run failed the filter target because its first two frame waits approached one second. It is retained in [P1_BROWSER_PRECOMMIT.json](verification/P1_BROWSER_PRECOMMIT.json); the underlying cause was not conclusively established. The later source-pinned run passed. Broader performance validation remains a P5 release gate.

## Remaining P1 requirements

- A repository boundary with cooperating-process leases, explicit stale-lock recovery, path/symlink checks and external-file change reconciliation.
- Complete collection/folder/request authoring: create, rename, duplicate, reorder, move, delete and inherited settings with stable identities.
- Multiple request tabs and per-tab response ownership; bounded request history and examples.
- Durable draft recovery and explicit conflict review, including external deletion, malformed files and recovery after restart.
- Versioned per-request storage/manifest migration preserving imported metadata, migration diagnostics, backups and validated restore.
- Expanded sanitized migration corpus and semantic differences for supported Postman v2.1/cURL imports. Postman native v3 YAML remains separately scoped to P7.

P2–P10 remain staged as approved in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). This increment does not supply OAuth, encrypted secrets, new protocols or enterprise services, and does not justify a new product rating.
