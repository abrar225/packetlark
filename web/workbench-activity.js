import { WorkbenchState, sanitizeExample } from "../src/core/workspace/WorkbenchState.ts";
export { WorkbenchState, sanitizeExample };
const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };

export class WorkbenchActivity {
  constructor(options) { this.options = options; this.workspace = options.workspace; }
  async init() {
    try {
      if (!this.workspace) throw new Error("Workspace identity unavailable");
      this.database = await new Promise((resolve, reject) => {
        let expired = false;
        const timer = setTimeout(() => { expired = true; reject(new Error("Example storage did not open within 3 seconds")); }, 3000);
        const request = indexedDB.open("packetlark-reviewed-examples-v1", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("examples", { keyPath: "id" }).createIndex("workspace", "workspace");
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
        request.onblocked = () => { clearTimeout(timer); expired = true; reject(new Error("Example storage upgrade blocked")); };
        request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
      });
      this.database.onversionchange = () => this.database.close();
    } catch (error) { this.error = error.message; }
  }
  transaction(mode, work) {
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction("examples", mode); let result;
      tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error || new Error("Example storage failed"));
      try { work(tx.objectStore("examples"), (value) => { result = value; }, tx); } catch (error) { tx.abort(); reject(error); }
    });
  }
  all() { return this.transaction("readonly", (store, result) => { const req = store.index("workspace").getAll(IDBKeyRange.only(this.workspace)); req.onsuccess = () => result(req.result); }); }
  async saveExample() {
    const entry = this.options.current();
    if (!entry) { alert("Send a request or select a history result before saving an example."); return; }
    const example = sanitizeExample(entry.request, entry.response, entry.variables);
    if (size(example) > 256 * 1024) { alert("Example exceeds the 256 KiB review limit. Reduce the response before saving."); return; }
    this.show("Review response example", example, async () => {
      if (!this.database) throw new Error(this.error || "Example storage unavailable");
      if (!confirm("Save this reviewed example in local browser storage? Review the preview for unknown secrets. No request will be sent.")) return false;
      const record = { id: crypto.randomUUID(), workspace: this.workspace, savedAt: new Date().toISOString(), ...example };
      let failure;
      await this.transaction("readwrite", (store, _, tx) => {
        const req = store.index("workspace").getAll(IDBKeyRange.only(this.workspace));
        req.onsuccess = () => {
          if (req.result.length >= 20 || req.result.reduce((n, item) => n + size(item), size(record)) > 4 * 1024 * 1024) {
            failure = new Error("Example retention limit reached (20 examples / 4 MiB). Delete an older example first."); tx.abort();
          } else store.put(record);
        };
      }).catch((error) => { throw failure || error; });
      return true;
    });
  }
  show(title, entry, save) {
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-footer").replaceChildren();
    const body = document.getElementById("modal-body"); body.replaceChildren();
    body.append(node("p", "Review before saving or sending. Examples omit scripts, authentication, unknown headers and unstructured/binary bodies; unknown secrets still require review."));
    const preview = node("pre", JSON.stringify(entry, null, 2).slice(0, 262144)); preview.style.whiteSpace = "pre-wrap"; body.append(preview);
    const button = node("button", save ? "Save reviewed example" : "Open request copy (unsaved)"); button.className = "nav-btn";
    const status = node("p"); status.setAttribute("role", "status"); body.append(button, status);
    const ownsDialog = () => body.contains(preview) && document.getElementById("modal-backdrop").style.display === "flex";
    button.onclick = async () => {
      button.disabled = true;
      try {
        if (save) { if (await save() && ownsDialog()) this.options.closeModal(); }
        else { this.options.reopen(entry); if (ownsDialog()) this.options.closeModal(); }
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
    this.options.openModal();
  }
  async open() {
    document.getElementById("modal-title").textContent = "Request history and examples";
    document.getElementById("modal-footer").replaceChildren();
    const body = document.getElementById("modal-body"); body.replaceChildren();
    const owner = node("p", "History is held in this page only: up to 50 sanitized requests / 4 MiB; old entries are evicted. Reopening creates an unsaved copy and never sends automatically. Reviewed examples persist in this browser/workspace, up to 20 / 4 MiB.");
    body.append(owner);
    const ownsDialog = () => body.contains(owner) && document.getElementById("modal-backdrop").style.display === "flex";
    const list = (title, entries, persisted) => {
      body.append(node("h3", title));
      for (const entry of entries) {
        const row = node("div"), open = node("button", `${entry.request.method} ${entry.request.name || entry.request.url} · ${entry.response.status}`);
        open.className = "nav-btn"; open.onclick = () => this.show("Inspect saved request", entry); row.append(open);
        if (persisted) { const remove = node("button", "Delete example"); remove.className = "nav-btn"; remove.onclick = async () => { if (!confirm("Delete this saved example?")) return; remove.disabled = true; try { await this.transaction("readwrite", (store) => store.delete(entry.id)); if (ownsDialog()) await this.open(); } catch (error) { if (ownsDialog()) alert(error.message); } finally { remove.disabled = false; } }; row.append(remove); }
        body.append(row);
      }
    };
    list("This page's history", this.options.state.history, false);
    const clear = node("button", "Clear page history"); clear.className = "nav-btn"; clear.onclick = () => { this.options.state.history.length = 0; this.open(); }; body.append(clear);
    this.options.openModal();
    try {
      if (this.database) { const entries = await this.all(); if (ownsDialog()) list("Reviewed examples", entries, true); }
      else body.append(node("p", this.error || "Example storage unavailable"));
    } catch (error) { if (ownsDialog()) body.append(node("p", error.message)); }
  }
}
