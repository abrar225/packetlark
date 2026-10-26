import { validWorkspaceResource } from '../models/WorkspaceValidation.js';

export interface AuthoringCommand {
  action: 'create' | 'rename' | 'duplicate' | 'delete' | 'move' | 'settings';
  itemId?: string;
  kind?: 'folder' | 'request';
  parentId?: string;
  index?: number;
  name?: string;
  settings?: Record<string, any>;
}

export function locateItem(collection: any, id: string): any {
  function visit(items: any[], parentId?: string): any {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.id === id || (!item.isFolder && item.request?.id === id))
        return { item, items, index, parentId };
      if (item.isFolder) {
        const found = visit(item.items || [], item.id);
        if (found) return found;
      }
    }
  }
  return visit(collection.items);
}

export function freshCollectionCopy(source: any, uuid = () => crypto.randomUUID()): any {
  const copy = structuredClone(source);
  const refresh = (item: any) => {
    item.id = uuid();
    if (item.request) item.request.id = uuid();
    if (item.items) item.items.forEach(refresh);
  };
  refresh(copy);
  delete copy.revision;
  return copy;
}

/** Pure, all-or-nothing structural command. Imported fields survive unchanged. */
export function applyAuthoringCommand(source: any, command: AuthoringCommand, uuid = () => crypto.randomUUID()): any {
  const collection = structuredClone(source);
  const found = command.itemId ? locateItem(collection, command.itemId) : null;
  if (command.itemId && !found) throw new Error('Item no longer exists. Reopen the authoring dialog.');
  const target = found?.item || collection;
  const name = () => {
    if (typeof command.name !== 'string' || !command.name.trim()) throw new Error('Name is required.');
    return command.name.trim();
  };
  const destination = () => {
    if (!command.parentId) return collection.items;
    const parent = locateItem(collection, command.parentId)?.item;
    if (!parent?.isFolder) throw new Error('Destination folder no longer exists.');
    return parent.items ||= [];
  };
  const insert = (items: any[], item: any) => {
    const index = command.index ?? items.length;
    if (!Number.isInteger(index) || index < 0 || index > items.length) throw new Error('Position is outside the destination folder.');
    items.splice(index, 0, item);
  };
  switch (command.action) {
    case 'create': {
      const item: any = { id: uuid(), name: name() };
      if (command.kind === 'folder') Object.assign(item, { isFolder: true, items: [] });
      else if (command.kind === 'request') item.request = { id: uuid(), name: item.name, method: 'GET', url: '', headers: [], queryParams: [], body: { mode: 'none' }, auth: { type: 'inherit' } };
      else throw new Error('Choose a folder or request.');
      insert(destination(), item);
      break;
    }
    case 'rename':
      target.name = name();
      if (target.request) target.request.name = target.name;
      break;
    case 'duplicate':
      if (!found) throw new Error('Use Duplicate collection for a collection.');
      { const copy = freshCollectionCopy(target, uuid); copy.name = name(); if (copy.request) copy.request.name = copy.name; insert(destination(), copy); }
      break;
    case 'delete':
      if (!found) throw new Error('Use Delete collection for a collection.');
      found.items.splice(found.index, 1);
      break;
    case 'move': {
      if (!found) throw new Error('Select an item to move.');
      const dest = destination();
      if (target.isFolder) {
        const subtree = { items: [target] };
        if (command.parentId && locateItem(subtree, command.parentId)) throw new Error('A folder cannot move into itself or its descendants.');
      }
      found.items.splice(found.index, 1);
      insert(dest, target);
      break;
    }
    case 'settings': {
      if (target.request) throw new Error('Use the request editor for request settings.');
      const allowed = ['auth', 'variables', 'preRequestScript', 'testScript', 'description'];
      for (const key of Object.keys(command.settings || {})) {
        if (!allowed.includes(key)) throw new Error('Unknown settings field.');
        target[key] = structuredClone(command.settings![key]);
      }
      break;
    }
    default: throw new Error('Unknown authoring action.');
  }
  if (!validWorkspaceResource(collection, 'collections')) throw new Error('Invalid collection: check identities, settings, maximum nesting depth (24) and item count (10,000).');
  return collection;
}
