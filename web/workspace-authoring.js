import { applyAuthoringCommand, freshCollectionCopy, locateItem } from '../src/core/workspace/CollectionCommands.ts';
import { validWorkspaceResource } from '../src/core/models/WorkspaceValidation.ts';
import { isSensitiveField } from '../src/core/security/SensitiveFields.ts';
import { CredentialControls } from './credential-controls.js';

const element = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

const hasInlineCredentials = (value, sensitive = false) => {
  if (typeof value === 'string') return sensitive && Boolean(value) && !/^\{\{[^{}]+\}\}$/.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => hasInlineCredentials(child, sensitive || isSensitiveField(key) || (key === 'value' && (value.secret === true || (typeof value.key === 'string' && isSensitiveField(value.key))))));
};

// A request target means insert before it; a folder/collection means append.
export function authoringDropCommand(source, destination, itemId, targetKind, targetId) {
  const found = locateItem(source, itemId);
  if (!found) throw new Error('Dragged item no longer exists. Refresh and retry.');
  const target = targetKind === 'collection' ? null : locateItem(destination, targetId);
  if (targetKind !== 'collection' && !target) throw new Error('Drop target no longer exists. Refresh and retry.');
  const same = source.id === destination.id;
  if (same && found.item.id === target?.item.id) throw new Error('Choose a different drop target.');
  const parentId = targetKind === 'folder' ? target.item.id : target?.parentId;
  let index = targetKind === 'request' ? target.index : undefined;
  if (same && index !== undefined && found.parentId === parentId && found.index < index) index--;
  return { collectionId: source.id, itemId: found.item.id, action: same ? 'move' : 'crossMove', destinationCollectionId: destination.id, parentId, ...(index === undefined ? {} : { index }) };
}

/** Structural writes share collection save ownership with the request editor. */
export class WorkspaceAuthoring {
  constructor(options) { this.options = options; this.busy = false; }

