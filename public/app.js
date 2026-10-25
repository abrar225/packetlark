let requestAbortController = null;
function refreshIcons() {
  document.querySelectorAll("input,textarea,select").forEach((field) => {
    if (field.hasAttribute("aria-label") || field.labels?.length) return;
    const row = field.closest("tr");
    const heading = row
      ?.closest("table")
      ?.querySelectorAll("th")
      [field.closest("td")?.cellIndex]?.textContent.trim();
    field.setAttribute(
      "aria-label",
      field.type === "checkbox"
        ? "Enable row"
        : heading ||
            field.placeholder ||
            document.getElementById("modal-title")?.textContent ||
            "Value",
    );
  });
  document.querySelectorAll("button.icon-btn").forEach((button) => {
    if (!button.hasAttribute("aria-label"))
      button.setAttribute(
        "aria-label",
        button.title ||
          (button.closest(".modal-header")
            ? "Close dialog"
            : button.textContent.trim() === "✕"
              ? "Remove row"
              : "Action"),
      );
  });
  if (
    typeof lucide !== "undefined" &&
    typeof lucide.createIcons === "function"
  ) {
    lucide.createIcons();
  }
}

/* ==========================================================================
       ReaAPI Studio Core Interactive State & Runtime
       ========================================================================== */
let collections = [];
let environments = [];
let activeEnvironmentId = "";
let activeCollection = null;
let activeRequest = null;
let activeReqTab = "params";
let activeResTab = "body";
let currentResponseData = null;
let isDirty = false;

async function init() {
  refreshIcons();

  await loadEnvironments();
  await loadCollections();
  await updateHealth();

  setInterval(pollSnifferTraffic, 2000);
  setInterval(updateHealth, 10000);

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    if (document.getElementById("modal-backdrop").style.display === "flex")
      return;
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      sendActiveRequest();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      saveActiveRequest();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
      if (document.getElementById("studio-view").style.display !== "none") {
        e.preventDefault();
        toggleResponseSearch();
      }
    }
  });
}

async function updateHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    const healthEl = document.getElementById("health-info");
    healthEl.textContent = `Local server · ${data.memoryRssMb} MB RSS`;
    document.getElementById("connection-state").textContent =
      "Connected locally";
    document.getElementById("sniffer-address").textContent =
      `http://localhost:${data.snifferPort}`;
    healthEl.setAttribute("data-original-text", healthEl.textContent);
  } catch (e) {
    document.getElementById("connection-state").textContent =
      "Server unavailable";
  }
}

async function loadEnvironments() {
  try {
    const res = await fetch("/api/environments");
    environments = await res.json();
    renderEnvironmentSelector();
  } catch (e) {
    console.error("Failed to load environments:", e);
  }
}

function renderEnvironmentSelector() {
  const select = document.getElementById("env-select");
  select.innerHTML = '<option value="">No Environment</option>';
  for (const env of environments) {
    const opt = document.createElement("option");
    opt.value = env.id;
    opt.textContent = env.name;
    if (env.id === activeEnvironmentId) opt.selected = true;
    select.appendChild(opt);
  }
  const manageOpt = document.createElement("option");
  manageOpt.value = "__manage__";
  manageOpt.textContent = "Manage Environments...";
  select.appendChild(manageOpt);
}

function onEnvironmentSelected(val) {
  if (val === "__manage__") {
    openEnvironmentManager();
    renderEnvironmentSelector();
  } else {
    activeEnvironmentId = val;
  }
}

async function loadCollections() {
  try {
    const res = await fetch("/api/collections");
    collections = await res.json();
    renderCollectionsTree();
    if (
      !activeRequest &&
      collections.length > 0 &&
      collections[0].items.length > 0
    ) {
      const firstReqItem = findFirstRequestItem(collections[0].items);
      if (firstReqItem) {
        selectRequest(firstReqItem.request, collections[0]);
      }
    }
  } catch (err) {
    console.error(err);
  }
}

function findFirstRequestItem(items) {
  for (const item of items) {
    if (item.request) return item;
    if (item.isFolder && item.items) {
      const found = findFirstRequestItem(item.items);
      if (found) return found;
    }
  }
  return null;
}

function markDirty() {
  isDirty = true;
  document.getElementById("dirty-badge").style.display = "inline";
  document.getElementById("btn-save-req").classList.add("is-dirty");
  renderCollectionsTree();
}

function markClean() {
  isDirty = false;
  document.getElementById("dirty-badge").style.display = "none";
  document.getElementById("btn-save-req").classList.remove("is-dirty");
  renderCollectionsTree();
}

function renderCollectionsTree() {
  const tree = document.getElementById("collection-tree");
  tree.innerHTML = "";

  const query = document
    .getElementById("collection-search")
    .value.trim()
    .toLowerCase();
  const filterItems = (items) =>
    items.flatMap((item) =>
      item.isFolder
        ? [{ ...item, items: filterItems(item.items || []) }].filter(
            (x) => x.items.length,
          )
        : (item.name + " " + (item.request?.url || ""))
              .toLowerCase()
              .includes(query)
          ? [item]
          : [],
    );
  let foundCount = 0;
  collections.forEach((col) => {
    const visibleItems =
      query && !col.name.toLowerCase().includes(query)
        ? filterItems(col.items)
        : col.items;
    if (!visibleItems.length) return;
    foundCount += visibleItems.length;
    const colDiv = document.createElement("div");
    colDiv.className = "collection-node";

    const label = document.createElement("div");
    label.className = "collection-label";
    label.innerHTML = `<i data-lucide="folder"></i><span>${escapeHtml(col.name)}</span>`;
    colDiv.appendChild(label);

    renderTreeItems(visibleItems, colDiv, col, 0);
    tree.appendChild(colDiv);
  });
  if (!foundCount)
    tree.innerHTML = `<p class="empty-collection">${query ? "No matching requests. Try another search." : "Import a collection to get started."}</p>`;
  refreshIcons();
}

function renderTreeItems(items, parentEl, col, depth) {
  if (!Array.isArray(items)) return;

  items.forEach((item) => {
    if (item.isFolder) {
      const folderDiv = document.createElement("div");
      folderDiv.className = "tree-folder";
      folderDiv.style.marginLeft = `${depth > 0 ? 12 : 8}px`;

      const title = document.createElement("div");
      title.className = "tree-folder-title";
      title.innerHTML = `<i data-lucide="folder"></i> <span>${escapeHtml(item.name)}</span>`;
      const childrenDiv = document.createElement("div");

      title.onclick = () => {
        const isHidden = childrenDiv.style.display === "none";
        childrenDiv.style.display = isHidden ? "block" : "none";
        title.innerHTML = `${isHidden ? '<i data-lucide="folder"></i>' : '<i data-lucide="folder"></i>'} <span>${escapeHtml(item.name)}</span>`;
      };

      folderDiv.appendChild(title);
      renderTreeItems(item.items || [], childrenDiv, col, depth + 1);
      folderDiv.appendChild(childrenDiv);
      parentEl.appendChild(folderDiv);
    } else if (item.request) {
      const reqDiv = document.createElement("div");
      const isSelected = activeRequest?.id === item.request.id;
      reqDiv.className = `request-item ${isSelected ? "selected" : ""}`;
      if (depth > 0) reqDiv.style.paddingLeft = `${14 + depth * 8}px`;

      const mClass = `method-${item.request.method.toLowerCase()}`;
      const isCurrentDirty = isSelected && isDirty;

      reqDiv.innerHTML = `
            <button class="req-main-info" type="button">
              <span class="method-badge ${mClass}">${escapeHtml(item.request.method)}</span>
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.request.name || item.request.url)}</span>
              ${isCurrentDirty ? '<span class="dirty-dot">•</span>' : ""}
            </button>
            <button class="icon-btn" title="Delete Request" data-delete-request>✕</button>
          `;
      reqDiv.querySelector("[data-delete-request]").onclick = (event) => {
        event.stopPropagation();
        deleteRequest(item.request.id, col.id);
      };
      const selectButton = reqDiv.querySelector(".req-main-info");
      selectButton.setAttribute(
        "aria-label",
        `${item.request.method} ${item.request.name || item.request.url}`,
      );
      selectButton.onclick = () => selectRequest(item.request, col);
      parentEl.appendChild(reqDiv);
    }
  });
}

