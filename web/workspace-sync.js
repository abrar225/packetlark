import { isSensitiveField } from "../src/core/security/SensitiveFields.ts";
const key = (item) => `${item.kind}:${item.id}`;

export class WorkspaceSync {
  constructor(options) {
    this.options = options;
    this.epoch = 0;
    this.conflicts = [];
    document.getElementById("btn-check-workspace").onclick = () =>
      this.refresh();
    document.getElementById("btn-review-workspace").onclick = () =>
      this.review();
  }

  static merge(remote, local, retain) {
    const current = new Map(local.map((item) => [item.id, item]));
    const seen = new Set(remote.map((item) => item.id));
    return remote
      .map((item) => (retain(item.id) ? current.get(item.id) || item : item))
      .concat(local.filter((item) => !seen.has(item.id) && retain(item.id)));
  }

  touch() {
    this.epoch++;
    this.etag = null;
  }

  refresh() {
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    document.getElementById("btn-check-workspace").disabled = true;
    this.pending = Promise.resolve().then(async () => {
      try {
        const response = await fetch("/api/workspace", {
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
          headers: this.etag ? { "If-None-Match": this.etag } : {},
        });
        if (epoch !== this.epoch) return false;
        if (response.status === 304) {
          this.error = null;
          return true;
        }
        const remote = await response.json();
        if (!response.ok)
          throw new Error(remote.error?.message || "Workspace refresh failed");
        if (epoch !== this.epoch) return false;
        this.options.syncFields();
        const local = this.options.model();
        const conflicts = [];
        const next = {};
        for (const kind of ["collections", "environments"]) {
          const disk = new Map(remote[kind].map((item) => [item.id, item]));
          const dirty =
            kind === "collections"
              ? (id) =>
                  local.drafts.some(
                    (draft) =>
                      draft.collectionId === id &&
                      (draft.dirty || draft.saving),
                  )
              : (id) => local.dirtyEnvironments.has(id);
          const busy = (id) =>
            (kind === "collections"
              ? local.collectionSaves
              : local.environmentSaves
            ).has(id);
          for (const item of local[kind]) {
            const latest = disk.get(item.id);
            const changed =
              !latest ||
              (kind === "collections"
                ? local.drafts.some(
                    (draft) =>
                      draft.collectionId === item.id &&
                      draft.dirty &&
                      draft.collectionRevision !== latest.revision,
                  )
                : item.revision !== latest.revision);
            if (dirty(item.id) && !busy(item.id) && changed)
              conflicts.push({
                kind,
                id: item.id,
                local: item,
                remote: latest,
              });
          }
          next[kind] = WorkspaceSync.merge(
            remote[kind],
            local[kind],
            (id) => dirty(id) || busy(id),
          );
        }
        this.remote = remote;
        this.etag = response.headers.get("etag");
        this.conflicts = conflicts;
        this.error = null;
        this.options.apply(next);
        return true;
      } catch (error) {
        this.error = error.message;
        return false;
      } finally {
        this.pending = null;
        document.getElementById("btn-check-workspace").disabled = false;
        this.renderStatus();
      }
    });
    return this.pending;
  }

  renderStatus() {
    document.getElementById("workspace-sync-message").textContent = this.error
      ? `Disk refresh paused: ${this.error}`
      : this.conflicts.length
        ? `${this.conflicts.length} disk change(s) need review. Unsaved drafts are retained.`
        : "Local files checked";
    document.getElementById("btn-review-workspace").hidden =
      !this.conflicts.length;
  }

  review(selected = this.conflicts[0]) {
    if (!selected || this.resolving) return;
    this.options.syncFields();
    document.getElementById("modal-title").textContent =
      "Review workspace changes";
    const body = document.getElementById("modal-body");
    body.replaceChildren();
    const choose = document.createElement("select");
    choose.setAttribute("aria-label", "Conflicting resource");
    for (const item of this.conflicts) {
      const option = document.createElement("option");
      option.value = key(item);
      option.textContent = `${item.kind}: ${item.local.name}`;
      option.selected = key(item) === key(selected);
      choose.append(option);
    }
    choose.onchange = () =>
      this.review(this.conflicts.find((item) => key(item) === choose.value));
    body.append(choose);
    const note = document.createElement("p");
    note.textContent =
      "Review disk scripts, authentication and variables before keeping drafts with the new context. Previews show up to 64 KiB and mask common credential fields; inspect the local files for larger content.";
    body.append(note);
    const previews = document.createElement("div");
    previews.className = "workspace-previews";
    for (const [title, value] of [
      ["Local drafts", this.options.preview(selected)],
      ["Disk version", selected.remote],
    ]) {
      const section = document.createElement("section"),
        heading = document.createElement("h3"),
        pre = document.createElement("pre");
      heading.textContent = title;
      const text = value
        ? JSON.stringify(
            value,
            function (field, val) {
              if (isSensitiveField(field) && typeof val !== "boolean")
                return "[hidden]";
              if (
                field === "value" &&
                (this.secret ||
                  this.type === "secret" ||
                  isSensitiveField(this.key || ""))
              )
                return "[hidden]";
              return val;
            },
            2,
          )
        : "Deleted from disk";
      pre.textContent =
        text.slice(0, 65536) +
        (text.length > 65536 ? "\n[Preview truncated]" : "");
      section.append(heading, pre);
      previews.append(section);
    }
    body.append(previews);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    body.append(status);
    const actions = document.createElement("div");
    actions.className = "workspace-review-actions";
    body.append(actions);
    for (const [label, action, enabled] of [
      ["Load disk and discard local drafts", "discard", true],
      [
        selected.kind === "collections"
          ? "Keep drafts with disk context"
          : "Replace disk with local environment",
        "rebase",
        !!selected.remote && this.options.canRebase(selected),
      ],
      [
        selected.kind === "collections"
          ? "Save recovered collection copy"
          : "Save recovered environment copy",
        "copy",
        true,
      ],
    ]) {
      const button = document.createElement("button");
      button.className = "nav-btn";
      button.textContent = label;
      button.setAttribute("aria-label", label);
      button.disabled = !enabled;
      button.dataset.allowed = String(enabled);
      button.onclick = async () => {
        this.resolving = true;
        choose.disabled = true;
        const close = document.querySelector('[aria-label="Close dialog"]');
        if (close) close.disabled = true;
        status.textContent =
          "Resolving this change. The editor will reopen when the request settles.";
        for (const btn of actions.querySelectorAll("button"))
          btn.disabled = true;
        try {
          if (!(await this.refresh()))
            throw new Error(
              "Check the disk refresh status before resolving this change.",
            );
          const current = this.conflicts.find(
            (item) => key(item) === key(selected),
          );
          if (
            !current ||
            current.remote?.revision !== selected.remote?.revision
          )
            throw new Error(
              "Disk changed again. Close and reopen review to inspect the current version.",
            );
          if (
            action === "discard" &&
            !confirm(
              "Discard this resource's unsaved drafts and load the disk version?",
            )
          )
            return;
          await this.options.resolve(current, action);
          this.touch();
          this.resolving = false;
          this.options.closeModal();
          await this.refresh();
        } catch (error) {
          status.textContent = error.message;
        } finally {
          this.resolving = false;
          choose.disabled = false;
          if (close) close.disabled = false;
          for (const btn of actions.querySelectorAll("button"))
            btn.disabled = btn.dataset.allowed !== "true";
        }
      };
      actions.append(button);
    }
    if (document.getElementById("modal-backdrop").style.display !== "flex")
      this.options.openModal();
    choose.focus();
  }
}
