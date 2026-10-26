import { describe, it, expect } from 'vitest';
import { applyAuthoringCommand, freshCollectionCopy, locateItem } from '../src/core/workspace/CollectionCommands.js';
import { WorkspaceAuthoring, authoringDropCommand } from '../web/workspace-authoring.js';
import { collectionRequests } from '../src/core/models/CollectionContext.js';
const fixture = () => ({ id: 'collection', name: 'Collection', schemaVersion: '1.0.0', revision: 'r1', variables: [], postman: { opaque: ['preserved'] }, items: [
  { id: 'folder', name: 'Folder', isFolder: true, items: [{ id: 'item', name: 'Request', request: { id: 'req', name: 'Request', method: 'GET', url: 'http://example.test', headers: [], queryParams: [], body: { mode: 'none' }, auth: { type: 'inherit' }, postman: { opaque: 'value' } } }] },
  { id: 'other', name: 'Other', isFolder: true, items: [] },
] });
const ids = () => { let n = 0; return () => `fresh_${++n}`; };

describe('identity safe authoring commands', () => {
  it('maps drag targets to stable moves, correcting sibling positions after removal', () => {
    const source = fixture();
    const beforeOther = authoringDropCommand(source, source, 'folder', 'request', 'other');
    expect(applyAuthoringCommand(source, beforeOther).items.map((item) => item.id)).toEqual(['folder', 'other']);
    const moved = applyAuthoringCommand(source, authoringDropCommand(source, source, 'req', 'folder', 'other'));
    expect(moved.items[1].items[0]).toEqual(source.items[0].items[0]);
    const destination = { ...fixture(), id: 'destination' };
    expect(authoringDropCommand(source, destination, 'req', 'collection')).toMatchObject({ action: 'crossMove', itemId: 'item', destinationCollectionId: 'destination' });
    expect(() => authoringDropCommand(source, source, 'folder', 'folder', 'folder')).toThrow(/different/);
    expect(() => authoringDropCommand(source, source, 'gone', 'collection')).toThrow(/no longer/);
  });
  it('creates request inside folder with inherited auth and stable sibling identities', () => {
    const source = fixture();
    const result = applyAuthoringCommand(source, { action: 'create', kind: 'request', name: 'New', parentId: 'folder', index: 0 }, ids());
    expect(result.items[0].items[0].request.auth.type).toBe('inherit');
    expect(result.items[0].items[1]).toEqual(source.items[0].items[0]);
    expect(source.items[0].items).toHaveLength(1);
  });
  it('renames both request labels without changing IDs or opaque content', () => {
    const result = applyAuthoringCommand(fixture(), { action: 'rename', itemId: 'req', name: 'Renamed' });
    expect(locateItem(result, 'req').item).toMatchObject({ id: 'item', name: 'Renamed', request: { id: 'req', name: 'Renamed', postman: { opaque: 'value' } } });
  });
  it('duplicates nested identities and retains metadata independently', () => {
    const original = fixture();
    const copy = freshCollectionCopy(original, ids());
    expect(copy.id).not.toBe(original.id);
    expect(copy.items[0].id).not.toBe(original.items[0].id);
    expect(copy.items[0].items[0].request.id).not.toBe('req');
    expect(copy.revision).toBeUndefined();
    expect(copy.postman).toEqual(original.postman);
    copy.postman.opaque.push('copy');
    expect(original.postman.opaque).toEqual(['preserved']);
  });
  it('moves requests and folders while preserving exact identity and content', () => {
    const source = fixture();
    const result = applyAuthoringCommand(source, { action: 'move', itemId: 'req', parentId: 'other', index: 0 });
    expect(result.items[0].items).toEqual([]);
    expect(result.items[1].items[0]).toEqual(source.items[0].items[0]);
    const reordered = applyAuthoringCommand(result, { action: 'move', itemId: 'other', index: 0 });
    expect(reordered.items.map((item) => item.id)).toEqual(['other', 'folder']);
  });
  it('rejects cycles, invalid position, identity collisions and excessive depth without mutation', () => {
    const source = fixture(); const before = structuredClone(source);
    expect(() => applyAuthoringCommand(source, { action: 'move', itemId: 'folder', parentId: 'folder' })).toThrow(/itself/);
    expect(() => applyAuthoringCommand(source, { action: 'move', itemId: 'req', index: 99 })).toThrow(/Position/);
    expect(() => applyAuthoringCommand(source, { action: 'duplicate', itemId: 'folder', name: 'Copy' }, () => 'folder')).toThrow(/Invalid/);
    let parent: any = source.items[1];
    for (let n = 0; n < 23; n++) { const child = { id: `deep_${n}`, name: 'Deep', isFolder: true, items: [] }; parent.items = [child]; parent = child; }
    expect(() => applyAuthoringCommand(source, { action: 'move', itemId: 'folder', parentId: parent.id })).toThrow(/depth/);
    source.items[1] = before.items[1];
    expect(source).toEqual(before);
  });
  it('edits inherited settings used by actual execution context resolution', () => {
    const result = applyAuthoringCommand(fixture(), { action: 'settings', itemId: 'folder', settings: { auth: { type: 'bearer', bearerToken: 'secret' }, variables: [{ key: 'host', value: 'example.test' }], preRequestScript: 'console.log("folder")', testScript: 'pm.test("inherited",()=>{});' } });
    const resolved = collectionRequests(result as any)[0];
    expect(resolved.request.auth).toEqual({ type: 'bearer', bearerToken: 'secret' });
    expect(resolved.variables).toEqual([{ key: 'host', value: 'example.test' }]);
    expect(resolved.request.preRequestScripts).toEqual(['console.log("folder")']);
    expect(resolved.request.testScripts).toEqual(['pm.test("inherited",()=>{});']);
  });
});