function selectRequest(req, col) {
  if (isDirty && activeRequest && activeCollection) {
    saveActiveRequest();
  } else {
    syncCurrentFieldsToActiveRequest();
  }
  activeRequest = JSON.parse(JSON.stringify(req));
  activeCollection = col;
  markClean();

  document.getElementById("req-method").value = activeRequest.method || "GET";
  document.getElementById("req-url").value = activeRequest.url || "";

  renderParamsTable();
  renderHeadersTable();
  renderBodyView();
  renderAuthView();

  document.getElementById("req-prerequest-script").value =
    activeRequest.preRequestScript || "";
  document.getElementById("req-timeout").value =
    activeRequest.timeoutMs || 30000;
  document.getElementById("req-redirects").checked =
    activeRequest.followRedirects !== false;
  document.getElementById("import-warning").textContent = (
    col.importWarnings || []
  ).length
    ? `${col.importWarnings.length} import warning(s). Review unsupported settings before running.`
    : "";
  document.getElementById("req-test-script").value =
    activeRequest.testScript || "";

  document.getElementById("request-name").textContent =
    activeRequest.name || "Untitled request";
  document.getElementById("collection-name").textContent = col.name;
  document.body.classList.remove("sidebar-open");
  renderCollectionsTree();
}

function syncCurrentFieldsToActiveRequest() {
  if (!activeRequest) return;
  activeRequest.method = document.getElementById("req-method").value;
  activeRequest.url = document.getElementById("req-url").value;
  if (
    activeRequest.body?.mode === "raw-json" ||
    activeRequest.body?.mode === "raw-text"
  ) {
    activeRequest.body.raw = document.getElementById("req-body-raw").value;
  }
  activeRequest.preRequestScript = document.getElementById(
    "req-prerequest-script",
  ).value;
  activeRequest.testScript = document.getElementById("req-test-script").value;
}

async function saveActiveRequest() {
  if (!activeRequest || !activeCollection) return;
  syncCurrentFieldsToActiveRequest();

  try {
    const res = await fetch(
      `/api/collections/${activeCollection.id}/requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: activeRequest }),
      },
    );
    const data = await res.json();
    if (!res.ok || !data.ok)
      throw new Error(data.error?.message || data.error || "Save failed");
    if (data.ok) {
      markClean();
      await loadCollections();
      const btn = document.getElementById("btn-save-req");
      const originalText = btn.innerHTML;
      btn.innerHTML = "Saved";
      setTimeout(() => {
        btn.innerHTML = originalText;
      }, 1200);
    }
  } catch (err) {
    alert("Failed to save request: " + err.message);
  }
}

async function createNewRequest() {
  if (!activeCollection && collections.length > 0) {
    activeCollection = collections[0];
  }
  if (!activeCollection) {
    alert("Please create or import a collection first.");
    return;
  }

  const reqName = prompt("Enter request name:", "New Request");
  if (!reqName) return;

  const newReq = {
    id: "req_" + Date.now(),
    name: reqName,
    method: "GET",
    url: "https://httpbin.org/get",
    headers: [],
    queryParams: [],
    body: { mode: "none" },
    auth: { type: "none" },
    testScript: `pm.test("Status code is 200", function () {\n    pm.response.to.have.status(200);\n});`,
  };

  try {
    const res = await fetch(
      `/api/collections/${activeCollection.id}/requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: newReq }),
      },
    );
    const data = await res.json();
    if (data.ok) {
      await loadCollections();
      selectRequest(newReq, activeCollection);
    }
  } catch (e) {
    alert("Failed to create request: " + e.message);
  }
}

async function deleteRequest(reqId, colId) {
  if (!confirm("Are you sure you want to delete this request?")) return;
  try {
    const res = await fetch(`/api/collections/${colId}/requests/${reqId}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (data.ok) {
      if (activeRequest?.id === reqId) {
        activeRequest = null;
      }
      await loadCollections();
    }
  } catch (e) {
    alert("Failed to delete request: " + e.message);
  }
}

async function exportPostman() {
  if (!activeCollection) {
    if (collections.length > 0) activeCollection = collections[0];
    else {
      alert("No collection available to export.");
      return;
    }
  }

  try {
    const res = await fetch(
      `/api/collections/${activeCollection.id}/export/postman`,
    );
    if (!res.ok) {
      throw new Error(`Export failed with status ${res.status}`);
    }
    const postmanData = await res.json();
    const blob = new Blob([JSON.stringify(postmanData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(activeCollection.name || "collection").replace(/[^a-zA-Z0-9_-]/g, "_")}.postman_collection.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Failed to export Postman collection: " + err.message);
  }
}

/* Params Table */
function renderParamsTable() {
  const tbody = document.getElementById("params-tbody");
  tbody.innerHTML = "";
  (activeRequest.queryParams || []).forEach((q, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
          <td><input type="checkbox" ${q.enabled !== false ? "checked" : ""} onchange="toggleParam(${idx})"></td>
          <td><input type="text" class="kv-input" value="${escapeHtml(q.key)}" oninput="updateParam(${idx}, 'key', this.value)" placeholder="Key"></td>
          <td><input type="text" class="kv-input" value="${escapeHtml(q.value)}" oninput="updateParam(${idx}, 'value', this.value)" placeholder="Value"></td>
          <td><button class="icon-btn" onclick="removeParam(${idx})">✕</button></td>
        `;
    tbody.appendChild(tr);
  });
  refreshIcons();
}

function addParamRow() {
  if (!activeRequest) return;
  if (!activeRequest.queryParams) activeRequest.queryParams = [];
  activeRequest.queryParams.push({ key: "", value: "", enabled: true });
  markDirty();
  renderParamsTable();
}

function updateParam(idx, field, val) {
  activeRequest.queryParams[idx][field] = val;
  markDirty();
}

function toggleParam(idx) {
  activeRequest.queryParams[idx].enabled =
    !activeRequest.queryParams[idx].enabled;
  markDirty();
}

function removeParam(idx) {
  activeRequest.queryParams.splice(idx, 1);
  markDirty();
  renderParamsTable();
}

