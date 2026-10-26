# ADR 001: immutable workspace objects with one manifest commit

Status: accepted for the explicit P1 migration path, 26 October 2026.

## Decision and alternatives

A journaled stable-file layout gives compact path-stable Git diffs, but every reader must recover a multi-file edit/deletion transaction before serving data. Readonly tools would either mutate during recovery or refuse reads while a journal remains. A restore or cross-collection move increases this recovery surface.

An immutable-object layout writes complete new request/collection/environment documents first and atomically replaces one versioned manifest last. Readers can always select the previous or next complete snapshot. This makes the manifest the sole commit point and permits genuinely readonly inspection without recovery writes. This layout is selected without an additional database/native dependency.

Version 1 uses `objects/XX/SHA256.json` (two-character hash-prefix shards). Each object has `{version:1,kind,value}`; kind is `request`, `collections` or `environments`. Collection item records have a `value` envelope and optional `requestRef`, so arbitrary source keys remain opaque. A collection object's ordered nested items preserve item IDs and folder context. The root manifest is `{version:1,collections:[hash,...],environments:[hash,...]}`. Resource revisions hash reconstructed canonical resources; the aggregate revision hashes the manifest bytes.

A changed request produces one new request object, one new collection skeleton and one manifest replacement. Other request/environment objects are reused. Hash filenames intentionally trade path stability for a single recoverable commit point; review tools should show manifest/skeleton changes with the newly added request document. Old objects and legacy files are retained; none become a live mirror.

## Demonstrated consequences

Disposable public repository tests inject failures while retaining the backup, staging an object, replacing the manifest and immediately after manifest replacement. Restart observes the old complete snapshot before the commit and the new complete snapshot after it. A separate request-edit test asserts exactly two new object files and verifies unchanged request reuse plus ID/opaque-field retention after restart. Studio's cross-collection move uses one manifest publication and both collection revisions.

Valid external manifest changes reconcile; hash-mismatched objects fail closed and remain available for repair. No transparent in-place editing of immutable files is promised. Objects have explicit byte/resource/directory quotas and no automatic GC. A future reviewed GC can remove only unreachable objects after retention/recovery policy is defined. This decision does not authorize migration of live development data.

The implementation fsyncs each object and its directory before publishing/fsyncing the manifest. Power-loss guarantees remain filesystem/OS dependent; current evidence uses process/fault simulation. Unsupported platform directory-fsync behavior must fail visibly rather than silently claim durability.

## Disposable size/startup observation

On this session's macOS host, Node v24.14.0, a temporary 100-request collection with small GET requests occupied 19,130 bytes in the legacy layout and 67,881 bytes after migration including retained originals/backup. Thirty sequential warm-cache readonly constructor + snapshot + close iterations measured median/p95 1.03/1.74 ms legacy and 14.56/18.10 ms manifest. This is a local smoke measurement, not a cross-platform benchmark or release budget claim. The overhead reflects integrity validation of separate documents and retention; no startup improvement is claimed. The fixture used generated item/request IDs, `https://example.test/INDEX` URLs, no remote network requests, and deleted its temporary workspace afterward.

The object store is sharded so the 2048-entry per-directory protection does not reduce the supported request count. The 1000-document limit applies to collection/environment resources, while request references are bounded by aggregate bytes and the 10,000-node per-collection limit. A disposable 10,004-request migration/restart fixture verifies this distinction. Hydration enforces wrapper shape, depth24 and nodes10,000 before recursive traversal of untrusted trees.
