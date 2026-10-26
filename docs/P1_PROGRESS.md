# P1 workspace foundation

Status: **complete — 15 of 15 P1 tasks accepted locally**. [P1_ACCEPTANCE.json](verification/P1_ACCEPTANCE.json) records the final checks and source identities. P2 is queued. [TASK_TRACKER.md](TASK_TRACKER.md) is the current task record; the increment sections below retain historical evidence and limitations. P0's scoped local-core gate is recorded in [P0_GATE.json](P0_GATE.json).

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

## Workspace path and read hardening

Source: `f6eebb49c2874c54c0f42903bebccbd3e880d4e4`. This later increment passed **124 tests across 17 files** locally. Five public workspace regressions reproduce linked managed directories at startup, redirection after startup, a linked initialization marker, replacement by a different real directory and an oversized revision file. The symlink cases run on POSIX; supported Windows installation/behavior still requires P5 QA.

The service binds the selected root to its canonical path and captures bigint device/inode identities for managed directories. Paths are checked at filesystem boundaries and workspace API entry/after body input. Root/managed symlinks are intentionally rejected; replacing a managed directory requires restoring the original directory or restarting after reviewing the new data. Markers, journals and resource destinations must be regular bounded files. New directories request 0700 permissions; existing directory permissions are preserved. File writes retain exclusive 0600 temporary files.

Canonical reads and hash-revision reads now share descriptor-based handling: no-follow/nonblocking flags where available, descriptor type/size checks, 64 KiB chunks and a 2 MiB byte cap even if the file grows. Unsafe paths and oversized files are preserved and reported instead of repaired or overwritten. Workspace reads/exports/new executions are blocked when directory identities change; health, capture controls and existing run inspection/cancel remain accessible.

The latest [fresh-process baseline](verification/P1_COLD_START.json) records 30 clean-source runs after this hardening: readiness p95 **70.395 ms**, backend RSS p95 **71.95 MiB**, with installed dependencies and warm OS caches. This is not a guaranteed process peak, combined browser cost or cross-machine comparison. The browser artifact above intentionally remains pinned to the earlier renderer commit.

These are integrity checks for the trusted local-account model. They do not prevent a malicious same-user process from racing separate filesystem calls, supply a cooperating-process lease, make revision checks atomic, or certify power-loss recovery. Those boundaries remain explicit release work.

The first CI submission of the path increment timed out in the oversized-file test. Its generic deep comparison of a 2 MiB Buffer took 1,952 ms locally and exceeded CI's five-second test limit. Switching that assertion to native exact byte equality reduced the local case to 36 ms without changing the expected file contents or raising timeouts. The [corrected submission passed Node 22/24 CI](https://github.com/abrar225/packetlark/actions/runs/40201638914).

## Cooperating-process ownership

Source: `59b7fd34b75bbb64944eaa4061ca389754877283`. This increment implements single-writer ownership before migration/seeding, with read-only owner status and explicit reviewed-token recovery after an exited same-host process. It also fixes overlapping startup/shutdown, interrupted release cleanup, readiness/signal ordering and port-exhaustion cleanup. Thirteen new public workspace/CLI cases bring the local suite to **137 tests in 18 files**. See [WORKSPACE_OWNERSHIP.md](WORKSPACE_OWNERSHIP.md) for the supported protocol, retained recovery markers and limitations.

A clean-source 30-process [ownership baseline](verification/P1_OWNERSHIP_COLD_START.json) recorded readiness p95 **71.939 ms** and backend RSS p95 **71.50 MiB** on the reference machine, with warm OS caches. This measures fresh temporary workspaces, not representative large-workspace startup or guaranteed peak RSS.

This closes the first local cooperating-process lease/recovery slice; external-editor reconciliation and the broader repository/manifest design remain open. No automatic lock expiry, distributed lock or independent crash-durability certification is claimed.

## External-file reconciliation and context review

Source: `503404f7d0977efb9681af95ef318853411beb2a` (core implementation `e94c467`). Validated conditional snapshots now reconcile disk changes while retaining dirty/busy resources. Explicit review supports disk reload, keeping request drafts with reviewed context and separate recovered collection/environment copies. Send and Run bind browser submissions to collection/environment revisions and reject stale context before transport. Workspace read/write budgets cover aggregate documents/bytes and managed directory entries.

Observed locally: **144 tests in 18 files**, **41 browser cases**, strict extension build, compatibility probes and production-only package smoke passed. A fresh 10,004-request reference run recorded startup/filter/selection p95 of **158.5 / 9.0 / 9.8 ms**. Source, viewport, measurement limits, behavioral details and remaining risks are in [WORKSPACE_RECONCILIATION.md](WORKSPACE_RECONCILIATION.md). This uses periodic polling and explicit version choices, not automatic three-way merging or durable recovery.

## Remaining requirements at the reconciliation increment (historical)

- A versioned per-request repository/manifest boundary. Local cooperating-process leases, explicit exited-owner recovery, basic path/symlink checks and polling-based external reconciliation are implemented; stronger cross-platform/race validation remains open.
- Complete collection/folder/request authoring: create, rename, duplicate, reorder, move, delete and inherited settings with stable identities.
- Multiple request tabs and per-tab response ownership; bounded request history and examples.
- Broader draft/restart platform validation. Optional acknowledged browser recovery is implemented in the increment below; browser-process crash/power-loss and cross-platform behavior remain unverified. Repository backup/restore is a separate open requirement.
- Versioned per-request storage/manifest migration preserving imported metadata, migration diagnostics, backups and validated restore.
- Expanded sanitized migration corpus and semantic differences for supported Postman v2.1/cURL imports. Postman native v3 YAML remains separately scoped to P7.

