import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceRepository } from '../src/core/workspace/WorkspaceRepository.js';
import { StudioServer } from '../src/server/StudioServer.js';
import { VariableResolver } from '../src/core/engine/VariableResolver.js';
import { collectionRequests } from '../src/core/models/CollectionContext.js';
import { comparePostmanSemantics, reportPostmanImport } from '../src/core/models/ImportDiagnostics.js';
import { PostmanConverter } from '../src/core/models/PostmanConverter.js';
const fixture = (name = 'nested-v21.json') => JSON.parse(fs.readFileSync(new URL('./fixtures/imports/' + name, import.meta.url), 'utf8'));
const request = (value: any) => value.item[0].item[0].item[0].request;
describe('sanitized import corpus', () => {
  it('retains disabled events, examples, body row metadata and URL path variables on public roundtrip', () => {
    const source = fixture();
    const exported = PostmanConverter.toPostman(PostmanConverter.fromPostman(source));
    expect(exported.event).toEqual(source.event);
    expect(request(exported).url.variable).toEqual(request(source).url.variable);
    expect(request(exported).body).toEqual(request(source).body);
    expect(exported.item[0].item[0].item[0].response).toEqual(source.item[0].item[0].item[0].response);
  });
});

describe('import compatibility reports and runtime boundaries', () => {
  for (const name of ['nested-v21.json', 'unsupported-v21.json']) {
    it(`reports semantic preservation for ${name}`, () => {
      const { collection, report } = reportPostmanImport(fixture(name));
      expect(report.preserved).toBe(true);
      expect(report.differences).toEqual([]);
      if (name === 'unsupported-v21.json') {
        expect(report.requestCount).toBe(3);
        expect(report.warnings.join(' ')).toMatch(/oauth2.*execution is blocked/);
        expect(report.warnings.join(' ')).toMatch(/unsupported formdata/);
        expect(collection.items[0].request!.body.mode).toBe('unsupported');
        expect(collection.items[1].request!.body.mode).toBe('unsupported');
      }
    });
  }
  it('resolves inherited auth, variables and event order without activating disabled scripts', () => {
    const collection = PostmanConverter.fromPostman(fixture());
    const [resolved] = collectionRequests(collection);
    expect(resolved.request.auth).toMatchObject({type:'basic', basicUsername:'fixture-user'});
    expect(resolved.path).toEqual(['Sanitized nested corpus', 'Outer', 'Inner', 'Repeated rows and example']);
    expect(resolved.variables.find((row) => row.key === 'base')!.value).toBe('https://folder.invalid');
    expect(resolved.request.preRequestScripts).toEqual(["pm.variables.set('scope', 'collection');", "pm.variables.set('scope', 'outer');"]);
    expect(resolved.request.testScripts).toEqual([]);
    expect(resolved.request.queryParams.map(({key,value,enabled}) => [key,value,enabled])).toEqual([['tag','one',true],['tag','two',true],['tag','off',false]]);
    expect(resolved.request.headers.map(({value,enabled}) => [value,enabled])).toEqual([['one',true],['two',true],['disabled',false]]);
  });
  it('detects actual example, metadata and disabled row loss without putting values in diagnostics', () => {
    const before = fixture();
    const after = structuredClone(before);
    delete request(after).body['x-body'];
    request(after).header[2].disabled = false;
    after.item[0].item[0].item[0].response[0].body = 'sensitive-value';
    const differences = comparePostmanSemantics(before, after);
    expect(differences).toEqual(expect.arrayContaining([
      {path:'/item/0/item/0/item/0/request/body/x-body', kind:'removed'},
      {path:'/item/0/item/0/item/0/request/header/2/disabled', kind:'changed'},
      {path:'/item/0/item/0/item/0/response/0/body', kind:'changed'},
    ]));
    expect(JSON.stringify(differences)).not.toContain('sensitive-value');
  });
  it('exports edited row values while retaining original metadata and disabled events', () => {
    const collection = PostmanConverter.fromPostman(fixture());
    const req = collection.items[0].items![0].items![0].request!;
    req.headers[0].value = 'edited';
    collection.preRequestScript = 'console.log("edited")';
    const result = PostmanConverter.toPostman(collection);
    expect(request(result).header[0]).toMatchObject({value:'edited', 'x-row':1});
    expect(result.event.find((event: any) => event.disabled)).toEqual(fixture().event[1]);
    expect(result.event.find((event: any) => event.listen === 'prerequest').script.exec).toEqual(['console.log("edited")']);
  });
  it.each(['https://schema.getpostman.com/json/collection/v2.0.0/collection.json', 'https://untrusted.invalid/v2.1.0/collection.json', 42])('rejects unsupported or invalid schema %s', (schema) => {
    expect(() => PostmanConverter.fromPostman({info:{schema},item:[]})).toThrow(/Only Postman Collection v2.1/);
  });
  for (const entry of fixture('curl-cases.json')) {
    it(`cURL: ${entry.name}`, () => {
      if (entry.error) { expect(() => PostmanConverter.fromCurl(entry.command)).toThrow(entry.error); return; }
      const req = PostmanConverter.fromCurl(entry.command);
      expect(req.method).toBe(entry.method);
      if (entry.url) expect(req.url).toBe(entry.url);
      if (entry.body !== undefined) expect(req.body.raw).toBe(entry.body);
      if (entry.headers) expect(req.headers.map((row) => [row.key,row.value])).toEqual(entry.headers);
      if (entry.name === 'json defaults') expect(req.headers).toEqual(expect.arrayContaining([{key:'Accept',value:'application/json',enabled:true}]));
      const exported = PostmanConverter.toPostman({id:'curl',name:'curl',schemaVersion:'2.1.0',variables:[],items:[{id:'curl_request',name:'curl',request:req}]});
      const restored = PostmanConverter.fromPostman(exported).items[0].request!;
      if (req.body.mode === 'x-www-form-urlencoded') expect(restored.body.formData!.map((row) => [row.key,row.value])).toEqual([['tag','one'],['tag','two'],['blank','']]);
      else if (entry.body !== undefined) expect(restored.body.raw).toBe(entry.body);
    });
  }
  it.each([false, true])('preserves corpus through public import, durable restart and public export (migration=%s)', async (migrate) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'packetlark-import-corpus-'));
    let server: StudioServer | undefined;
    try {
      server = new StudioServer(0, 0, root);
      let port = await server.start();
      for (const name of ['nested-v21.json','unsupported-v21.json']) {
        const response = await fetch(`http://127.0.0.1:${port}/api/import/postman`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixture(name))});
        expect(response.status).toBe(200);
        expect((await response.json()).id).toBe(fixture(name).info._postman_id);
      }
      await server.stop();
      if (migrate) {
        const repository = new WorkspaceRepository(root);
        try { repository.migrate(repository.migrationPlan().checksum); } finally { repository.close(); }
      }
      server = new StudioServer(0, 0, root);
      port = await server.start();
      for (const name of ['nested-v21.json','unsupported-v21.json']) {
        const source = fixture(name);
        const response = await fetch(`http://127.0.0.1:${port}/api/collections/${source.info._postman_id}/export/postman?includeSecrets=true&consent=plaintext`);
        expect(response.status).toBe(200);
        const exported = await response.json();
        expect(exported.info._postman_id).toBe(source.info._postman_id);
        expect(comparePostmanSemantics(source, exported)).toEqual([]);
      }
    } finally {
      await server?.stop();
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
});

