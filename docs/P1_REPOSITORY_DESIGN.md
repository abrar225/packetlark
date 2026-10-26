# P1 canonical workspace repository

P1-005 and P1-006 use `WorkspaceRepository` as the sole storage owner. Studio inherits its public commands; CLI workspace commands and MCP reads use the same owner. Transport, execution and browser state remain outside the repository. This is an accepted opt-in storage transition; development has not migrated the live `.rea-api` directory.

## Public contract

- `snapshot()` validates and publishes collections/environments together and returns `{ format, revision, collections, environments }`. Returned snapshots are detached copies. Existing per-resource revisions and Studio public API shapes remain compatible.
- `persistCollection`, `persistEnvironment`, deletes and manifest `commitSnapshot` enforce optimistic revisions. Manifest transactions recheck the manifest immediately before replacement. Stale snapshots produce `ERR_WORKSPACE_CONFLICT`.
- `moveItem` and `POST /api/workspace/move` atomically move an item between migrated collections after checking both resource revisions. Legacy workspaces return `ERR_WORKSPACE_MIGRATION_REQUIRED`; safe copy remains available without migration.
- A writable owner acquires the cooperating-process lease before initialization. `{ readOnly: true }` never acquires a lease, creates directories, seeds resources, writes markers or recovers journals. Pending legacy initialization requires an explicit writer startup before inspection.
- `migrationPlan`, `backup`, `restorePlan`, `migrate` and `restore` are the migration boundary. The first two plan methods validate schema, target document/byte limits and checksums without changing files. Apply requires the reviewed checksum; restore additionally requires the current workspace revision.

The legacy per-resource format remains the default for existing/new workspaces until explicit migration. The previously supported array-to-per-resource startup recovery is retained for compatibility, separately from the new opt-in transition.

## Selected format

See [ADR 001](adr/001-workspace-manifest.md). `workspace-v1.json` is the only new-format commit point. An advisory `.format-v1` marker prevents later deletion of the active manifest from silently reviving retained legacy data; it carries no resource contents or revision. It references immutable SHA-256 named JSON objects in `objects/XX/` (two-character hash-prefix shards). Request objects are versioned independently; collection objects contain metadata and ordered item/folder skeletons with request references, and environment objects contain their versioned resource. Request payloads are not repeated in collection skeletons. Wrapper envelopes prevent collision with opaque imported field names.

Request/item IDs, order, collection/folder inheritance and opaque import metadata survive dehydration/hydration. A request edit adds its request object and changed collection skeleton, then replaces the manifest. Unchanged request objects are reused; previous objects remain for recovery. No index or second database is authoritative.

## Recovery, reconciliation and bounds

Before manifest replacement, interruptions leave the previous complete workspace authoritative; unreferenced objects can remain. After replacement, restart reads the new complete snapshot. Invalid/missing referenced objects fail closed with `ERR_WORKSPACE_INVALID`; damaged data is preserved. A failed migration before manifest publication leaves the legacy files authoritative and can be retried with a fresh preview.

External valid manifest replacement is reconciled on the next snapshot, including deletes. Content-addressed objects must not be edited in place: a changed hash or missing object is reported for repair. External tools can create objects and publish a valid manifest. Hash checks detect conflicts with noncooperating editors; they are not a hostile same-user atomicity guarantee.

Managed reads retain no-follow regular-file checks and bound directory identities. Each resource/object/manifest is at most 2 MiB; a selected snapshot is at most 1000 collection/environment resources and 32 MiB, with up to 10,000 validated item/folder nodes per collection. Requests are separately stored documents, not charged as additional collection/environment resources. Retained objects also count against 32 MiB; each hash-prefix shard is bounded to 2048 entries. Backup envelopes have an explicit 64 MiB cap, bounded no-follow reads, private permissions and SHA-256 validation. There is no automatic object deletion or backup pruning: hitting retention bounds is an actionable error. Filesystem directory fsync follows atomic replacement; filesystem/OS durability still depends on platform guarantees.

## Migration and restore

Stop Studio before applying a migration/restore so the CLI can acquire the writer lease. Preview is available while a writer is running. CLI paths are project roots, with `.rea-api` appended.

```sh
rea-api workspace migrate --workspace /path/to/project
rea-api workspace migrate --workspace /path/to/project --apply --checksum REVIEWED_PLAN_CHECKSUM
rea-api workspace snapshot --workspace /path/to/project
rea-api workspace backup --workspace /path/to/project --backup-file /path/to/new-backup.json
rea-api workspace restore --workspace /path/to/project --backup-file /path/to/backup.json
rea-api workspace restore --workspace /path/to/project --backup-file /path/to/backup.json --apply --checksum REVIEWED_BACKUP_CHECKSUM --revision REVIEWED_CURRENT_REVISION
```

Migration retains the original files untouched, writes/fsyncs a logical old-format backup named `backup-CHECKSUM.json`, reads it back for verification, stages immutable objects and publishes the manifest last. Restore validates the whole backup, refuses unreviewed/stale destruction, retains a pre-restore backup and publishes a complete manifest transaction. It does not downgrade a workspace or overwrite retained legacy files. Backups contain workspace values and must be handled as private local data; nothing is uploaded.

## Evidence and limits

`tests/repository-storage.test.ts` covers readonly byte equality, migration authorization and backup retention, isolated request edits with opaque metadata, 10,004-request migration/restart, missing/altered objects, optimistic conflicts, external manifest reconciliation, guarded restore, directory/object symlinks, public Studio cross-collection move, CLI preview/apply and interrupted backup/object/manifest commit boundaries. Existing workspace integrity and lease suites remain applicable to the extracted legacy adapter. The import corpus additionally exercises both formats through Studio restart/export.

Tests use disposable temporary workspaces and injected filesystem failures. They establish supported process-level recovery, not arbitrary hardware power-loss survival or hostile editor race exclusion. Cross-platform Node/OS packaging and long-term object-retention UX need their broader release checks; no native dependency was added.
