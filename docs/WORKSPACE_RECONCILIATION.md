# External workspace changes and draft conflicts

Core implementation: `e94c467bf39f8d438fd8e50bcc88303388280929`; dialog-footer isolation follow-up: `503404f7d0977efb9681af95ef318853411beb2a`. This is a P1 increment, not a stable-release or full-platform completion claim.

## Refresh behavior

Visible workbenches check local files every five seconds using conditional HTTP requests. **Check files** requests a refresh immediately. This is portable polling, not a native filesystem watcher. Hidden documents skip automatic checks; browser scheduling can delay timers.

The service reads and validates both resource directories before publishing a combined snapshot. Its ETag represents resource IDs and content revisions. Malformed files are preserved and reported; they do not replace the last validated snapshot. The UI keeps its current state on refresh errors.

Clean selections adopt disk changes. A changed or deleted selected request clears its previous response, or clears selection if it no longer exists. Dirty and saving requests/environments remain owned by their local drafts, including when the disk resource has been deleted. A refresh started before a newer local commit cannot replace that commit. Save settlement invalidates synchronization state even after failure, so an unchanged-disk response cannot indefinitely hide a conflict.

## Explicit choices

**Review changes** shows one conflicting resource at a time, with local/disk previews limited to 64 KiB each. The common credential-field classifier is shared with server redaction; marked secret variables are hidden too. This does not infer arbitrary credentials inside scripts, URLs, raw text or transformed data. Large previews require inspecting the local files separately.

- **Load disk and discard local drafts** requires confirmation and discards drafts only for that resource.
- **Keep drafts with disk context** keeps dirty request contents and adopts the reviewed collection's inherited settings. Clean cached requests reload from disk. Missing draft requests cannot be rebased; use a recovered copy or discard.
- **Replace disk with local environment** is an explicit whole-environment version choice, not an automatic merge of individual variables. It saves with the reviewed revision; later changes still conflict.
- **Save recovered collection/environment copy** creates a separate ID containing local drafts. A collection copy preserves its nested structure and local inherited context. It preserves the current disk version and does not recreate a deleted original ID.

Resolution checks for a changed disk revision again before applying a choice. While resolving, the dialog/editor remain locked; copy requests have a ten-second client deadline. This prevents closing the dialog, editing again and then having an older copy completion discard those newer edits. Failures keep the local drafts. A network timeout can leave a copy already committed on the server; use Check files before retrying, since no automatic retry or exactly-once network guarantee is supplied.

## Send and Run

Browser submissions include the selected collection/environment revisions. Both operations refresh validated disk state and reject stale supplied context with `412 ERR_WORKSPACE_CONFLICT` before transport. Unsaved request contents may still be sent intentionally; the revision binds the inherited collection/environment context. The runner waits for pending environment saves and admits only one pending UI submission.

Older API clients may omit the optional revision fields for compatibility. They do not receive the browser's context-review guarantee. These checks do not make filesystem reads atomic against arbitrary external editors, supply destination grants, or approve hostile imported scripts; the P3 execution-policy work remains required.

## Workspace budgets

The supported local workspace currently allows:

- 2 MiB per canonical resource and per JSON API input.
- 1,000 collection/environment documents combined.
- 32 MiB of canonical resource bytes combined.
- 2,048 directory entries in each managed resource directory.

Reads stop when a budget is exceeded; proposed writes check aggregate bytes/count and projected destination entries, including initialization metadata. Over-limit external data is retained and reported as unavailable; new over-limit writes are rejected. Delete/reduce/split an oversized workspace rather than relying on automatic deletion. Native filesystem editors can bypass write quotas, so these are enforced application observations, not OS storage quotas.

Canonical byte counts do not include JavaScript object overhead, response serialization, interpreter state, recovery markers, browser state or peak process RSS. Temporary files and interrupted operations still require the broader recovery/maintenance design. The limits do not establish a universal memory or latency bound.

## Observed evidence

The build and **144 tests across 18 files** passed locally. New public API/restart cases cover conditional snapshots, external edits/deletions, malformed-state preservation, stale Send/Run context, aggregate bytes/count and directory/initialization boundaries.

All **41 browser cases** passed against fresh disposable servers at the follow-up source above, including the prior ownership workflows, 10,004-request navigation and the new conflict regressions. Review dialogs also discard footer actions from previously opened dialogs. See [the browser record](verification/P1_RECONCILIATION_BROWSER.json). These are manual Ego Page API checks, not installed editor-host or cross-OS certification.

[The source-pinned performance record](verification/P1_RECONCILIATION_PERFORMANCE.json) contains 30 samples per operation: startup p95 **158.5 ms**, filter event-to-next-frame **9.0 ms**, selection **9.8 ms**, with 31 request rows rendered out of 10,004. The viewport was 1107 × 871 and the tab was visible/focused. These are synthetic event/frame timings with warm browser/OS caches, not physical-input INP or guaranteed completed paints. The viewport differs from earlier baselines, so this is not a controlled causal comparison or a Postman benchmark.

Focused read-only review found no further actionable data-loss/silent-context issue after the reproduced fixes. Package smoke, extension build and compatibility probes also passed. CI is tracked on the stacked implementation PR.

## Remaining P1 work

Unsaved drafts remain in browser memory. Before-unload protection and recovered copies do not supply durable crash/restart recovery. Full collection/folder authoring, tabs/history, durable drafts, versioned per-request storage/manifest migration, backup/restore and a broader sanitized import corpus remain open. See [P1_PROGRESS.md](P1_PROGRESS.md) and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) before treating this as launch-ready.