  decorateRow(row, node) {
    const button = element('button', '⋯');
    button.type = 'button';
    button.className = 'icon-btn';
    const name = node.request?.name || node.item?.name || node.col.name;
    button.setAttribute('aria-label', `Actions for ${name}`);
    button.onclick = (event) => {
      event.stopPropagation();
      this.open(node.col.id, node.item?.id || node.request?.id);
    };
    row.append(button);
    row.title = `${row.title ? row.title + '. ' : ''}Drop on a request to insert before it, or on a folder/collection to append. Actions also supports keyboard move/reorder.`;
    if (node.kind !== 'collection') {
      row.draggable = true;
      row.ondragstart = (event) => {
        if (this.busy) { event.preventDefault(); return; }
        this.dragged = { collectionId: node.col.id, itemId: node.item?.id || node.request?.id, revision: node.col.revision };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-packetlark-workspace-item', JSON.stringify(this.dragged));
      };
      row.ondragend = () => { this.dragged = null; };
    }
    row.ondragover = (event) => { if (this.dragged && !this.busy) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } };
    row.ondrop = async (event) => {
      if (!this.dragged) return;
      event.preventDefault(); event.stopPropagation();
      const drag = this.dragged; this.dragged = null;
      try {
        const model = this.options.model(), source = model.collections.find((col) => col.id === drag.collectionId), target = model.collections.find((col) => col.id === node.col.id);
        if (!source || !target || source.revision !== drag.revision || target.revision !== node.col.revision) throw new Error('Workspace changed while dragging. Refresh and retry.');
        const command = authoringDropCommand(source, target, drag.itemId, node.kind, node.item?.id || node.request?.id);
        if (!confirm(`Move ${locateItem(source, drag.itemId).item.name} into ${target.name}? Drop on a request inserts before it; drop on a folder/collection appends. Unsaved drafts are retained if this cannot commit.`)) return;
        await this.execute(command);
      } catch (error) { alert(error.message); }
    };
  }

  async execute(command) {
    if (this.busy) throw new Error('An authoring operation is already pending.');
    this.options.syncFields?.();
    const model = this.options.model();
    const source = model.collections.find((col) => col.id === command.collectionId);
    const targetId = ['copyTo', 'crossMove'].includes(command.action) ? command.destinationCollectionId : source?.id;
    const target = model.collections.find((col) => col.id === targetId);
    if (command.action !== 'createCollection' && !source) throw new Error('Collection no longer exists. Reopen this dialog.');
    // Refuse overlapping saves rather than capturing a stale whole-collection snapshot.
    const affected = new Set([source?.id, targetId].filter(Boolean));
    if ([...affected].some((id) => model.collectionSaves?.has(id))) throw new Error('A collection save is pending. Wait for it to finish, then retry.');
    if ((model.drafts || []).some((draft) => affected.has(draft.collectionId) && (draft.dirty || draft.saving || draft.controller))) throw new Error('Save the affected collection’s unsaved drafts and wait for its executions before authoring. Your drafts are retained.');
    let next, method = 'PUT', path, base = target?.revision;
    const crossMove = command.action === 'crossMove';
    const movedRequestIds = [];
    if (crossMove) {
      const visit = (item) => { if (!item) return; if (item.request) movedRequestIds.push(item.request.id || item.id); for (const child of item.items || []) visit(child); };
      visit(locateItem(source, command.itemId)?.item);
    }
    if (command.action === 'createCollection' || command.action === 'duplicateCollection') {
      if (!command.name?.trim()) throw new Error('Name is required.');
      next = command.action === 'duplicateCollection'
        ? freshCollectionCopy(source)
        : { id: crypto.randomUUID(), schemaVersion: '1.0.0', variables: [], items: [] };
      next.name = command.name.trim();
      method = 'POST'; path = '/api/collections'; base = undefined;
    } else if (command.action === 'deleteCollection') {
      method = 'DELETE'; path = `/api/collections/${source.id}`; base = source.revision;
    } else if (crossMove) {
      if (!target || target.id === source.id) throw new Error('Choose a different destination collection. Use Move / reorder for this collection.');
      method = 'POST'; path = '/api/workspace/move';
      next = { sourceCollectionId: source.id, destinationCollectionId: target.id, sourceRevision: source.revision, destinationRevision: target.revision, itemId: command.itemId, destinationFolderId: command.parentId, ...(command.index === undefined ? {} : { index: command.index }) };
    } else if (command.action === 'copyTo') {
      if (!target) throw new Error('Destination collection no longer exists.');
      const found = locateItem(source, command.itemId);
      if (!found) throw new Error('Source item no longer exists.');
      next = structuredClone(target);
      const destination = command.parentId ? locateItem(next, command.parentId)?.item : next;
      if (!destination || (destination !== next && !destination.isFolder)) throw new Error('Destination must be a folder.');
      const copy = freshCollectionCopy(found.item);
      if (command.name?.trim()) { copy.name = command.name.trim(); if (copy.request) copy.request.name = copy.name; }
      (destination.items ||= []).push(copy);
      path = `/api/collections/${target.id}`;
    } else {
      next = applyAuthoringCommand(source, command);
      path = `/api/collections/${source.id}`;
    }
    if (next && !crossMove && !validWorkspaceResource(next, 'collections')) throw new Error('Invalid collection settings, identities or nesting depth.');
    this.busy = true;
    // Reserve immediately, before fetch yields; ordinary request saves queue after this task.
    let release;
    const reservation = new Promise((resolve) => { release = resolve; });
    for (const id of affected) model.collectionSaves?.set(id, reservation);
    try {
      const response = await (this.options.fetch || fetch)(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(base ? { 'If-Match': `"${base}"` } : {}) },
        ...(next ? { body: JSON.stringify(next) } : {}),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false || data.error) {
        const message = data.error?.message || (typeof data.error === 'string' ? data.error : 'Authoring write failed.');
        throw new Error(`${message}${response.status === 409 ? ' Review workspace changes, then retry. Form values and request drafts are retained.' : ''}`);
      }
      if (crossMove) {
        for (const collection of data.collections || []) {
          if (collection.id === source.id) this.options.commit(collection, source.revision, { atomicMove: true });
          else if (collection.id === target.id) this.options.commit(collection, target.revision, { atomicMove: true });
        }
        this.options.moved?.({ sourceCollectionId: source.id, destinationCollectionId: target.id, itemId: command.itemId, requestIds: movedRequestIds });
      } else if (method === 'DELETE') this.options.deleted?.(source.id);
      else this.options.commit(data.collection || data, base);
      return data.collection || data;
    } finally {
      this.busy = false;
      for (const id of affected) if (model.collectionSaves?.get(id) === reservation) model.collectionSaves.delete(id);
      release();
    }
  }

  open(collectionId, itemId) {
    this.options.syncFields?.();
    const body = document.getElementById('modal-body');
    document.getElementById('modal-title').textContent = 'Workspace authoring';
    document.getElementById('modal-footer').replaceChildren();
    body.replaceChildren();
    const form = element('form');
    form.dataset.workspaceAuthoring = '';
    const fields = {};
    const field = (label, input, value) => {
      const wrapper = element('label', label);
      wrapper.style.cssText = 'display:grid;gap:6px;margin:12px 0';
      input.setAttribute('aria-label', label);
      if (value !== undefined) input.value = value;
      wrapper.append(input); form.append(wrapper); fields[label] = input;
      return input;
    };
    const select = (label, entries, value) => {
      const input = element('select');
      for (const [id, name] of entries) { const option = element('option', name); option.value = id; input.append(option); }
      return field(label, input, value);
    };
    const collections = this.options.model().collections;
    const collectionSelect = select('Collection', [['', 'Choose collection'], ...collections.map((col) => [col.id, col.name])], collectionId || '');
    const collection = collections.find((col) => col.id === collectionSelect.value);
    const entries = [['', 'Collection itself']];
    const folders = [['', 'Collection root']];
    const visit = (items, path = '') => {
      for (const item of items || []) {
        const name = `${path}${item.name}`;
        entries.push([item.id, `${item.isFolder ? 'Folder' : 'Request'}: ${name}`]);
        if (item.isFolder) { folders.push([item.id, name]); visit(item.items, `${name} / `); }
      }
    };
    visit(collection?.items);
    const selected = itemId ? locateItem(collection || { items: [] }, itemId)?.item : null;
    const itemSelect = select('Item', entries, selected?.id || '');
    collectionSelect.onchange = () => this.open(collectionSelect.value);
    itemSelect.onchange = () => this.open(collectionSelect.value, itemSelect.value);
    const actions = [ ['createCollection', 'Create collection'], ...(collection ? [
      ['rename', 'Rename'], [selected ? 'duplicate' : 'duplicateCollection', 'Duplicate'],
      [selected ? 'delete' : 'deleteCollection', 'Delete'], ['createFolder', 'Create folder'], ['createRequest', 'Create request'],
      ...(!selected?.request ? [['settings', 'Edit inherited settings']] : []),
      ...(selected ? [['move', 'Move / reorder within collection'], ['crossMove', 'Move to another collection (manifest workspace)'], ['copyTo', 'Copy to another collection (fresh IDs)']] : []),
    ] : []) ];
    const action = select('Action', actions, collection ? 'rename' : 'createCollection');
    const name = field('Name', element('input'), selected?.name || collection?.name || 'New collection');
    const parent = select('Destination folder', folders, selected?.isFolder ? selected.id : '');
    const position = field('Position (zero based; blank appends)', element('input'), '');
    position.type = 'number'; position.min = '0'; position.step = '1';
    const destination = select('Destination collection', collections.map((col) => [col.id, col.name]), collectionId);
    destination.onchange = () => {
      const col = collections.find((col) => col.id === destination.value);
      parent.replaceChildren();
      const options = [['', 'Collection root']];
      const walk = (items, path = '') => { for (const item of items || []) if (item.isFolder) { options.push([item.id, path + item.name]); walk(item.items, path + item.name + ' / '); } };
      walk(col?.items);
      for (const [id, text] of options) { const option = element('option', text); option.value = id; parent.append(option); }
    };
    const target = selected || collection || {};
    const description = field('Description', element('textarea'), target.description || '');
    const parentRequest = { url: '', auth: structuredClone(target.auth || { type: 'inherit' }) };
    const authModes = [['inherit','Inherit'],['none','None'],['bearer','Bearer token'],['basic','Basic'],['apikey','API key'],['oauth2','OAuth 2.0']];
    if (!authModes.some(([type]) => type === parentRequest.auth.type)) authModes.push([parentRequest.auth.type, 'Preserved unsupported authorization — select a mode to replace']);
    const authType = select('Inherited auth type', authModes, parentRequest.auth.type);
    const authControls = element('section'); authControls.id = 'inherited-auth-controls'; form.append(authControls);
    const credentials = new CredentialControls({ getRequest: () => parentRequest, changed: () => {}, fetch: this.options.fetch || ((...args) => fetch(...args)) });
    const renderAuth = () => credentials.renderAuth(authControls);
    renderAuth();
    authType.onchange = () => { parentRequest.auth = { type: authType.value }; renderAuth(); };
    const variables = field('Inherited variables (JSON array)', element('textarea'), JSON.stringify(target.variables || [], null, 2));
    const sensitiveVariables = hasInlineCredentials({ variables: target.variables || [] });
    variables.hidden = sensitiveVariables;
    const disclosure = element('p', 'Inline authorization and inherited variable values are saved as plaintext in local workspace files and may remain in historical copies. Use credential references for secrets. Credential storage requires explicitly entered allowed origins; parent settings have no default destination.');
    disclosure.className = 'p2-note'; form.append(disclosure);
    const reveal = element('button', 'Reveal inherited variables'); reveal.type = 'button'; reveal.className = 'nav-btn'; variables.parentElement.after(reveal);
    reveal.hidden = !sensitiveVariables;
    reveal.onclick = () => { if (confirm('Reveal plaintext inherited variables? Secret values will be visible in the JSON editor.')) { variables.hidden = false; reveal.hidden = true; reveal.style.display = 'none'; } };
    const pre = field('Inherited pre-request script', element('textarea'), target.preRequestScript || '');
    const tests = field('Inherited test script', element('textarea'), target.testScript || '');
    for (const input of [variables, pre, tests]) { input.rows = 5; input.spellcheck = false; }
    const confirmed = field('Confirm deletion', element('input')); confirmed.type = 'checkbox';
    const message = element('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    message.textContent = 'Cross-collection Move requires a manifest workspace and commits both collections atomically. Move keeps IDs and uses a position in the destination after removal. Copy preserves the original and creates fresh IDs. Save affected request drafts first.';
    const show = () => {
      const choice = action.value;
      const visible = (input, value) => { input.parentElement.hidden = !value; input.parentElement.style.display = value ? 'grid' : 'none'; };
      visible(name, ['rename', 'duplicate', 'duplicateCollection', 'createCollection', 'createFolder', 'createRequest', 'copyTo'].includes(choice));
      visible(parent, ['createFolder', 'createRequest', 'duplicate', 'move', 'copyTo', 'crossMove'].includes(choice));
      visible(position, ['createFolder', 'createRequest', 'duplicate', 'move', 'crossMove'].includes(choice));
      visible(destination, ['copyTo', 'crossMove'].includes(choice));
      for (const input of [description, authType, variables, pre, tests]) visible(input, choice === 'settings');
      authControls.hidden = disclosure.hidden = choice !== 'settings';
      authControls.style.display = choice === 'settings' ? 'grid' : 'none';
      reveal.hidden = choice !== 'settings' || !variables.hidden;
      reveal.style.display = reveal.hidden ? 'none' : 'inline-flex';
      visible(confirmed, choice === 'delete' || choice === 'deleteCollection');
      if (!['copyTo', 'crossMove'].includes(choice)) {
        const previousParent = parent.value;
        parent.replaceChildren();
        for (const [id, text] of folders) { const option = element('option', text); option.value = id; parent.append(option); }
        if (folders.some(([id]) => id === previousParent)) parent.value = previousParent;
      }
    };
    action.onchange = show; show();
    const submit = element('button', 'Apply authoring action'); submit.type = 'submit'; submit.className = 'nav-btn';
    const close = element('button', 'Close'); close.type = 'button'; close.className = 'nav-btn'; close.onclick = () => this.options.closeModal();
    form.append(message, submit, close); body.append(form);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (this.busy) return;
      let success = false;
      try {
        if (['delete', 'deleteCollection'].includes(action.value) && !confirmed.checked) throw new Error('Check Confirm deletion before deleting.');
        const command = { collectionId: collectionSelect.value, itemId: itemSelect.value || undefined, action: action.value, name: name.value, parentId: parent.value || undefined, destinationCollectionId: destination.value };
        if (position.value !== '') command.index = Number(position.value);
        if (action.value === 'createFolder' || action.value === 'createRequest') { command.action = 'create'; command.kind = action.value === 'createFolder' ? 'folder' : 'request'; }
        if (action.value === 'settings') {
          const inheritedVariables = JSON.parse(variables.value);
          if (hasInlineCredentials({ auth: parentRequest.auth, variables: inheritedVariables }) && !confirm('Save inline inherited credentials or sensitive variable values as plaintext in this workspace? Historical copies may retain them. Cancel to replace them with credential references.')) return;
          command.settings = { description: description.value, auth: parentRequest.auth, variables: inheritedVariables, preRequestScript: pre.value, testScript: tests.value };
        }
        // Lock the form during commit, so its source ownership cannot change mid-flight.
        for (const input of form.elements) input.disabled = true;
        await this.execute(command);
        success = true;
        this.options.closeModal();
      } catch (error) { message.textContent = error.message; }
      finally { if (!success) for (const input of form.elements) input.disabled = false; }
    };
    this.options.openModal();
    collectionSelect.focus();
  }
}
