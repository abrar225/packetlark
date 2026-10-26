import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface Owner {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}
const lockName = ".writer-lock";
const tokenPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const leaseError = (code: string, message: string) =>
  Object.assign(new Error(message), { code, statusCode: 503 });
const identity = (file: string) => {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw leaseError(
      "ERR_WORKSPACE_LEASE_INVALID",
      "Invalid workspace lease directory.",
    );
  return `${stat.dev}:${stat.ino}`;
};

/** Local cooperating-process ownership. No expiry, heartbeat or automatic stealing. */
export class WorkspaceLease {
  private released = false;
  private rootIdentity: string;
  private lockIdentity: string;
  private constructor(
    public readonly root: string,
    private owner: Owner,
  ) {
    this.rootIdentity = identity(root);
    this.lockIdentity = identity(path.join(root, lockName));
  }

  static inspect(workspace: string) {
    let root: string;
    try {
      identity(workspace);
      root = fs.realpathSync(workspace);
    } catch (error: any) {
      if (error.code === "ENOENT")
        return { state: "unlocked" as const, recoverable: false };
      throw error;
    }
    const lock = path.join(root, lockName);
    try {
      fs.lstatSync(lock);
    } catch (error: any) {
      if (error.code === "ENOENT")
        return { state: "unlocked" as const, recoverable: false };
      throw error;
    }
    const owner = WorkspaceLease.readOwner(lock);
    let reason = "foreign-host";
    if (owner.hostname === os.hostname()) {
      try {
        process.kill(owner.pid, 0);
        reason = "owner-running";
      } catch (error: any) {
        reason = error.code === "ESRCH" ? "owner-exited" : "owner-unknown";
      }
    }
    return {
      state: "locked" as const,
      owner,
      recoverable: reason === "owner-exited",
      reason,
    };
  }

  static recover(workspace: string, expectedToken: string) {
    if (typeof expectedToken !== "string" || !tokenPattern.test(expectedToken))
      throw leaseError(
        "ERR_WORKSPACE_LEASE_TOKEN",
        "Recovery requires --token from workspace status. Review that owner before continuing.",
      );
    identity(workspace);
    const root = fs.realpathSync(workspace),
      rootIdentity = identity(root);
    const status = WorkspaceLease.inspect(root);
    if (status.state !== "locked" || status.owner.token !== expectedToken)
      throw leaseError(
        "ERR_WORKSPACE_LEASE_CHANGED",
        "Workspace ownership changed. Inspect workspace status again.",
      );
    if (!status.recoverable)
      throw leaseError(
        "ERR_WORKSPACE_LEASE_ACTIVE",
        "Recovery refused: the owner is running, belongs to another host, or its exit cannot be verified.",
      );
    if (
      fs
        .readdirSync(root)
        .filter((name) => name.startsWith(".writer-recovered-")).length >= 128
    )
      throw leaseError(
        "ERR_WORKSPACE_LEASE_RETENTION",
        "Recovery journal limit reached. Stop all PacketLark processes and archive recovered-lock directories offline.",
      );
    const lock = path.join(root, lockName);
    const tombstone = path.join(root, `.writer-recovered-${expectedToken}`);
    if (
      identity(root) !== rootIdentity ||
      WorkspaceLease.readOwner(lock).token !== expectedToken ||
      fs.existsSync(tombstone)
    )
      throw leaseError(
        "ERR_WORKSPACE_LEASE_CHANGED",
        "Workspace ownership changed. Inspect workspace status again.",
      );
    try {
      // Keep this nonempty target: a delayed same-token recovery cannot rename a new lease over it.
      fs.renameSync(lock, tombstone);
    } catch {
      throw leaseError(
        "ERR_WORKSPACE_LEASE_CHANGED",
        "Workspace recovery could not commit. Inspect workspace status again; no automatic retry was made.",
      );
    }
    return { state: "recovered", token: expectedToken };
  }

  static acquire(workspace: string): WorkspaceLease {
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    identity(workspace); // Reject a linked selected root before resolving aliases.
    const root = fs.realpathSync(workspace);
    const owner: Owner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    };
    const lock = path.join(root, lockName);
    const pending = path.join(root, `.writer-pending-${owner.token}`);
    const occupied = () => {
      const current = WorkspaceLease.readOwner(lock);
      throw leaseError(
        "ERR_WORKSPACE_LOCKED",
        `Workspace is owned by process ${current.pid}. Stop its Studio first; after a crash run packetlark workspace recover --workspace <directory>.`,
      );
    };
    if (fs.existsSync(lock)) occupied();
    fs.mkdirSync(pending, { mode: 0o700 });
    try {
      const file = fs.openSync(path.join(pending, "owner.json"), "wx", 0o600);
      try {
        fs.writeFileSync(file, JSON.stringify(owner) + "\n");
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      try {
        // Publish a complete nonempty directory. An existing nonempty owner wins.
        fs.renameSync(pending, lock);
      } catch (error) {
        if (fs.existsSync(lock)) occupied();
        throw error;
      }
      return new WorkspaceLease(root, owner);
    } finally {
      // Only this attempt's unpublished staging directory is disposable.
      fs.rmSync(pending, { recursive: true, force: true });
    }
  }

  private static readOwner(lock: string): Owner {
    try {
      identity(lock);
      const ownerFile = path.join(lock, "owner.json");
      if (!fs.lstatSync(ownerFile).isFile()) throw new Error();
      const descriptor = fs.openSync(
        ownerFile,
        fs.constants.O_RDONLY |
          (fs.constants.O_NOFOLLOW || 0) |
          (fs.constants.O_NONBLOCK || 0),
      );
      let data: string;
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > 4096) throw new Error();
        const bytes = Buffer.alloc(4097);
        let size = 0;
        while (size < bytes.length) {
          const count = fs.readSync(
            descriptor,
            bytes,
            size,
            bytes.length - size,
            null,
          );
          if (!count) break;
          size += count;
        }
        if (size > 4096) throw new Error();
        data = bytes.subarray(0, size).toString("utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      const owner = JSON.parse(data);
      if (
        owner.version !== 1 ||
        typeof owner.token !== "string" ||
        !tokenPattern.test(owner.token) ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1 ||
        typeof owner.hostname !== "string" ||
        owner.hostname.length > 255 ||
        typeof owner.createdAt !== "string"
      )
        throw new Error();
      return {
        version: 1,
        token: owner.token,
        pid: owner.pid,
        hostname: owner.hostname,
        createdAt: owner.createdAt,
      };
    } catch {
      throw leaseError(
        "ERR_WORKSPACE_LEASE_INVALID",
        "Invalid workspace lease. Preserve its files and repair the lease offline; it was not removed.",
      );
    }
  }

  assertOwned() {
    try {
      if (
        !this.released &&
        identity(this.root) === this.rootIdentity &&
        identity(path.join(this.root, lockName)) === this.lockIdentity &&
        WorkspaceLease.readOwner(path.join(this.root, lockName)).token ===
          this.owner.token
      )
        return;
    } catch {}
    throw leaseError(
      "ERR_WORKSPACE_LEASE_LOST",
      "Workspace ownership was lost. Stop this Studio before reopening the workspace.",
    );
  }

  release() {
    if (this.released) return;
    this.assertOwned();
    const lock = path.join(this.root, lockName);
    const retired = path.join(
      this.root,
      `.writer-released-${this.owner.token}`,
    );
    fs.renameSync(lock, retired);
    this.released = true;
    // A cleanup failure leaves a non-owning artifact, never an empty active lock.
    try {
      fs.rmSync(retired, { recursive: true, force: true });
    } catch {}
  }
}