/* Headers Table */
function renderHeadersTable() {
  const tbody = document.getElementById("headers-tbody");
  tbody.innerHTML = "";
  const list = activeRequest.headers || [];
  document.getElementById("headers-count").textContent = list.length;
  list.forEach((h, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
          <td><input type="checkbox" ${h.enabled !== false ? "checked" : ""} onchange="toggleHeader(${idx})"></td>
          <td><input type="text" class="kv-input" value="${escapeHtml(h.key)}" oninput="updateHeader(${idx}, 'key', this.value)" placeholder="Header"></td>
          <td><input type="text" class="kv-input" value="${escapeHtml(h.value)}" oninput="updateHeader(${idx}, 'value', this.value)" placeholder="Value"></td>
          <td><button class="icon-btn" onclick="removeHeader(${idx})">✕</button></td>
        `;
    tbody.appendChild(tr);
  });
  refreshIcons();
}

function addHeaderRow() {
  if (!activeRequest.headers) activeRequest.headers = [];
  activeRequest.headers.push({ key: "", value: "", enabled: true });
  markDirty();
  renderHeadersTable();
}

function updateHeader(idx, field, val) {
  activeRequest.headers[idx][field] = val;
  markDirty();
}

function toggleHeader(idx) {
  activeRequest.headers[idx].enabled = !activeRequest.headers[idx].enabled;
  markDirty();
}

function removeHeader(idx) {
  activeRequest.headers.splice(idx, 1);
  markDirty();
  renderHeadersTable();
}

/* Body View & Mode Management */
function renderBodyView() {
  const mode = activeRequest.body?.mode || "none";
  const radios = document.getElementsByName("body-mode");
  for (const r of radios) {
    r.checked = r.value === mode;
  }

  const rawContainer = document.getElementById("body-raw-container");
  const formdataContainer = document.getElementById("body-formdata-container");

  if (mode === "none") {
    rawContainer.style.display = "none";
    formdataContainer.style.display = "none";
  } else if (mode === "raw-json" || mode === "raw-text") {
    rawContainer.style.display = "block";
    formdataContainer.style.display = "none";
    document.getElementById("req-body-raw").value =
      activeRequest.body?.raw || "";
  } else if (mode === "form-data" || mode === "x-www-form-urlencoded") {
    rawContainer.style.display = "none";
    formdataContainer.style.display = "block";
    renderFormDataTable();
  }
}

function changeBodyMode(mode) {
  if (!activeRequest.body) activeRequest.body = { mode: "none" };
  activeRequest.body.mode = mode;
  markDirty();
  renderBodyView();
}

function renderFormDataTable() {
  const tbody = document.getElementById("formdata-tbody");
  tbody.innerHTML = "";
  (activeRequest.body?.formData || []).forEach((p, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
          <td><input type="checkbox" ${p.enabled !== false ? "checked" : ""} onchange="toggleFormData(${idx})"></td>
          <td><input type="text" class="kv-input" value="${escapeHtml(p.key)}" oninput="updateFormData(${idx}, 'key', this.value)" placeholder="Key"></td>
          <td><input type="text" class="kv-input" value="${escapeHtml(p.value)}" oninput="updateFormData(${idx}, 'value', this.value)" placeholder="Value"></td>
          <td><button class="icon-btn" onclick="removeFormData(${idx})">✕</button></td>
        `;
    tbody.appendChild(tr);
  });
  refreshIcons();
}

function addFormDataRow() {
  if (!activeRequest.body) activeRequest.body = { mode: "form-data" };
  if (!activeRequest.body.formData) activeRequest.body.formData = [];
  activeRequest.body.formData.push({ key: "", value: "", enabled: true });
  markDirty();
  renderFormDataTable();
}

function updateFormData(idx, field, val) {
  activeRequest.body.formData[idx][field] = val;
  markDirty();
}

function toggleFormData(idx) {
  activeRequest.body.formData[idx].enabled =
    !activeRequest.body.formData[idx].enabled;
  markDirty();
}

function removeFormData(idx) {
  activeRequest.body.formData.splice(idx, 1);
  markDirty();
  renderFormDataTable();
}

/* Auth Tab */
function renderAuthView() {
  const auth = activeRequest.auth || { type: "none" };
  document.getElementById("auth-type").value = auth.type;
  const fields = document.getElementById("auth-fields");

  if (auth.type === "bearer") {
    fields.innerHTML = `
          <div style="font-size: 12px; margin-bottom: 6px; font-weight: 600;">Token:</div>
          <input type="text" class="url-input" style="width: 100%;" value="${escapeHtml(auth.bearerToken || "")}" oninput="activeRequest.auth.bearerToken = this.value; markDirty();" placeholder="Bearer Token (supports {{variable}})" />
        `;
  } else if (auth.type === "basic") {
    fields.innerHTML = `
          <div style="display: flex; gap: 12px;">
            <div style="flex: 1;">
              <div style="font-size: 12px; margin-bottom: 6px; font-weight: 600;">Username:</div>
              <input type="text" class="url-input" style="width: 100%;" value="${escapeHtml(auth.basicUsername || "")}" oninput="activeRequest.auth.basicUsername = this.value; markDirty();" />
            </div>
            <div style="flex: 1;">
              <div style="font-size: 12px; margin-bottom: 6px; font-weight: 600;">Password:</div>
              <input type="password" class="url-input" style="width: 100%;" value="${escapeHtml(auth.basicPassword || "")}" oninput="activeRequest.auth.basicPassword = this.value; markDirty();" />
            </div>
          </div>
        `;
  } else if (auth.type === "apikey") {
    fields.innerHTML = `
          <div style="display: flex; gap: 12px; margin-bottom: 12px;">
            <div style="flex: 1;">
              <div style="font-size: 12px; margin-bottom: 6px; font-weight: 600;">Key:</div>
              <input type="text" class="url-input" style="width: 100%;" value="${escapeHtml(auth.apiKeyName || "X-API-Key")}" oninput="activeRequest.auth.apiKeyName = this.value; markDirty();" placeholder="e.g. X-API-Key" />
            </div>
            <div style="flex: 1;">
              <div style="font-size: 12px; margin-bottom: 6px; font-weight: 600;">Value:</div>
              <input type="text" class="url-input" style="width: 100%;" value="${escapeHtml(auth.apiKeyValue || "")}" oninput="activeRequest.auth.apiKeyValue = this.value; markDirty();" placeholder="Secret Key (supports {{apiKey}})" />
            </div>
          </div>
          <div>
            <div style="font-size: 12px; margin-bottom: 6px; font-weight: 600;">Add to:</div>
            <select class="method-select" onchange="activeRequest.auth.apiKeyIn = this.value; markDirty();">
              <option value="header" ${auth.apiKeyIn !== "query" ? "selected" : ""}>Header</option>
              <option value="query" ${auth.apiKeyIn === "query" ? "selected" : ""}>Query Params</option>
            </select>
          </div>
        `;
  } else {
    fields.innerHTML = `<span style="font-size:12px;color:var(--text-muted)">${auth.type === "inherit" ? "Authorization is resolved from the nearest parent folder or collection when this request runs." : auth.type === "unsupported" ? "This imported authorization mode is preserved for export. Execution is blocked until you select a supported mode." : "This request does not use authorization headers."}</span>`;
  }
}

function changeAuthType() {
  const t = document.getElementById("auth-type").value;
  activeRequest.auth = { type: t };
  markDirty();
  renderAuthView();
}