P2–P10 remain staged as approved in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). This increment does not supply OAuth, encrypted secrets, new protocols or enterprise services, and does not justify a new product rating.

## Program tracking and optional draft recovery — 26 October 2026

[TASK_TRACKER.md](TASK_TRACKER.md), generated from [task-tracker.json](roadmap/task-tracker.json), tracks all P1–P10 delivery tasks and all 92 comparison requirements. Each task carries acceptance criteria, dependencies, status and evidence. Requirement scopes distinguish a phase increment from acceptance of the complete broad capability. `npm run roadmap:check` is part of the normal check command; executable negative cases reject skipped phase prerequisites, unresolved phase scopes, cycles and duplicate phase IDs.

The browser now offers explicit local-consent recovery of dirty request drafts, their inherited collection context and failed environment edits. Acknowledged snapshots use IndexedDB, preserve original revisions and are independent across page loads. Recovery never automatically sends or saves. Storage/size failures retain the last acknowledged record and display a warning; malformed recovery is rejected before mutation. See [WORKSPACE_DRAFT_RECOVERY.md](WORKSPACE_DRAFT_RECOVERY.md) for privacy, retention, origin/identity boundaries and observed evidence.

This is one P1 deliverable. The versioned repository/manifest, safe storage migration/backup/restore, full collection/folder/request authoring, tabs/history/examples/undo and expanded migration corpus remain open. The first local stable release and P2 have not been started by this increment.

Observed for this increment: **146 automated tests in 19 files**, **18 new recovery browser cases** (including a real CLI process replacement), and **41 existing workspace browser cases** passed. Extension compilation, production-only package smoke and compatibility probes passed. The regression runner now resets the disposable fixture between groups; earlier attempts exposed fixture state leakage and an asynchronous confirmation-cleanup race, both recorded rather than represented as product passes.

Performance is **not green**. The retained unfocused 10,004-request run recorded startup/filter/selection p95 of **176.3 / 917.0 / 8.2 ms**. A focused instrumented run recorded **216.2 / 867.2 / 38.2 ms**; synchronous filtering work p95 was **4.2 ms**. Both filter event-to-frame results miss the existing 100 ms target. A separate blank-page input/frame control measured **8.6 ms** p95. Focus alone therefore does not explain the PacketLark outliers, and synchronous work is not a substitute for the failing full interval. All raw samples remain in the [focused record](verification/P1_DRAFT_RECOVERY_PERFORMANCE.json), [earlier record](verification/P1_DRAFT_RECOVERY_PERFORMANCE_UNFOCUSED.json) and [control](verification/P1_FRAME_CONTROL.json). These are one-machine synthetic measurements, not a physical-input or competitor benchmark.

**P1-015 remains in progress** to resolve that interaction gate. **P1-005** has a [repository design work record](P1_REPOSITORY_DESIGN.md), with format/commit/recovery decisions still open; no new storage schema or live migration is claimed. Exact code hashes and local verification are recorded in [the increment evidence](verification/P1_TRACKING_RECOVERY.json).

## Completed delivery work — 26 October 2026

The historical open items above are implemented. One [workspace repository](P1_REPOSITORY_DESIGN.md) owns canonical reads/commits across Studio, CLI and MCP. Explicit manifest migration retains legacy files and a verified backup, supports conditional restore and atomic cross-collection moves, and preserves per-request identities and opaque metadata. Disposable fault/restart tests include 10,004 requests; no live development workspace was migrated.

[Collection/folder/request authoring](WORKSPACE_AUTHORING.md) now includes create, rename, duplicate, delete, reorder, move, inherited settings and native drag-and-drop with revision/dirty/busy guards. [Workbench state](WORKBENCH_STATE.md) adds independent tabs/responses, bounded history and reviewed examples, undo and environment scope diagnostics. The [sanitized import corpus](IMPORT_COMPATIBILITY.md) checks supported Postman v2.1/cURL semantics through import, migration, restart and export. Portable conditional polling observes external changes; running requests retain their context until settlement and old-context responses are invalidated when disk context is adopted.

Observed functional evidence comprises 35 regression cases on each storage format, 22 authoring/workbench cases, 16 recovery cases, 6 large-list cases, 5 native drag cases, 2 automatic watch cases, 2 busy-watch cases and 2 real CLI restart cases: **125 browser case executions**, including repeated coverage across legacy/manifest formats. These are local Ego Page API checks, not remote/headless CI. The [implementation record](verification/P1_IMPLEMENTATION_VERIFICATION.json) names each artifact.

The [performance investigation](verification/P1_PERFORMANCE_INVESTIGATION.md) retains the old and current failures, same-page controls and source identities. The accepted [reference timing assessment](verification/P1_PERFORMANCE_GATE.json) records all 30 filter/selection samples with p95 **3.3 / 6.9 ms** against 100 ms. All before-sample OS checks report Ego foreground; after-sample drift remains disclosed. No continuous foreground or definitive historical-root-cause claim is made. The original experiment's stricter whole-run foreground `FAIL` remains unchanged. Broader performance/platform claims remain P5.

Final phase acceptance passed: **219 tests across 23 files**, extension compilation/bundling, a fresh production-only package install/CLI/WASM smoke, import compatibility/semantic probes, source-checked performance acceptance and diff validation. [P1_ACCEPTANCE.json](verification/P1_ACCEPTANCE.json) records the checks. All 14 P1 requirement scopes are accepted; eight requirements have no remaining cross-phase scope, while the six broader requirements retain their explicit P2/P4/P5 obligations. The tracker validator checks phase/task dependencies, evidence paths and these scoped dispositions. P2 remains queued; no stable release, deployment or full-product-parity claim is implied.