describe('additional preservation boundaries', () => {
  it('retains unknown and duplicate authentication attributes without changing provided IDs', () => {
    const source = fixture();
    source.auth.bearer.push({key:'token',value:'second-token'}, {key:'x-extension',value:'opaque'});
    const exported = PostmanConverter.toPostman(PostmanConverter.fromPostman(source));
    expect(exported.auth).toEqual(source.auth);
    expect(exported.item[0].id).toBe('outer');
    expect(exported.item[0].item[0].id).toBe('inner');
    expect(exported.item[0].item[0].item[0].id).toBe('request_example');
  });
  it('keeps a disabled Postman body inactive and preserves its payload for export', () => {
    const source = fixture('unsupported-v21.json');
    source.item[2].request.body.disabled = true;
    const collection = PostmanConverter.fromPostman(source);
    expect(collection.items[2].request!.body.mode).toBe('none');
    expect(PostmanConverter.toPostman(collection).item[2].request.body).toEqual(source.item[2].request.body);
  });
  it('reports structured/raw query disagreements instead of silently choosing', () => {
    const source = fixture();
    request(source).url.raw = 'https://fixture.invalid/:id?tag=wrong#section';
    const {collection, report} = reportPostmanImport(source);
    expect(report.warnings.join(' ')).toMatch(/structured query parameters take precedence/);
    expect(collection.items[0].items![0].items![0].request!.queryParams[0].value).toBe('one');
  });
  it('rejects invalid top-level collections and unsupported request methods explicitly', () => {
    expect(() => PostmanConverter.fromPostman({openapi:'3.1.0'})).toThrow(/Expected a Postman v2.1/);
    expect(() => PostmanConverter.fromPostman({item:[null]})).toThrow(/items must be objects/);
    const source = fixture();
    request(source).method = 'TRACE';
    expect(() => PostmanConverter.fromPostman(source)).toThrow(/unsupported HTTP method TRACE/);
  });
});

describe('disabled variable inheritance', () => {
  it('keeps the enabled duplicate and active ancestor when disabled rows occur later', () => {
    const source = fixture();
    source.item[0].variable.push({key:'repeat',value:'disabled-folder',disabled:true});
    const [resolved] = collectionRequests(PostmanConverter.fromPostman(source));
    expect(VariableResolver.buildContext(resolved.variables)).toMatchObject({base:'https://folder.invalid', repeat:'one'});
    const exported = PostmanConverter.toPostman(PostmanConverter.fromPostman(source));
    expect(exported.variable).toEqual(source.variable);
    expect(exported.item[0].variable).toEqual(source.item[0].variable);
  });
});
