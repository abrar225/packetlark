const DATABASE = "packetlark-draft-recovery-v1";
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
const MAX_SESSIONS = 16;
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

// Each page owns a different record. Restoring a record never runs scripts or
// writes canonical resources, and never overwrites a different page's record.
export class DraftRecovery {
  constructor(options) {
    this.options = options;
    this.session = crypto.randomUUID();
    this.generation = 0;
    this.tail = Promise.resolve();
    this.records = [];
    document.getElementById("btn-draft-recovery").onclick = () => this.review();
  }

  async init() {
    try {
      const response = await fetch("/api/workspace/identity", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Workspace identity unavailable");
      this.workspace = (await response.json()).id;
      this.database = await new Promise((resolve, reject) => {
        let expired = false;
        const timer = setTimeout(() => { expired = true; reject(new Error("Draft storage did not open within 3 seconds")); }, 3000);
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "id" }).createIndex("workspace", "workspace");
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
        request.onblocked = () => { clearTimeout(timer); expired = true; reject(new Error("Draft storage upgrade blocked by another page")); };
        request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
      });
      this.database.onversionchange = () => { this.database.close(); this.fail(new Error("Draft storage changed; reload this page")); };
      const records = await this.all();
      this.enabled = records.some((record) => record.id === this.settingKey && record.enabled);
      await this.refresh();
      this.status(this.enabled ? "Draft recovery enabled" : "Draft recovery off");
    } catch (error) { this.fail(error); }
  }

  get settingKey() { return `${this.workspace}:settings`; }
  get recordKey() { return `${this.workspace}:${this.session}`; }

  transaction(mode, work) {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction("records", mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("Draft storage transaction failed"));
      try { work(transaction.objectStore("records"), (value) => { result = value; }, transaction); }
      catch (error) { transaction.abort(); reject(error); }
    });
  }

  all() {
    return this.transaction("readonly", (store, result) => {
      const request = store.index("workspace").getAll(IDBKeyRange.only(this.workspace));
      request.onsuccess = () => result(request.result);
    });
  }

  status(message) {
    document.getElementById("draft-recovery-status").textContent = message;
  }

  fail(error) {
    this.error = error.message;
    this.status(`Draft recovery unavailable: ${error.message}. Keep this page open or save your changes.`);
  }

  async refresh() {
    this.records = (await this.all()).filter((record) => record.workspace === this.workspace && record.snapshot);
    document.getElementById("btn-draft-recovery").textContent = `Draft recovery${this.records.length ? ` (${this.records.length})` : ""}`;
  }

  changed() {
    if (!this.enabled || !this.database) return;
    this.generation++;
    this.status("Draft recovery pending…");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    clearTimeout(this.timer);
    const generation = this.generation;
    let snapshot;
    try { snapshot = structuredClone(this.options.snapshot()); }
    catch (error) { this.fail(error); return Promise.resolve(false); }
    const task = async () => {
      try {
        if (!this.enabled) return false;
        const size = bytes(snapshot);
        if (size > MAX_SNAPSHOT_BYTES) throw new Error("Recovery exceeds 8 MiB per page");
        const empty = !snapshot.drafts.length && !snapshot.environments.length;
        let failure;
        await this.transaction("readwrite", (store, _, transaction) => {
          const request = store.index("workspace").getAll(IDBKeyRange.only(this.workspace));
          request.onsuccess = () => {
            const records = request.result;
            // Disabling from another page prevents delayed writes re-enabling it.
            if (!records.some((record) => record.id === this.settingKey && record.enabled)) {
              this.enabled = false;
              return;
            }
            const others = records.filter((record) => record.workspace === this.workspace && record.snapshot && record.id !== this.recordKey);
            if (!empty && (others.length >= MAX_SESSIONS || others.reduce((sum, record) => sum + bytes(record.snapshot), size) > MAX_WORKSPACE_BYTES)) {
              failure = new Error("Recovery limit reached (16 pages / 32 MiB per workspace); explicitly discard older recoveries");
              transaction.abort();
              return;
            }
            if (empty) store.delete(this.recordKey);
            else store.put({ id: this.recordKey, workspace: this.workspace, session: this.session, savedAt: new Date().toISOString(), snapshot });
          };
        }).catch((error) => { throw failure || error; });
        this.error = null;
        if (generation === this.generation) this.status(this.enabled ? (empty ? "No unsaved drafts to recover" : "Draft recovery saved locally") : "Draft recovery off");
        await this.refresh();
        return true;
      } catch (error) { this.fail(error); return false; }
    };
    this.tail = this.tail.catch(() => {}).then(task);
    return this.tail;
  }

  async setEnabled(enabled) {
    if (!this.database) throw new Error(this.error || "Draft storage unavailable");
    await this.tail;
    await this.transaction("readwrite", (store) => store.put({ id: this.settingKey, workspace: this.workspace, enabled }));
    this.enabled = enabled;
    if (enabled) { this.generation++; await this.flush(); }
    else this.status("Draft recovery off. Existing recovery records remain until explicitly discarded.");
  }

  async review() {
    try { await this.renderReview(); }
    catch (error) { this.fail(error); }
  }

  async renderReview() {
    if (!this.database) { alert(this.error || "Draft storage unavailable"); return; }
    await this.refresh();
    document.getElementById("modal-title").textContent = "Local draft recovery";
    document.getElementById("modal-footer").replaceChildren();
    const body = document.getElementById("modal-body");
    body.replaceChildren();
    const note = document.createElement("p");
    note.textContent = "Optional recovery stores unsaved requests, inherited collection context and failed environment edits in this browser on this machine. It can include credentials in plaintext. It is separate from canonical workspace files and exports; clearing browser site data removes it. Review recovered scripts and authentication before saving or sending. Recovery is scoped to this workspace and browser origin.";
    body.append(note);
    const toggle = document.createElement("button");
    toggle.className = "nav-btn";
    toggle.textContent = this.enabled ? "Disable draft recovery" : "Enable local draft recovery";
    toggle.onclick = async () => {
      if (!this.enabled && !confirm("Store unsaved request and environment contents, including possible credentials, in this browser's local draft recovery?")) return;
      toggle.disabled = true;
      try { await this.setEnabled(!this.enabled); await this.review(); }
      catch (error) { this.fail(error); toggle.disabled = false; }
    };
    body.append(toggle);
    for (const record of this.records.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))) {
      const section = document.createElement("section");
      section.dataset.recoveryId = record.id;
      const title = document.createElement("p");
      title.textContent = `${new Date(record.savedAt).toLocaleString()} · ${record.snapshot.drafts?.length || 0} request draft(s), ${record.snapshot.environments?.length || 0} environment edit(s)${record.session === this.session ? " · this page" : ""}`;
      const names = document.createElement("p");
      const collections = Array.isArray(record.snapshot.collections) ? record.snapshot.collections : [];
      const environments = Array.isArray(record.snapshot.environments) ? record.snapshot.environments : [];
      names.textContent = collections.slice(0, 5).map((collection) => collection?.name).concat(environments.slice(0, 5).map((environment) => environment?.name)).join(" · ");
      section.append(title);
      section.append(names);
      const restore = document.createElement("button");
      restore.className = "nav-btn";
      restore.textContent = "Review and restore drafts";
      restore.disabled = record.session === this.session;
      restore.onclick = async () => {
        try {
          await this.options.restore(structuredClone(record.snapshot));
          this.changed();
          this.options.closeModal();
        } catch (error) { alert(`Recovery was not applied: ${error.message}`); }
      };
      const discard = document.createElement("button");
      discard.className = "nav-btn";
      discard.textContent = "Discard recovery record";
      discard.onclick = async () => {
        if (!confirm("Delete this stored recovery record? Live unsaved edits remain in their page; an active page can create another recovery.")) return;
        try {
          await this.transaction("readwrite", (store) => store.delete(record.id));
          await this.review();
        } catch (error) { this.fail(error); }
      };
      section.append(restore, discard);
      body.append(section);
    }
    this.options.openModal();
  }
}