function switchReqTab(tab) {
  activeReqTab = tab;
  ["params", "headers", "body", "auth", "scripts"].forEach((t) => {
    document.getElementById(`tab-${t}`).style.display =
      t === tab ? "block" : "none";
  });
  document.querySelectorAll("main > .tab-nav .tab-btn").forEach((b) => {
    const selected = b.dataset.tab === tab;
    b.classList.toggle("active", selected);
    b.setAttribute("aria-selected", String(selected));
  });
}

function switchResTab(tab) {
  activeResTab = tab;
  document.getElementById("res-body").style.display =
    tab === "body" ? "block" : "none";
  document.getElementById("res-headers").style.display =
    tab === "headers" ? "block" : "none";
  document.getElementById("res-tests").style.display =
    tab === "tests" ? "block" : "none";
  document.getElementById("res-logs").style.display =
    tab === "logs" ? "block" : "none";

  const btns = document.querySelectorAll(".response-pane .tab-btn");
  btns.forEach((b) => {
    const selected = b.dataset.resTab === tab;
    b.classList.toggle("active", selected);
    b.setAttribute("aria-selected", String(selected));
  });
}

/* Execute HTTP Request with Anime.js Kinetic Counters */
async function sendActiveRequest() {
  if (!activeRequest || document.getElementById("btn-send-main").disabled)
    return;
  const sendButton = document.getElementById("btn-send-main");
  sendButton.disabled = true;
  requestAbortController = new AbortController();
  document.getElementById("cancel-request").style.display = "inline-flex";
  sendButton.setAttribute("aria-busy", "true");
  syncCurrentFieldsToActiveRequest();
  switchResTab("body");

  const statusEl = document.getElementById("res-status");
  statusEl.textContent = "Sending...";
  statusEl.style.color = "#f59e0b";
  statusEl.style.background = "rgba(245, 158, 11, 0.15)";
  statusEl.style.borderColor = "rgba(245, 158, 11, 0.3)";
  document.getElementById("res-body").textContent = "Sending request…";

  try {
    const payload = {
      request: activeRequest,
      collectionId: activeCollection?.id,
      collectionVariables: activeCollection?.variables || [],
      environmentId: activeEnvironmentId || undefined,
    };

    const res = await fetch("/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: requestAbortController.signal,
    });

    const data = await res.json();
    if (!res.ok)
      throw new Error(
        data.error?.message || data.error || `Request failed (${res.status})`,
      );
    currentResponseData = data;

    // Render Status badge
    if (data.skipRequest) {
      statusEl.textContent = "Skipped by script";
    } else if (data.status === 0) {
      statusEl.textContent = `${data.error?.category || "Connection Failed"}`;
      statusEl.style.color = "#ef4444";
      statusEl.style.background = "rgba(239, 68, 68, 0.15)";
      statusEl.style.borderColor = "rgba(239, 68, 68, 0.35)";
    } else {
      statusEl.textContent = `${data.status} ${data.statusText}`;
      if (data.status >= 200 && data.status < 300) {
        statusEl.style.color = "#10b981";
        statusEl.style.background = "rgba(16, 185, 129, 0.15)";
        statusEl.style.borderColor = "rgba(16, 185, 129, 0.35)";
      } else {
        statusEl.style.color = "#ef4444";
        statusEl.style.background = "rgba(239, 68, 68, 0.15)";
        statusEl.style.borderColor = "rgba(239, 68, 68, 0.35)";
      }
    }

    // Anime.js Kinetic Count-Up for Response Time and Size
    const targetMs = data.timings?.totalMs || 0;
    const targetKb = (data.sizeBytes || 0) / 1024;

    if (
      typeof anime !== "undefined" &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const metricObj = { time: 0, size: 0 };
      anime({
        targets: metricObj,
        time: targetMs,
        size: targetKb,
        round: 1,
        easing: "easeOutExpo",
        duration: 220,
        update: function () {
          document.getElementById("res-time").textContent =
            `${Math.round(metricObj.time)} ms`;
          document.getElementById("res-size").textContent =
            `${metricObj.size.toFixed(2)} KB`;
        },
      });
    } else {
      document.getElementById("res-time").textContent = `${targetMs} ms`;
      document.getElementById("res-size").textContent =
        `${targetKb.toFixed(2)} KB`;
    }

    // Render Body
    const resBodyEl = document.getElementById("res-body");
    if (data.error && data.status === 0) {
      resBodyEl.innerHTML = `
            <div class="error-card">
              <div class="error-card-title">⚠️ ${escapeHtml(data.error.category)}</div>
              <div class="error-card-msg">${escapeHtml(data.error.message)}</div>
              <div class="error-card-guidance">💡 <strong>Guidance:</strong> ${escapeHtml(data.error.guidance)}</div>
            </div>
          `;
    } else {
      try {
        const parsed = JSON.parse(data.body);
        resBodyEl.textContent = JSON.stringify(parsed, null, 2);
      } catch {
        resBodyEl.textContent = data.body || "(Empty Response)";
      }
    }

    // Render Headers
    let headersStr = "";
    for (const [k, v] of Object.entries(data.headers || {})) {
      headersStr += `${k}: ${v}\n`;
    }
    document.getElementById("res-headers").textContent =
      headersStr || "No response headers.";

    // Render Tests
    const testResults = data.testResults || [];
    document.getElementById("tests-count").textContent = testResults.length;
    let testsHtml = "";
    testResults.forEach((t) => {
      testsHtml += `
            <div style="padding: 10px 0; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px;">
              <div style="display: flex; gap: 8px; align-items: center;">
                <span>${t.passed ? "✅" : "❌"}</span>
                <span style="font-weight: 600; color: ${t.passed ? "#10b981" : "#ef4444"};">${escapeHtml(t.name)}</span>
              </div>
              ${t.error ? `<div style="color: #ef4444; font-size: 11px; margin-left: 24px;">${escapeHtml(t.error)}</div>` : ""}
            </div>
          `;
    });
    document.getElementById("res-tests").innerHTML =
      testsHtml ||
      '<div style="color: var(--text-muted); padding: 12px;">No tests were configured for this request.</div>';

    // Render Console Logs
    const logs = data.logs || [];
    document.getElementById("logs-count").textContent = logs.length;
    let logsHtml = "";
    logs.forEach((l) => {
      logsHtml += `<div class="console-line">${escapeHtml(l)}</div>`;
    });
    document.getElementById("res-logs").innerHTML =
      logsHtml ||
      '<div style="color: var(--text-muted); padding: 12px;">No console logs emitted. Use console.log() in your scripts.</div>';

    // Reload environments if mutated by scripts
    if (data.updatedVariables && activeEnvironmentId) {
      loadEnvironments();
    }
  } catch (err) {
    statusEl.textContent =
      err.name === "AbortError" ? "Cancelled" : "Request failed";
    statusEl.style.color = "#ef4444";
    statusEl.style.background = "rgba(239, 68, 68, 0.15)";
    document.getElementById("res-body").textContent = String(err);
  } finally {
    sendButton.disabled = false;
    requestAbortController = null;
    document.getElementById("cancel-request").style.display = "none";
    sendButton.removeAttribute("aria-busy");
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Response Tools */
function copyResponseBody() {
  const text = document.getElementById("res-body").innerText;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const orig = document.getElementById("res-time").textContent;
    document.getElementById("res-time").textContent = "Copied!";
    setTimeout(() => {
      document.getElementById("res-time").textContent = orig;
    }, 1200);
  });
}

