import { describe, expect, it } from 'vitest';
import { PostmanConverter } from '../src/core/models/PostmanConverter.js';
import type { ApiCollection, HttpRequest } from '../src/core/models/types.js';

const request = (): HttpRequest => ({ method: 'POST', url: 'https://fixture.invalid/upload', headers: [], queryParams: [], body: { mode: 'none' }, auth: { type: 'none' } });
const collection = (req: HttpRequest): ApiCollection => ({ id: 'export-fixture', name: 'Export fixture', schemaVersion: '2.1.0', variables: [], items: [{ id: 'request', name: 'Upload', request: req }] });

describe('explicit Postman export capability limits', () => {
  it('rejects selected binary files without silently dropping the body or exposing the selection ID', () => {
    const req = request(); req.body = { mode: 'binary', fileId: 'PRIVATE-SELECTION-ID' };
    expect(() => PostmanConverter.toPostman(collection(req))).toThrow(/selected upload files/);
    try { PostmanConverter.toPostman(collection(req)); } catch (error) { expect(String(error)).not.toContain(req.body.fileId); }
    expect(req.body.fileId).toBe('PRIVATE-SELECTION-ID');
  });
  it.each([true, false])('rejects multipart selected file rows, including disabled rows (enabled=%s)', enabled => {
    const req = request(); req.body = { mode: 'form-data', formData: [{ key: 'upload', value: '', fileId: 'PRIVATE-SELECTION-ID', enabled }] };
    expect(() => PostmanConverter.toPostman(collection(req))).toThrow(/select the files separately/);
  });
  it.each([
    { mode: 'file', file: { src: '/inert/original.bin' }, 'x-opaque': 'keep' },
    { mode: 'formdata', formdata: [{ key: 'upload', type: 'file', src: ['/inert/original.bin'], 'x-row': 1 }] },
  ])('preserves imported unsupported file metadata without authorizing file access', body => {
    const source = { info: { name: 'Original' }, item: [{ name: 'Upload', request: { method: 'POST', url: 'https://fixture.invalid/upload', body } }] };
    const imported = PostmanConverter.fromPostman(source);
    expect(imported.items[0].request!.body.mode).toBe('unsupported');
    expect(PostmanConverter.toPostman(imported).item[0].request.body).toEqual(body);
  });
  it.each([{ ca: 'PUBLIC-CA' }, { cert: 'PUBLIC-CERT', keyRef: '{{secret:PRIVATE-ID}}' }])('rejects TLS configuration with actionable value-free errors', tls => {
    const req = request(); req.tls = tls;
    expect(() => PostmanConverter.toPostman(collection(req))).toThrow(/configure CA\/client certificates separately/);
    try { PostmanConverter.toPostman(collection(req)); } catch (error) { expect(String(error)).not.toContain(Object.values(tls)[0]); }
  });
  it('rejects local OAuth connection references while preserving imported opaque OAuth settings', () => {
    const req = request(); req.auth = { type: 'oauth2', oauthConnectionId: 'PRIVATE-CONNECTION-ID' };
    expect(() => PostmanConverter.toPostman(collection(req))).toThrow(/configure OAuth separately/);
    const source = { info: { name: 'Original OAuth' }, auth: { type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'authorization_code' }] }, item: [] };
    expect(PostmanConverter.toPostman(PostmanConverter.fromPostman(source)).auth).toEqual(source.auth);
  });
});
