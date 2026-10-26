const ROW_HEIGHT = 36;
const OVERSCAN = 8;
const keyFor = (col, request) => JSON.stringify([col.id, request.id]);
const label = (value) => String(value || "").slice(0, 512);

// A single view owner: models cover the workspace, elements cover only the viewport.
export class CollectionTree {
  static requestForItem(item) {
    return {
      ...item.request,
      id: item.request.id || item.id,
      name: item.request.name || item.name,
    };
  }

  constructor(root, options) {
    this.root = root;
    this.options = options;
    this.nodes = [];
    this.elements = new Map();
    this.collapsed = new Set();
    this.searchCollapsed = new Set();
    this.query = "";
    root.tabIndex = 0;
    root.setAttribute(
      "aria-label",
      "Request list. Use search, arrow keys, Home and End to navigate.",
    );
    root.style.overflowAnchor = "none";
    root.addEventListener(
      "scroll",
      () => {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = null;
          this.renderWindow();
        });
      },
      { passive: true },
    );
    root.addEventListener("keydown", (event) => this.keydown(event));
    this.resize = new ResizeObserver(() => this.renderWindow(true));
    this.resize.observe(root);
  }

  update(collections, query) {
    if (query !== this.query) {
      this.searchCollapsed.clear();
      this.root.scrollTop = 0;
    }
    this.query = query;
    const filter = (items, col, force = false) =>
      !query || force
        ? items
        : items.flatMap((item) => {
            if (item.isFolder) {
              if (String(item.name).toLowerCase().includes(query))
                return [item];
              const children = filter(item.items || [], col);
              return children.length ? [{ ...item, items: children }] : [];
            }
            if (!item.request) return [];
            const request =
              this.options.draft(col.id, item.request.id || item.id) ||
              CollectionTree.requestForItem(item);
            return `${item.name || ""} ${request.name || ""} ${request.url || ""}`
              .toLowerCase()
              .includes(query)
              ? [item]
              : [];
          });
    const nodes = [];
    const visit = (items, col, depth, path) => {
      for (const item of items) {
        if (item.isFolder) {
          const key = JSON.stringify([col.id, "folder", item.id]);
          const collapsed = (query ? this.searchCollapsed : this.collapsed).has(
            key,
          );
          nodes.push({
            kind: "folder",
            key,
            item,
            col,
            depth,
            path,
            collapsed,
          });
          if (!collapsed)
            visit(item.items || [], col, depth + 1, [...path, item.name]);
        } else if (item.request) {
          const request = CollectionTree.requestForItem(item);
          nodes.push({
            kind: "request",
            key: keyFor(col, request),
            request,
            col,
            depth,
            path,
          });
        }
      }
    };
    for (const col of collections) {
      const items = filter(
        col.items || [],
        col,
        String(col.name).toLowerCase().includes(query),
      );
      if (!items.length) continue;
      nodes.push({
        kind: "collection",
        key: JSON.stringify([col.id, "collection"]),
        col,
        depth: 0,
      });
      visit(items, col, 0, [col.name]);
    }
    this.nodes = nodes;
    this.root.scrollTop = Math.min(
      this.root.scrollTop,
      Math.max(0, nodes.length * ROW_HEIGHT - this.root.clientHeight),
    );
    this.renderWindow(true);
  }

  renderWindow(force = false) {
    if (!this.nodes.length) {
      this.root.replaceChildren();
      this.elements.clear();
      const empty = document.createElement("p");
      empty.className = "empty-collection";
      empty.textContent = this.query
        ? "No matching requests. Try another search."
        : "Import a collection to get started.";
      this.root.append(empty);
      this.range = null;
      return;
    }
    const size = Math.ceil(this.root.clientHeight / ROW_HEIGHT) + 2 * OVERSCAN;
    const start = Math.min(
      Math.max(0, this.nodes.length - size),
      Math.max(0, Math.floor(this.root.scrollTop / ROW_HEIGHT) - OVERSCAN),
    );
    const end = Math.min(this.nodes.length, start + size);
    if (!force && this.range?.[0] === start && this.range?.[1] === end) return;
    this.range = [start, end];
    const focusedRow = document.activeElement?.closest("[data-tree-key]");
    const focusedKey =
      focusedRow && this.root.contains(focusedRow)
        ? focusedRow.dataset.treeKey
        : null;
    const wasDelete = document.activeElement?.hasAttribute(
      "data-delete-request",
    );
    const fragment = document.createDocumentFragment();
    const spacer = (height) => {
      const div = document.createElement("div");
      div.style.height = `${height}px`;
      div.setAttribute("aria-hidden", "true");
      return div;
    };
    fragment.append(spacer(start * ROW_HEIGHT));
    this.elements.clear();
    for (let index = start; index < end; index++)
      fragment.append(this.renderRow(this.nodes[index], index));
    fragment.append(spacer((this.nodes.length - end) * ROW_HEIGHT));
    this.root.replaceChildren(fragment);
    this.refreshState();
    this.options.refreshIcons();
    if (focusedKey) {
      this.focusedKey = focusedKey;
      const target = this.elements
        .get(focusedKey)
        ?.querySelector(wasDelete ? "[data-delete-request]" : "button");
      (target || this.root).focus({ preventScroll: true });
    }
  }

  renderRow(node, index) {
    const row = document.createElement("div");
    row.className = "virtual-row";
    row.dataset.treeKey = node.key;
    row.dataset.treeIndex = String(index);
    this.elements.set(node.key, row);
    if (node.kind === "collection") {
      row.classList.add("collection-label");
      const icon = document.createElement("i");
      icon.dataset.lucide = "folder";
      const title = document.createElement("span");
      title.textContent = label(node.col.name);
      row.append(icon, title);
      this.options.decorateRow?.(row, node);
      return row;
    }
    row.style.paddingLeft = `${8 + node.depth * 14}px`;
    if (node.kind === "folder") {
      const button = document.createElement("button");
      button.className = "tree-folder-title";
      button.type = "button";
      button.setAttribute("aria-expanded", String(!node.collapsed));
      button.setAttribute("aria-label", `Folder: ${label(node.item.name)}`);
      button.textContent = `${node.collapsed ? "▸" : "▾"} ${label(node.item.name)}`;
      button.onclick = () => {
        const state = this.query ? this.searchCollapsed : this.collapsed;
        state.has(node.key) ? state.delete(node.key) : state.add(node.key);
        this.update(this.options.collections(), this.query);
      };
      row.append(button);
      this.options.decorateRow?.(row, node);
      return row;
    }
    row.classList.add("request-item");
    const request =
      this.options.draft(node.col.id, node.request.id) || node.request;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "req-main-info";
    button.setAttribute(
      "aria-label",
      `${request.method} ${label(request.name || request.url)}`,
    );
    button.title = label(
      [...node.path, request.name || request.url].join(" / "),
    );
    const method = document.createElement("span");
    method.className = `method-badge method-${String(request.method).toLowerCase()}`;
    method.textContent = request.method;
    const name = document.createElement("span");
    name.className = "virtual-request-name";
    name.textContent = label(request.name || request.url);
    const dirty = document.createElement("span");
    dirty.className = "dirty-dot";
    dirty.textContent = "•";
    button.append(method, name, dirty);
    button.onclick = () => this.options.select(node.request, node.col);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.dataset.deleteRequest = "";
    remove.title = "Delete Request";
    remove.setAttribute("aria-label", "Delete Request");
    remove.textContent = "✕";
    remove.onclick = () => this.options.remove(node.request.id, node.col.id);
    row.append(button, remove);
    this.options.decorateRow?.(row, node);
    return row;
  }

  refreshState() {
    const selected = this.options.selected();
    for (const [key, row] of this.elements) {
      if (!row.classList.contains("request-item")) continue;
      row.classList.toggle("selected", key === selected);
      const node = this.nodes[+row.dataset.treeIndex];
      row.querySelector(".dirty-dot").hidden = !this.options.dirty(
        node.col.id,
        node.request.id,
      );
    }
  }

  reveal(key) {
    const index = this.nodes.findIndex((node) => node.key === key);
    if (index < 0) return;
    const top = index * ROW_HEIGHT;
    if (top < this.root.scrollTop) this.root.scrollTop = top;
    else if (top + ROW_HEIGHT > this.root.scrollTop + this.root.clientHeight)
      this.root.scrollTop = top + ROW_HEIGHT - this.root.clientHeight;
    this.renderWindow();
  }

  keydown(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const focused = document.activeElement?.closest("[data-tree-index]");
    let index = focused
      ? +focused.dataset.treeIndex
      : this.nodes.findIndex(
          (node) => node.key === (this.focusedKey || this.options.selected()),
        );
    const direction = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
    if (event.key === "Home") index = -1;
    else if (event.key === "End") index = this.nodes.length;
    for (
      index += direction;
      index >= 0 && index < this.nodes.length;
      index += direction
    ) {
      if (this.nodes[index].kind !== "request") continue;
      this.reveal(this.nodes[index].key);
      this.focusedKey = this.nodes[index].key;
      this.elements
        .get(this.nodes[index].key)
        ?.querySelector(".req-main-info")
        ?.focus({ preventScroll: true });
      return;
    }
  }
}