describe('conditional authoring ownership', () => {
  const setup = (fetcher: any) => {
    const model: any = { collections: [fixture()], drafts: [], collectionSaves: new Map() };
    const commits: any[] = []; const deleted: string[] = [];
    const author = new WorkspaceAuthoring({ model: () => model, fetch: fetcher, commit: (...args) => commits.push(args), deleted: (id) => deleted.push(id) });
    return { model, commits, deleted, author };
  };
  it('sends revision and reserves collection while pending, retains newer drafts', async () => {
    let finish: any; let options: any;
    const { author, model, commits } = setup((_url, init) => { options = init; return new Promise((resolve) => { finish = resolve; }); });
    const task = author.execute({ collectionId: 'collection', action: 'rename', name: 'Changed' });
    expect(model.collectionSaves.has('collection')).toBe(true);
    expect(options.headers['If-Match']).toBe('"r1"');
    const newer = { collectionId: 'collection', request: { id: 'req', url: 'new edit' }, dirty: true }; model.drafts.push(newer);
    finish({ ok: true, json: async () => ({ ...fixture(), name: 'Changed', revision: 'r2' }) });
    await task;
    expect(commits[0][1]).toBe('r1');
    expect(model.drafts[0]).toBe(newer);
    expect(model.collectionSaves.size).toBe(0);
  });
  it('rejects affected dirty or saving requests and overlapping saves without transport', async () => {
    let calls = 0; const { author, model } = setup(() => { calls++; });
    model.drafts.push({ collectionId: 'collection', dirty: true });
    await expect(author.execute({ collectionId: 'collection', action: 'deleteCollection' })).rejects.toThrow(/drafts/);
    model.drafts = []; model.collectionSaves.set('collection', Promise.resolve());
    await expect(author.execute({ collectionId: 'collection', action: 'rename', name: 'Name' })).rejects.toThrow(/pending/);
    expect(calls).toBe(0);
  });
  it('retains model and drafts on conflict and failed writes', async () => {
    const { author, model, commits } = setup(async () => ({ ok: false, status: 409, json: async () => ({ error: { message: 'Revision conflict' } }) }));
    const before = structuredClone(model.collections);
    await expect(author.execute({ collectionId: 'collection', action: 'rename', name: 'Changed' })).rejects.toThrow(/retained/);
    expect(model.collections).toEqual(before); expect(commits).toEqual([]); expect(model.collectionSaves.size).toBe(0);
  });
  it('copies between collections with fresh IDs and keeps source unchanged', async () => {
    let written: any; const { author, model, commits } = setup(async (_url, init) => { written = JSON.parse(init.body); return { ok: true, json: async () => ({ ...written, revision: 'next' }) }; });
    model.collections.push({ ...fixture(), id: 'destination', items: [] });
    const before = structuredClone(model.collections[0]);
    await author.execute({ collectionId: 'collection', action: 'copyTo', itemId: 'folder', destinationCollectionId: 'destination' });
    expect(model.collections[0]).toEqual(before);
    expect(written.items[0].id).not.toBe('folder');
    expect(written.items[0].items[0].request.id).not.toBe('req');
    expect(commits[0][0].id).toBe('destination');
  });
  it('atomically moves across collections with both reviewed revisions and retains failed form ownership', async () => {
    let options: any; let path: string;
    const { author, model, commits } = setup(async (url, init) => { path = url; options = init; return { ok: true, json: async () => ({ collections: [{ ...fixture(), revision: 'source-next', items: [] }, { ...fixture(), id: 'destination', revision: 'dest-next' }] }) }; });
    model.collections.push({ ...fixture(), id: 'destination', revision: 'dest-base', items: [] });
    await author.execute({ collectionId: 'collection', action: 'crossMove', itemId: 'folder', destinationCollectionId: 'destination', index: 0 });
    expect(path!).toBe('/api/workspace/move');
    expect(JSON.parse(options.body)).toMatchObject({ sourceCollectionId: 'collection', destinationCollectionId: 'destination', sourceRevision: 'r1', destinationRevision: 'dest-base', itemId: 'folder', index: 0 });
    expect(commits.map((args) => [args[0].id, args[1]])).toEqual([['collection', 'r1'], ['destination', 'dest-base']]);
    expect(model.collectionSaves.size).toBe(0);
  });

});
