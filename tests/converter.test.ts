import { describe, it, expect } from 'vitest';
import { PostmanConverter } from '../src/core/models/PostmanConverter.js';
import { ApiCollection } from '../src/core/models/types.js';

describe('PostmanConverter', () => {
  it('converts Postman Collection v2.1.0 to ApiCollection and back losslessly', () => {
    const rawPostman = {
      info: {
        _postman_id: 'col_123',
        name: 'Test Collection',
        description: 'Test Description',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: [
        {
          id: 'item_1',
          name: 'Get User',
          request: {
            method: 'GET',
            url: {
              raw: 'https://api.example.com/users/42',
              query: [{ key: 'active', value: 'true' }]
            },
            header: [{ key: 'Accept', value: 'application/json' }],
            auth: {
              type: 'bearer',
              bearer: [{ key: 'token', value: 'secret-token' }]
            }
          }
        }
      ],
      variable: [{ key: 'baseUrl', value: 'https://api.example.com' }]
    };

    const col = PostmanConverter.fromPostman(rawPostman);
    expect(col.name).toBe('Test Collection');
    expect(col.items.length).toBe(1);
    expect(col.items[0].request?.method).toBe('GET');
    expect(col.items[0].request?.auth.type).toBe('bearer');
    expect(col.items[0].request?.auth.bearerToken).toBe('secret-token');

    // Convert back
    const reconverted = PostmanConverter.toPostman(col);
    expect(reconverted.info.name).toBe('Test Collection');
    expect(reconverted.item[0].request.method).toBe('GET');
    expect(reconverted.item[0].request.auth.bearer[0].value).toBe('secret-token');
  });

  it('preserves nested folders and sub-items across import/export', () => {
    const nestedPostman = {
      info: { name: 'Nested Tree Collection' },
      item: [
        {
          name: 'Auth Folder',
          item: [
            {
              name: 'Login Request',
              request: {
                method: 'POST',
                url: 'https://api.example.com/login',
                body: {
                  mode: 'urlencoded',
                  urlencoded: [{ key: 'username', value: 'alice' }]
                }
              }
            }
          ]
        }
      ]
    };

    const col = PostmanConverter.fromPostman(nestedPostman);
    expect(col.items.length).toBe(1);
    expect(col.items[0].isFolder).toBe(true);
    expect(col.items[0].items?.length).toBe(1);
    expect(col.items[0].items?.[0].request?.method).toBe('POST');
    expect(col.items[0].items?.[0].request?.body.mode).toBe('x-www-form-urlencoded');

    const exported = PostmanConverter.toPostman(col);
    expect(exported.item[0].item[0].request.method).toBe('POST');
    expect(exported.item[0].item[0].request.body.mode).toBe('urlencoded');
  });

  it('converts API Key auth round-trip properly', () => {
    const rawPostman = {
      info: { name: 'API Key Test' },
      item: [
        {
          name: 'Protected Resource',
          request: {
            method: 'GET',
            url: 'https://api.example.com/data',
            auth: {
              type: 'apikey',
              apikey: [
                { key: 'key', value: 'X-App-Token' },
                { key: 'value', value: 'secret-987' },
                { key: 'in', value: 'header' }
              ]
            }
          }
        }
      ]
    };

    const col = PostmanConverter.fromPostman(rawPostman);
    expect(col.items[0].request?.auth.type).toBe('apikey');
    expect(col.items[0].request?.auth.apiKeyName).toBe('X-App-Token');
    expect(col.items[0].request?.auth.apiKeyValue).toBe('secret-987');

    const exported = PostmanConverter.toPostman(col);
    expect(exported.item[0].request.auth.type).toBe('apikey');
  });

  it('parses cURL commands accurately including multi-line escaping and custom headers', () => {
    const curl = `curl -X POST "https://api.example.com/login" \\\n  -H "Content-Type: application/json" \\\n  -H "X-Client: test" \\\n  -d '{"username":"admin"}'`;
    const req = PostmanConverter.fromCurl(curl);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/login');
    expect(req.headers.find(h => h.key === 'Content-Type')?.value).toBe('application/json');
    expect(req.headers.find(h => h.key === 'X-Client')?.value).toBe('test');
    expect(req.body.mode).toBe('raw-json');
    expect(req.body.raw).toBe('{"username":"admin"}');
  });
});
