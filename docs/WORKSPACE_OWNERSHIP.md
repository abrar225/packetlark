# Local workspace ownership

One Studio owns a workspace's managed writes at a time. Ownership is acquired before migration or sample creation. A second Studio exits with a clear owner-process diagnostic. Multiple browser tabs may connect to the same Studio; the CLI/MCP read-only collection workflows do not become additional workspace writers.

This is a cooperating-process protocol for a local filesystem and one host/PID namespace. External editors do not obey this lock; content revisions still detect their edits. It is not a distributed lock, authenticated local-client boundary, malicious same-user race defense, or power-loss durability certification. Network filesystems and container-shared PID namespaces are outside this increment's supported lock contract.

## Inspect and recover

Use the project directory, exactly as for `rea-api studio --workspace`; Rea manages its `.rea-api` child directory:

```sh
rea-api workspace status --workspace /path/to/project
```

Status is read-only. It reports whether a lock exists, its PID/hostname/creation time/token, and whether that same-host process is known to have exited. It does not create a missing workspace, execute scripts or remove metadata.

After reviewing the status, an exited owner can be recovered explicitly:

```sh
rea-api workspace recover --workspace /path/to/project --token TOKEN_FROM_STATUS
rea-api studio --workspace /path/to/project
```

Recovery requires the exact reviewed token and a same-host PID existence check that reports the owner absent. A running, paused, permission-denied, unknown or foreign-host owner is refused. There is no time expiry and no force flag. PID reuse can conservatively refuse a stale lock; hostname changes can also require offline repair. Do not kill an unrelated process to make recovery pass.

Malformed or linked owner metadata is preserved and reported, not automatically deleted. For offline repair, stop all Rea instances and recovery commands, preserve the metadata and back up the workspace before investigating. Ordinary process crashes are covered by the token recovery command; arbitrary damaged filesystems require separate diagnosis.

## Publication, release and recovery

An owner record is written with exclusive 0600 creation and file fsync inside a private staging directory. Renaming the complete nonempty directory to `.writer-lock` publishes it; an existing nonempty owner cannot be replaced by that rename. The local directory identity and token are checked before managed filesystem work.

Startup and shutdown share explicit lifecycle promises. Concurrent starts share one listener, shutdown prevents reopening that instance, and failed startup closes listeners before releasing ownership. Signal handlers are installed before initialization/readiness output; the legacy development entry uses the same lifecycle. A stopped instance must be replaced with a new `StudioServer` to reopen it.

Release atomically renames the owned directory to `.writer-released-TOKEN` before cleanup. Interrupted cleanup leaves a non-owning artifact rather than an empty active lock. Unpublished `.writer-pending-TOKEN` artifacts also do not own the workspace. Their cleanup may require offline maintenance after unusual crashes or filesystem failures.

Explicit recovery renames the exited owner's directory to the **fixed**, nonempty `.writer-recovered-TOKEN` path. That directory is retained: a delayed recovery for the same token cannot rename a newly acquired owner's directory over the existing nonempty target. Never edit or remove these recovery directories while Rea instances or recovery commands may still reference the workspace. Recovery refuses at 128 retained recovery directories; archive them only during offline maintenance with all those processes stopped.

The rename design relies on the documented nonempty-directory exclusion and atomic rename semantics in [POSIX rename](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html). Process existence uses the documented zero-signal behavior of [Node's process.kill](https://nodejs.org/docs/latest-v22.x/api/process.html#processkillpid-signal), with every result other than a known absent process treated conservatively. These references do not establish Windows or network-filesystem execution results; supported-OS validation remains a P5 gate.

## Evidence and remaining work

Thirteen public workspace/real CLI cases cover competing writers, shutdown/startup interleavings, port exhaustion, startup failure, interrupted cleanup, live/exited/foreign owners, malformed metadata, reviewed-token recovery, saved-data preservation, lost ownership and a deliberately delayed recovery racing a new owner. The delayed-recovery regression also failed when its fixed destination was temporarily replaced with a unique destination, proving sensitivity to the reproduced race; the production source was restored afterward.

The full local suite passed 137 tests in 18 files. Package/extension/compatibility checks and CI results are recorded with the implementation increment. No browser renderer code changes in this increment; its prior browser measurements remain pinned to their earlier source.

P1 is still open for external-file reconciliation/conflict review, full collection authoring, tabs/history, durable drafts and versioned storage migration/backup/restore. This lock does not complete those features or the P2–P10 roadmap.
