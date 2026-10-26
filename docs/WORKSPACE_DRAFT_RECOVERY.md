# Local browser draft recovery

P1 adds optional recovery of unsaved request drafts and failed/pending environment edits. It is separate from canonical workspace saves, run history and backup/restore. P1 local acceptance is recorded in [P1_ACCEPTANCE.json](verification/P1_ACCEPTANCE.json); broader supported-platform recovery validation remains P5 in [the task tracker](TASK_TRACKER.md).

## Enable, acknowledge and recover

Open **Draft recovery**, read the local-storage explanation and choose **Enable local draft recovery**. Enabling requires explicit confirmation because request bodies, scripts, authentication, collection context and environment values can contain plaintext credentials. Recovery is off by default. This is not a keychain or encrypted vault; those remain P2 work.

Edits schedule a snapshot after 200 ms. **Draft recovery pending…** means the current edit is not yet acknowledged. **Draft recovery saved locally** appears only after the IndexedDB transaction completes. Quota, provider and validation failures leave the live draft dirty, preserve the previous acknowledged record and show a warning. The existing unload warning remains active; the last edit before a crash may precede the last completed transaction.

After reopening/reloading, open **Draft recovery** and explicitly restore a record. Restoration does not save canonical resources, execute scripts, send requests or rerun jobs. Existing dirty/saving edits in the current page must first be resolved. A whole recovery is validated before it is applied; unsupported or malformed records are preserved for explicit removal rather than partially restored.

Original collection and environment revisions are retained. Disk changes/deletions use the normal [workspace conflict review](WORKSPACE_RECONCILIATION.md). Review inherited scripts/authentication before selecting a version. A stale recovered save is rejected. For an externally deleted resource, save a recovered copy instead of silently recreating its original ID.

Each page load owns a separate random record ID. Restoring a different page's record creates a recovery owned by the new page; it does not overwrite or remove the source. Other live pages keep their edits. Historical/source records remain until the user chooses **Discard recovery record**. This operation removes stored recovery only; a still-active page may create another record from its live edits.

Disabling recovery stops future writes after pending work settles. Existing records remain until explicitly discarded. Another page's disabled workspace setting is checked inside each write transaction so an older queued write cannot re-enable persistence. Reload other open pages to refresh their setting display.

## Identity, retention and boundaries

- Database: `packetlark-draft-recovery-v1`, browser origin storage, partitioned by workspace through an IndexedDB index.
- Workspace identity: an opaque hash of the canonical root path and its directory identity. It remains stable across normal Studio/CLI restarts and distinguishes different roots without returning the filesystem path.
- Limits: 8 MiB of serialized snapshot data per page record; 16 records and 32 MiB of serialized snapshot data per workspace. A snapshot includes the original collection context for its dirty requests. There is no silent eviction to make room; discard older records explicitly.
- These counters exclude IndexedDB/JavaScript object overhead. They do not impose an OS/browser memory quota or cap the number of different workspaces stored in a browser profile.
- Reusing a different hostname/port/browser profile, moving or replacing the workspace directory, private browsing, clearing site data and browser storage eviction can make old records unavailable. Keep the same browser origin for normal restart recovery. Workspace backups do not include browser recovery records.
- IndexedDB transaction completion and the observed normal reload/CLI-restart behavior are the supported recovery evidence. Browser-process crash/power-loss durability, cross-browser/OS certification and protection against a malicious same-user process are not claimed. P5 owns broader platform validation; P1's separate repository/backup/restore task remains open.

## Verification

The [browser recovery record](verification/P1_DRAFT_RECOVERY_BROWSER.json) covers consent, acknowledged reload recovery, no automatic canonical write/transport, stale-context conflicts, independent concurrent pages, failed environment saves, size failure, storage-provider failure and malformed environment revision rejection. The actual CLI-process restart case is recorded alongside that evidence. Browser checks use disposable workspaces and only remove recovery keys belonging to those fixtures.

The automated API/restart test also verifies stable workspace identity and separation between roots. Tracker regression tests prove skipped phases, unresolved requirement scopes, duplicate phases and dependency cycles are rejected. Product build, tests, package/extension checks and exact source hashes are recorded in the increment's verification artifact.

Reproduce with `npm run build`, a disposable `node scripts/p0-browser-fixture.mjs` server, and the exported public Ego Page API checks in `scripts/check-p1-draft-recovery.mjs`. `scripts/p1-draft-restart-fixture.mjs` runs the real CLI in a child; writing `restart` to its stdin replaces that child on the same origin and workspace. Stop the fixture parent afterward to remove only its temporary root.
