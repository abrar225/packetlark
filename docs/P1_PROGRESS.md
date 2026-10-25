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

## Workspace path and read hardening

Source: `f6eebb49c2874c54c0f42903bebccbd3e880d4e4`. This later increment passed **124 tests across 17 files** locally. Five public workspace regressions reproduce linked managed directories at startup, redirection after startup, a linked initialization marker, replacement by a different real directory and an oversized revision file. The symlink cases run on POSIX; supported Windows installation/behavior still requires P5 QA.

The service binds the selected root to its canonical path and captures bigint device/inode identities for managed directories. Paths are checked at filesystem boundaries and workspace API entry/after body input. Root/managed symlinks are intentionally rejected; replacing a managed directory requires restoring the original directory or restarting after reviewing the new data. Markers, journals and resource destinations must be regular bounded files. New directories request 0700 permissions; existing directory permissions are preserved. File writes retain exclusive 0600 temporary files.

Canonical reads and hash-revision reads now share descriptor-based handling: no-follow/nonblocking flags where available, descriptor type/size checks, 64 KiB chunks and a 2 MiB byte cap even if the file grows. Unsafe paths and oversized files are preserved and reported instead of repaired or overwritten. Workspace reads/exports/new executions are blocked when directory identities change; health, capture controls and existing run inspection/cancel remain accessible.

The latest [fresh-process baseline](verification/P1_COLD_START.json) records 30 clean-source runs after this hardening: readiness p95 **70.395 ms**, backend RSS p95 **71.95 MiB**, with installed dependencies and warm OS caches. This is not a guaranteed process peak, combined browser cost or cross-machine comparison. The browser artifact above intentionally remains pinned to the earlier renderer commit.

These are integrity checks for the trusted local-account model. They do not prevent a malicious same-user process from racing separate filesystem calls, supply a cooperating-process lease, make revision checks atomic, or certify power-loss recovery. Those boundaries remain explicit release work.

The first CI submission of the path increment timed out in the oversized-file test. Its generic deep comparison of a 2 MiB Buffer took 1,952 ms locally and exceeded CI's five-second test limit. Switching that assertion to native exact byte equality reduced the local case to 36 ms without changing the expected file contents or raising timeouts. The corrected submission requires a fresh Node 22/24 CI pass.

## Cooperating-process ownership

Source: `59b7fd34b75bbb64944eaa4061ca389754877283`. This increment implements single-writer ownership before migration/seeding, with read-only owner status and explicit reviewed-token recovery after an exited same-host process. It also fixes overlapping startup/shutdown, interrupted release cleanup, readiness/signal ordering and port-exhaustion cleanup. Thirteen new public workspace/CLI cases bring the local suite to **137 tests in 18 files**. See [WORKSPACE_OWNERSHIP.md](WORKSPACE_OWNERSHIP.md) for the supported protocol, retained recovery markers and limitations.

A clean-source 30-process [ownership baseline](verification/P1_OWNERSHIP_COLD_START.json) recorded readiness p95 **71.939 ms** and backend RSS p95 **71.50 MiB** on the reference machine, with warm OS caches. This measures fresh temporary workspaces, not representative large-workspace startup or guaranteed peak RSS.

This closes the first local cooperating-process lease/recovery slice; external-editor reconciliation and the broader repository/manifest design remain open. No automatic lock expiry, distributed lock or independent crash-durability certification is claimed.

## Remaining P1 requirements

- A repository boundary with external-file change reconciliation and versioned manifests. Local cooperating-process leases, explicit exited-owner recovery and basic path/symlink checks are implemented; stronger cross-platform/race validation remains open.
- Complete collection/folder/request authoring: create, rename, duplicate, reorder, move, delete and inherited settings with stable identities.
- Multiple request tabs and per-tab response ownership; bounded request history and examples.
- Durable draft recovery and explicit conflict review, including external deletion, malformed files and recovery after restart.
- Versioned per-request storage/manifest migration preserving imported metadata, migration diagnostics, backups and validated restore.
- Expanded sanitized migration corpus and semantic differences for supported Postman v2.1/cURL imports. Postman native v3 YAML remains separately scoped to P7.

P2–P10 remain staged as approved in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). This increment does not supply OAuth, encrypted secrets, new protocols or enterprise services, and does not justify a new product rating.