function downloadResponseBody() {
  if (!currentResponseData) return;
  const text = currentResponseData.body || "";
  const binary = currentResponseData.bodyEncoding === "base64";
  const isJson =
    !binary && (text.trim().startsWith("{") || text.trim().startsWith("["));
  const ext = binary ? "bin" : isJson ? "json" : "txt";
  const bytes = binary
    ? Uint8Array.from(atob(currentResponseData.bodyBase64 || ""), (c) =>
        c.charCodeAt(0),
      )
    : text;
  const blob = new Blob([bytes], {
    type: binary
      ? "application/octet-stream"
      : isJson
        ? "application/json"
        : "text/plain",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `response_${Date.now()}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

function toggleResponseSearch() {
  const container = document.getElementById("res-search-container");
  const isHidden =
    container.style.display === "none" || !container.style.display;
  container.style.display = isHidden ? "flex" : "none";
  if (isHidden) {
    document.getElementById("res-search-input").focus();
  }
}

function filterResponseSearch(query) {
  if (!currentResponseData) return;
  const bodyEl = document.getElementById("res-body");
  let rawText = "";
  try {
    rawText = JSON.stringify(JSON.parse(currentResponseData.body), null, 2);
  } catch {
    rawText = currentResponseData.body || "";
  }

  if (!query.trim()) {
    bodyEl.textContent = rawText;
    return;
  }

  const escaped = escapeHtml(rawText);
  const reg = new RegExp(
    `(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
    "gi",
  );
  bodyEl.innerHTML = escaped.replace(
    reg,
    '<mark style="background: #f59e0b; color: #000; padding: 1px 3px; border-radius: 2px;">$1</mark>',
  );
}

/* Environment Manager Modal */
function openEnvironmentManager() {
  document.getElementById("modal-title").textContent = "Environment Management";
  let envListHtml = "";
  environments.forEach((e) => {
    envListHtml += `
          <div style="padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; cursor: default; ${e.id === activeEnvironmentId ? "background: rgba(144, 71, 255, 0.15); border-left: 2px solid var(--primary);" : ""}">
            <button class="env-item-select" onclick="selectEnvironmentForEdit(${escapeHtml(JSON.stringify(e.id))})"><span><strong>${escapeHtml(e.name)}</strong> <span style="font-size: 11px; color: var(--text-muted);">(${e.values.length} vars)</span></span></button>
            <button class="icon-btn" onclick="event.stopPropagation(); deleteEnvironment(${escapeHtml(JSON.stringify(e.id))})" aria-label="Delete environment"><i data-lucide="trash-2"></i></button>
          </div>
        `;
  });

  document.getElementById("modal-body").innerHTML = `
        <div style="display: flex; gap: 16px; height: 380px;">
          <div style="width: 220px; border-right: 1px solid var(--border); overflow-y: auto;">
            <button class="nav-btn" style="width: 100%; margin-bottom: 12px;" onclick="createNewEnvironment()">+ New Environment</button>
            <div id="env-modal-list">${envListHtml || '<div style="font-size: 12px; color: var(--text-muted); padding: 10px;">No environments found.</div>'}</div>
          </div>
          <div style="flex: 1; display: flex; flex-direction: column;" id="env-edit-panel">
            <div style="font-size: 12px; color: var(--text-muted); padding: 24px; text-align: center;">Select an environment on the left to edit variables.</div>
          </div>
        </div>
      `;

  document.getElementById("modal-footer").innerHTML = `
        <button class="nav-btn" onclick="closeModal()">Done</button>
      `;

  openModal();
  if (activeEnvironmentId) selectEnvironmentForEdit(activeEnvironmentId);
}

let editingEnvironmentId = null;
function renameEnvironment(name) {
  const env = environments.find((e) => e.id === editingEnvironmentId);
  if (!env) return;
  env.name = name;
  saveEnvironmentDirect(env);
}
function selectEnvironmentForEdit(envId) {
  editingEnvironmentId = envId;
  const env = environments.find((e) => e.id === envId);
  if (!env) return;

  const panel = document.getElementById("env-edit-panel");
  let tableRows = "";
  (env.values || []).forEach((v, idx) => {
    tableRows += `
          <tr>
            <td><input type="checkbox" ${v.enabled !== false ? "checked" : ""} onchange="toggleEnvVar(${escapeHtml(JSON.stringify(envId))}, ${idx})"></td>
            <td><input type="text" class="kv-input" value="${escapeHtml(v.key)}" oninput="updateEnvVar(${escapeHtml(JSON.stringify(envId))}, ${idx}, 'key', this.value)" placeholder="VARIABLE_NAME"></td>
            <td><input type="text" class="kv-input" value="${escapeHtml(v.value)}" oninput="updateEnvVar(${escapeHtml(JSON.stringify(envId))}, ${idx}, 'value', this.value)" placeholder="Value"></td>
            <td><button class="icon-btn" onclick="removeEnvVar(${escapeHtml(JSON.stringify(envId))}, ${idx})">✕</button></td>
          </tr>
        `;
  });

  panel.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <input type="text" class="url-input" style="font-weight: 700; font-size: 14px; width: 220px;" value="${escapeHtml(env.name)}" onchange="renameEnvironment(this.value)" />
          <button class="nav-btn" onclick="addEnvVarRow(${escapeHtml(JSON.stringify(envId))})">+ Add Variable</button>
        </div>
        <div style="flex: 1; overflow-y: auto;">
          <table class="kv-table">
            <thead>
              <tr>
                <th style="width: 30px;"></th>
                <th>Variable Name</th>
                <th>Current Value</th>
                <th style="width: 30px;"></th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      `;
  refreshIcons();
}

async function createNewEnvironment() {
  const name = prompt("Environment Name:", "Production");
  if (!name) return;
  const newEnv = {
    id: "env_" + Date.now(),
    name,
    values: [
      { key: "baseUrl", value: "https://api.example.com", enabled: true },
      { key: "apiKey", value: "secret-key-xyz", enabled: true },
    ],
  };
  await fetch("/api/environments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(newEnv),
  });
  await loadEnvironments();
  openEnvironmentManager();
  selectEnvironmentForEdit(newEnv.id);
}

async function saveEnvironmentDirect(env) {
  await fetch("/api/environments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(env),
  });
  loadEnvironments();
}

function addEnvVarRow(envId) {
  const env = environments.find((e) => e.id === envId);
  if (!env) return;
  env.values.push({ key: "", value: "", enabled: true });
  saveEnvironmentDirect(env);
  selectEnvironmentForEdit(envId);
}

function updateEnvVar(envId, idx, field, val) {
  const env = environments.find((e) => e.id === envId);
  if (!env) return;
  env.values[idx][field] = val;
  saveEnvironmentDirect(env);
}

function toggleEnvVar(envId, idx) {
  const env = environments.find((e) => e.id === envId);
  if (!env) return;
  env.values[idx].enabled = !env.values[idx].enabled;
  saveEnvironmentDirect(env);
}

function removeEnvVar(envId, idx) {
  const env = environments.find((e) => e.id === envId);
  if (!env) return;
  env.values.splice(idx, 1);
  saveEnvironmentDirect(env);
  selectEnvironmentForEdit(envId);
}

async function deleteEnvironment(envId) {
  if (!confirm("Are you sure you want to delete this environment?")) return;
  await fetch(`/api/environments/${envId}`, { method: "DELETE" });
  if (activeEnvironmentId === envId) activeEnvironmentId = "";
  await loadEnvironments();
  openEnvironmentManager();
}

function openEnvironmentQuickLook() {
  const env = environments.find((e) => e.id === activeEnvironmentId);
  document.getElementById("modal-title").textContent = env
    ? `Quick Look: ${env.name}`
    : "Quick Look: No Active Environment";

  if (!env) {
    document.getElementById("modal-body").innerHTML = `
          <div style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 36px;">
            No active environment selected. Choose an environment from the top dropdown.
          </div>
        `;
  } else {
    let rows = "";
    env.values.forEach((v) => {
      rows += `
            <tr>
              <td style="font-family: var(--font-mono); font-weight: 600; color: var(--cyber-cyan);">{{${escapeHtml(v.key)}}}</td>
              <td style="font-family: var(--font-mono); color: #e2e8f0;">${escapeHtml(v.value)}</td>
            </tr>
          `;
    });
    document.getElementById("modal-body").innerHTML = `
          <table class="kv-table">
            <thead>
              <tr><th>Variable</th><th>Active Value</th></tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="2" style="color: var(--text-muted);">No variables defined.</td></tr>'}</tbody>
          </table>
        `;
  }

  document.getElementById("modal-footer").innerHTML = `
        <button class="nav-btn" onclick="openEnvironmentManager()">Manage Variables</button>
        <button class="nav-btn" onclick="closeModal()">Close</button>
      `;
  openModal();
}

/* Code Snippet Generator Modal */
function openCodeGeneratorModal() {
  if (!activeRequest) return;
  syncCurrentFieldsToActiveRequest();

  document.getElementById("modal-title").textContent = "</> Code Snippets";
  document.getElementById("modal-body").innerHTML = `
        <div class="tab-nav" style="border-bottom: 1px solid var(--border); margin-bottom: 14px;">
          <button class="tab-btn active" onclick="switchSnippetLang('curl')">cURL</button>
          <button class="tab-btn" onclick="switchSnippetLang('fetch')">Fetch (JavaScript)</button>
          <button class="tab-btn" onclick="switchSnippetLang('python')">Python (requests)</button>
          <button class="tab-btn" onclick="switchSnippetLang('go')">Go (net/http)</button>
        </div>
        <textarea class="code-editor" id="snippet-textarea" style="height: 280px;" readonly></textarea>
      `;

  document.getElementById("modal-footer").innerHTML = `
        <button class="nav-btn" onclick="copySnippetCode()">Copy Snippet</button>
        <button class="nav-btn" onclick="closeModal()">Close</button>
      `;

  openModal();
  switchSnippetLang("curl");
}

function compileSnippetRequest(req) {
  const method = (req.method || "GET").toUpperCase();
  let url = req.url || "";
  const enabledParams = (req.queryParams || []).filter(
    (q) => q.enabled !== false && q.key,
  );
  if (enabledParams.length > 0) {
    try {
      const hasProto = /^https?:\/\//i.test(url);
      const u = new URL(hasProto ? url : "http://" + url);
      enabledParams.forEach((p) => u.searchParams.append(p.key, p.value || ""));
      url = hasProto ? u.toString() : u.toString().replace(/^http:\/\//, "");
    } catch {}
  }

  const headers = [
    ...(req.headers || []).filter((h) => h.enabled !== false && h.key),
  ];

  // Auth integration
  if (req.auth) {
    if (req.auth.type === "bearer" && req.auth.bearerToken) {
      headers.push({
        key: "Authorization",
        value: `Bearer ${req.auth.bearerToken}`,
      });
    } else if (req.auth.type === "basic") {
      const creds = btoa(
        `${req.auth.basicUsername || ""}:${req.auth.basicPassword || ""}`,
      );
      headers.push({ key: "Authorization", value: `Basic ${creds}` });
    } else if (
      req.auth.type === "apikey" &&
      req.auth.apiKeyName &&
      req.auth.apiKeyValue
    ) {
      if (req.auth.apiKeyIn === "query") {
        try {
          const hasProto = /^https?:\/\//i.test(url);
          const u = new URL(hasProto ? url : "http://" + url);
          u.searchParams.append(req.auth.apiKeyName, req.auth.apiKeyValue);
          url = hasProto
            ? u.toString()
            : u.toString().replace(/^http:\/\//, "");
        } catch {}
      } else {
        headers.push({ key: req.auth.apiKeyName, value: req.auth.apiKeyValue });
      }
    }
  }

  // Body integration
  let bodyStr = "";
  let isJsonBody = false;
  if (method !== "GET" && method !== "HEAD" && req.body) {
    if (req.body.mode === "raw-json") {
      bodyStr = req.body.raw || "";
      isJsonBody = true;
      if (!headers.some((h) => h.key.toLowerCase() === "content-type")) {
        headers.push({ key: "Content-Type", value: "application/json" });
      }
    } else if (req.body.mode === "raw-text") {
      bodyStr = req.body.raw || "";
    } else if (req.body.mode === "x-www-form-urlencoded") {
      const sp = new URLSearchParams();
      (req.body.formData || [])
        .filter((p) => p.enabled !== false && p.key)
        .forEach((p) => sp.append(p.key, p.value || ""));
      bodyStr = sp.toString();
      if (!headers.some((h) => h.key.toLowerCase() === "content-type")) {
        headers.push({
          key: "Content-Type",
          value: "application/x-www-form-urlencoded",
        });
      }
    } else if (req.body.mode === "form-data") {
      const sp = new URLSearchParams();
      (req.body.formData || [])
        .filter((p) => p.enabled !== false && p.key)
        .forEach((p) => sp.append(p.key, p.value || ""));
      bodyStr = sp.toString();
    }
  }

  return { method, url, headers, bodyStr, isJsonBody };
}

function switchSnippetLang(lang) {
  const area = document.getElementById("snippet-textarea");
  const compiled = compileSnippetRequest(activeRequest);
  const { method, url, headers, bodyStr, isJsonBody } = compiled;

  if (lang === "curl") {
    let cmd = `curl -X ${method} "${url}"`;
    headers.forEach((h) => {
      cmd += ` \\\n  -H "${h.key}: ${h.value}"`;
    });
    if (bodyStr && method !== "GET" && method !== "HEAD") {
      cmd += ` \\\n  -d '${bodyStr}'`;
    }
    area.value = cmd;
  } else if (lang === "fetch") {
    const headersObj = {};
    headers.forEach((h) => {
      headersObj[h.key] = h.value;
    });
    let code = `fetch("${url}", {\n  method: "${method}",\n  headers: ${JSON.stringify(headersObj, null, 4)}`;
    if (bodyStr && method !== "GET" && method !== "HEAD") {
      code += `,\n  body: ${isJsonBody ? `JSON.stringify(${bodyStr})` : JSON.stringify(bodyStr)}`;
    }
    code += `\n})\n.then(response => response.json())\n.then(result => console.log(result))\n.catch(error => console.error('Error:', error));`;
    area.value = code;
  } else if (lang === "python") {
    let code = `import requests\n\nurl = "${url}"\n`;
    const headersDict = {};
    headers.forEach((h) => {
      headersDict[h.key] = h.value;
    });
    code += `headers = ${JSON.stringify(headersDict, null, 4)}\n`;

    if (bodyStr && method !== "GET" && method !== "HEAD") {
      if (isJsonBody) {
        code += `payload = ${bodyStr}\n`;
        code += `response = requests.${method.toLowerCase()}(url, json=payload, headers=headers)\n`;
      } else {
        code += `payload = """${bodyStr}"""\n`;
        code += `response = requests.${method.toLowerCase()}(url, data=payload, headers=headers)\n`;
      }
    } else {
      code += `response = requests.${method.toLowerCase()}(url, headers=headers)\n`;
    }
    code += `print(response.status_code)\nprint(response.text)`;
    area.value = code;
  } else if (lang === "go") {
    let code = `package main\n\nimport (\n\t"fmt"\n\t"net/http"\n\t"io"\n`;
    if (bodyStr && method !== "GET" && method !== "HEAD")
      code += `\t"strings"\n`;
    code += `)\n\nfunc main() {\n\tclient := &http.Client{}\n`;
    if (bodyStr && method !== "GET" && method !== "HEAD") {
      code += `\tbody := strings.NewReader(\`${bodyStr}\`)\n`;
      code += `\treq, err := http.NewRequest("${method}", "${url}", body)\n`;
    } else {
      code += `\treq, err := http.NewRequest("${method}", "${url}", nil)\n`;
    }
    code += `\tif err != nil {\n\t\tpanic(err)\n\t}\n`;
    headers.forEach((h) => {
      code += `\treq.Header.Set("${h.key}", "${h.value}")\n`;
    });
    code += `\tres, err := client.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer res.Body.Close()\n\trespBytes, _ := io.ReadAll(res.Body)\n\tfmt.Println(string(respBytes))\n}`;
    area.value = code;
  }

  const btns = document.querySelectorAll("#modal-body .tab-btn");
  btns.forEach((b) => {
    if (b.textContent.toLowerCase().includes(lang)) b.classList.add("active");
    else b.classList.remove("active");
  });
}

function copySnippetCode() {
  const code = document.getElementById("snippet-textarea").value;
  navigator.clipboard.writeText(code).then(() => {
    alert("Snippet copied to clipboard!");
  });
}

/* Views & Sniffer */
function switchView(view) {
  for (const [name, id] of [
    ["studio", "studio-view"],
    ["sniffer", "sniffer-screen"],
    ["runner", "runner-screen"],
  ]) {
    document.getElementById(id).style.display = name === view ? "flex" : "none";
    document
      .getElementById(`btn-${name}-view`)
      ?.classList.toggle("active", name === view);
  }
  if (view === "sniffer") pollSnifferTraffic();
}

async function pollSnifferTraffic() {
  try {
    const res = await fetch("/api/sniff/traffic");
    let items = await res.json();
    const select = document.getElementById("sniff-origin"),
      selected = select.value;
    const origins = [
      ...new Set(
        items.map((item) => {
          try {
            return new URL(item.url).origin;
          } catch {
            return "";
          }
        }),
      ),
    ].filter(Boolean);
    select.replaceChildren(
      new Option("All origins", ""),
      ...origins.map((origin) => new Option(origin, origin)),
    );
    select.value = origins.includes(selected) ? selected : "";
    if (select.value)
      items = items.filter((item) => new URL(item.url).origin === select.value);
    document.getElementById("sniff-count").textContent = items.length;

    const tbody = document.getElementById("traffic-tbody");
    if (items.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">No traffic intercepted yet. Send requests through port 8085.</td></tr>';
      return;
    }

    tbody.innerHTML = "";
    items
      .slice(-30)
      .reverse()
      .forEach((item) => {
        const tr = document.createElement("tr");
        const mClass = `method-${item.method.toLowerCase()}`;
        tr.innerHTML = `
            <td><span class="method-badge ${mClass}">${item.method}</span></td>
            <td><span style="color: var(--cyber-cyan);">${escapeHtml(item.pathname)}</span> <span style="color: var(--text-muted); font-size: 11px;">(${escapeHtml(item.url)})</span></td>
            <td><span style="color: ${item.responseStatus < 300 ? "#10b981" : "#ef4444"}; font-weight: 700;">${item.responseStatus}</span></td>
            <td>${item.durationMs} ms</td>
            <td style="color: var(--text-muted); font-size: 11px;">${new Date(item.timestamp).toLocaleTimeString()}</td>
          `;
        tr.onclick = () => showSniffedItemDetails(item);
        tbody.appendChild(tr);
      });
  } catch (e) {}
}

async function clearSniffedTraffic() {
  await fetch("/api/sniff/clear", { method: "POST" });
  pollSnifferTraffic();
}

async function exportOpenApi() {
  const res = await fetch(
    "/api/sniff/export/openapi?origin=" +
      encodeURIComponent(document.getElementById("sniff-origin").value),
    { method: "POST" },
  );
  const spec = await res.json();
  if (!res.ok) {
    alert(
      spec.error?.message || spec.error || "Export failed; choose one origin.",
    );
    return;
  }

  document.getElementById("modal-title").textContent =
    "✨ Reverse-Engineered OpenAPI 3.1.0 Specification";
  document.getElementById("modal-body").innerHTML = `
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
          Inferred from captured traffic. Review the document: unobserved behavior and some payload types are not represented.
        </p>
        <textarea class="code-editor" style="height: 380px;" readonly>${escapeHtml(JSON.stringify(spec, null, 2))}</textarea>
      `;
  document.getElementById("modal-footer").innerHTML =
    `<button class="nav-btn" onclick="closeModal()">Close</button>`;
  openModal();
}

async function exportTypeScriptSdk() {
  const res = await fetch(
    "/api/sniff/export/sdk?origin=" +
      encodeURIComponent(document.getElementById("sniff-origin").value),
    { method: "POST" },
  );
  const code = await res.text();
  if (!res.ok) {
    alert("Export failed. Choose one capture origin and try again.");
    return;
  }

  document.getElementById("modal-title").textContent =
    "📦 TypeScript client draft";
  document.getElementById("modal-body").innerHTML = `
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
          TypeScript client draft inferred from captured traffic. Review types, URLs, and error handling before use.
        </p>
        <textarea class="code-editor" style="height: 380px;" readonly>${escapeHtml(code)}</textarea>
      `;
  document.getElementById("modal-footer").innerHTML =
    `<button class="nav-btn" onclick="closeModal()">Close</button>`;
  openModal();
}

function showSniffedItemDetails(item) {
  document.getElementById("modal-title").textContent =
    `${item.method} ${item.pathname}`;
  document.getElementById("modal-body").innerHTML = `
        <div style="font-size: 12px; margin-bottom: 12px;">
          <strong>Target:</strong> <code style="color: var(--cyber-cyan);">${escapeHtml(item.url)}</code><br/>
          <strong>Status:</strong> ${item.responseStatus} | <strong>Latency:</strong> ${item.durationMs} ms
        </div>
        <div style="font-size: 12px; font-weight: 600; margin-bottom: 6px;">Captured Request Body:</div>
        <pre class="code-editor" style="height: 120px; margin-bottom: 14px;">${escapeHtml(JSON.stringify(item.requestBody ?? {}, null, 2))}</pre>
        <div style="font-size: 12px; font-weight: 600; margin-bottom: 6px;">Captured Response Body:</div>
        <pre class="code-editor" style="height: 160px;">${escapeHtml(JSON.stringify(item.responseBody ?? {}, null, 2))}</pre>
      `;
  document.getElementById("modal-footer").innerHTML =
    `<button class="nav-btn" onclick="closeModal()">Close</button>`;
  openModal();
}

function openImportModal() {
  document.getElementById("modal-title").textContent =
    "📥 Import Postman Collection or cURL";
  document.getElementById("modal-body").innerHTML = `
        <div style="font-size: 12px; margin-bottom: 10px;">Paste a Postman Collection JSON or raw cURL command:</div>
        <textarea class="code-editor" id="import-text" style="height: 250px;" placeholder="curl -X POST https://api.example.com -H 'Content-Type: application/json' -d '{\"foo\":\"bar\"}'"></textarea>
      `;
  document.getElementById("modal-footer").innerHTML = `
        <button class="nav-btn" onclick="executeImport()">Import</button>
        <button class="nav-btn" onclick="closeModal()">Cancel</button>
      `;
  openModal();
}

async function executeImport() {
  const text = document.getElementById("import-text").value.trim();
  if (!text) return;

  if (text.startsWith("curl")) {
    const res = await fetch("/api/import/curl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ curl: text }),
    });
    const req = await res.json();
    if (!res.ok) {
      alert(req.error?.message || req.error || "Import failed");
      return;
    }
    if (collections.length > 0) {
      collections[0].items.push({ id: req.id, name: req.name, request: req });
      selectRequest(req, collections[0]);
      await saveActiveRequest();
    }
  } else {
    try {
      const parsed = JSON.parse(text);
      const res = await fetch("/api/import/postman", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (!res.ok) throw new Error("Import failed");
      const col = await res.json();
      await loadCollections();
      const first = findFirstRequestItem(col.items || []);
      if (first) selectRequest(first.request, col);
    } catch (err) {
      alert("Failed to parse input: " + err.message);
    }
  }
  closeModal();
}

let modalOpener = null;
function openModal() {
  modalOpener = document.activeElement;
  document.getElementById("modal-backdrop").style.display = "flex";
  document.querySelector("header").inert = true;
  document.querySelector(".app-body").inert = true;
  document.querySelector(".modal-box").focus();
  refreshIcons();
}

function closeModal() {
  document.getElementById("modal-backdrop").style.display = "none";
  document.querySelector("header").inert = false;
  document.querySelector(".app-body").inert = false;
  modalOpener?.focus();
}

window.addEventListener("DOMContentLoaded", init);

document.addEventListener("keydown", (event) => {
  if (document.getElementById("modal-backdrop").style.display !== "flex")
    return;
  if (event.key === "Escape") closeModal();
  if (event.key === "Tab") {
    const controls = [
      ...document.querySelectorAll(
        ".modal-box button, .modal-box input, .modal-box textarea, .modal-box select, .modal-box a[href]",
      ),
    ].filter((e) => !e.disabled && e.getClientRects().length);
    const first = controls[0],
      last = controls.at(-1);
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        document.activeElement.classList.contains("modal-box"))
    ) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
});

let activeRunId = null,
  lastRunResult = null;
function openRunner() {
  const select = document.getElementById("run-collection");
  select.replaceChildren(
    ...collections.map((col) => new Option(col.name, col.id)),
  );
  if (activeCollection) select.value = activeCollection.id;
  switchView("runner");
}
async function startCollectionRun() {
  if (activeRunId) return;
  const progress = document.getElementById("run-progress"),
    button = document.getElementById("start-run");
  try {
    const raw = document.getElementById("run-data").value.trim(),
      data = raw ? JSON.parse(raw) : undefined;
    if (data && (!Array.isArray(data) || !data.length))
      throw new Error(
        "Iteration data must be a nonempty JSON array of objects",
      );
    const iterations = Number(document.getElementById("run-iterations").value);
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collectionId: document.getElementById("run-collection").value,
        environmentId: activeEnvironmentId || undefined,
        iterations: data && iterations === 1 ? data.length : iterations,
        data,
        timeoutMs: Number(document.getElementById("run-timeout").value),
        stopOnFailure: document.getElementById("run-bail").checked,
      }),
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "Could not start run");
    activeRunId = job.id;
    lastRunResult = null;
    button.disabled = true;
    document.getElementById("cancel-run").style.display = "inline-flex";
    document.getElementById("download-run").disabled = true;
    document.getElementById("run-results").replaceChildren();
    while (activeRunId) {
      const stateResponse = await fetch(`/api/runs/${activeRunId}`);
      const state = await stateResponse.json();
      if (!stateResponse.ok)
        throw new Error(state.error || "Run polling failed");
      progress.textContent = state.progress
        ? `Completed ${state.progress.completed} request(s). ${state.progress.name}`
        : "Starting run…";
      if (state.state === "completed") {
        if (state.error) throw new Error(state.error);
        lastRunResult = state.result;
        renderRunResult(lastRunResult);
        document.getElementById("download-run").disabled = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    progress.textContent = error.message;
  } finally {
    activeRunId = null;
    button.disabled = false;
    document.getElementById("cancel-run").style.display = "none";
  }
}
function renderRunResult(result) {
  const s = result.summary;
  document.getElementById("run-progress").textContent =
    `${result.status.toUpperCase()}: ${s.requests} requests · ${s.passed} assertions passed · ${s.failed} failed · ${s.errors} errors${result.error ? " · " + result.error : ""}`;
  document.getElementById("run-results").innerHTML =
    `<table class="traffic-table"><thead><tr><th>Iteration</th><th>Request</th><th>Status</th><th>Assertions</th><th>Time</th></tr></thead><tbody>${result.executions
      .map(
        (execution) =>
          `<tr><td>${execution.iteration + 1}</td><td>${escapeHtml(execution.name)}</td><td>${escapeHtml(execution.response.statusText || execution.response.error?.category || String(execution.response.status))}</td><td>${(execution.response.testResults || []).filter((t) => t.passed).length}/${(execution.response.testResults || []).length}</td><td>${execution.response.timings.totalMs} ms</td></tr>${(
            execution.response.testResults || []
          )
            .filter((t) => !t.passed)
            .map(
              (test) =>
                `<tr><td colspan="5">${escapeHtml(test.name)}: ${escapeHtml(test.error)}</td></tr>`,
            )
            .join("")}`,
      )
      .join("")}</tbody></table>`;
}
async function cancelCollectionRun() {
  if (activeRunId)
    await fetch(`/api/runs/${activeRunId}/cancel`, { method: "POST" });
}
function downloadRunReport() {
  if (!lastRunResult) return;
  const summary = {
    ...lastRunResult,
    environment: undefined,
    collectionVariables: undefined,
    executions: lastRunResult.executions.map((e) => ({
      name: e.name,
      iteration: e.iteration,
      status: e.response.status,
      timings: e.response.timings,
      testResults: e.response.testResults,
      error: e.response.error,
    })),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "rea-run-summary.json";
  a.click();
  URL.revokeObjectURL(url);
}
