import { ApiCollection, CollectionItem, HttpRequest, HttpMethod, KeyValueParam, AuthConfig, RequestBody } from './types.js';

export class PostmanConverter {
  /**
   * Converts a Postman Collection v2.1.0 JSON object to an ApiCollection.
   */
  public static fromPostman(postmanJson: any): ApiCollection {
    const info = postmanJson.info || {};
    const variables: KeyValueParam[] = (postmanJson.variable || []).map((v: any) => ({
      key: v.key || '',
      value: v.value || '',
      enabled: v.disabled !== true,
      description: v.description
    }));

    const items: CollectionItem[] = (postmanJson.item || []).map((item: any) => this.convertItem(item));

    return {
      id: info._postman_id || info.id || crypto.randomUUID(),
      name: info.name || 'Imported Collection',
      description: typeof info.description === 'string' ? info.description : info.description?.content || '',
      schemaVersion: '2.1.0',
      variables,
      items
    };
  }

  private static convertItem(item: any): CollectionItem {
    const isFolder = Array.isArray(item.item) && !item.request;
    const id = item.id || crypto.randomUUID();
    const name = item.name || 'Untitled';

    if (isFolder) {
      return {
        id,
        name,
        description: item.description,
        isFolder: true,
        items: item.item.map((child: any) => this.convertItem(child))
      };
    }

    const req = item.request || {};
    let method: HttpMethod = (req.method || 'GET').toUpperCase() as HttpMethod;
    let urlRaw = typeof req.url === 'string' ? req.url : req.url?.raw || '';

    const headers: KeyValueParam[] = (req.header || []).map((h: any) => ({
      key: h.key || '',
      value: h.value || '',
      enabled: h.disabled !== true,
      description: h.description
    }));

    const queryParams: KeyValueParam[] = (req.url?.query || []).map((q: any) => ({
      key: q.key || '',
      value: q.value || '',
      enabled: q.disabled !== true,
      description: q.description
    }));

    // Body
    const body: RequestBody = { mode: 'none' };
    if (req.body) {
      if (req.body.mode === 'raw') {
        body.mode = 'raw-json';
        body.raw = req.body.raw || '';
      } else if (req.body.mode === 'urlencoded') {
        body.mode = 'x-www-form-urlencoded';
        body.formData = (req.body.urlencoded || []).map((p: any) => ({
          key: p.key || '',
          value: p.value || '',
          enabled: p.disabled !== true
        }));
      } else if (req.body.mode === 'formdata') {
        body.mode = 'form-data';
        body.formData = (req.body.formdata || []).map((p: any) => ({
          key: p.key || '',
          value: p.value || '',
          enabled: p.disabled !== true
        }));
      }
    }

    // Auth
    const auth: AuthConfig = { type: 'none' };
    if (req.auth) {
      if (req.auth.type === 'bearer') {
        auth.type = 'bearer';
        const bearerParam = (req.auth.bearer || []).find((b: any) => b.key === 'token');
        auth.bearerToken = bearerParam ? bearerParam.value : '';
      } else if (req.auth.type === 'basic') {
        auth.type = 'basic';
        const u = (req.auth.basic || []).find((b: any) => b.key === 'username');
        const p = (req.auth.basic || []).find((b: any) => b.key === 'password');
        auth.basicUsername = u ? u.value : '';
        auth.basicPassword = p ? p.value : '';
      } else if (req.auth.type === 'apikey') {
        auth.type = 'apikey';
        const k = (req.auth.apikey || []).find((b: any) => b.key === 'key');
        const v = (req.auth.apikey || []).find((b: any) => b.key === 'value');
        const where = (req.auth.apikey || []).find((b: any) => b.key === 'in');
        auth.apiKeyName = k ? k.value : '';
        auth.apiKeyValue = v ? v.value : '';
        auth.apiKeyIn = where?.value === 'query' ? 'query' : 'header';
      }
    }

    // Scripts
    let preRequestScript: string | undefined;
    let testScript: string | undefined;
    if (Array.isArray(item.event)) {
      for (const ev of item.event) {
        if (ev.listen === 'prerequest' && ev.script?.exec) {
          preRequestScript = Array.isArray(ev.script.exec) ? ev.script.exec.join('\n') : ev.script.exec;
        } else if (ev.listen === 'test' && ev.script?.exec) {
          testScript = Array.isArray(ev.script.exec) ? ev.script.exec.join('\n') : ev.script.exec;
        }
      }
    }

    const httpRequest: HttpRequest = {
      id,
      name,
      method,
      url: urlRaw,
      headers,
      queryParams,
      body,
      auth,
      preRequestScript,
      testScript
    };

    return {
      id,
      name,
      isFolder: false,
      request: httpRequest
    };
  }

  /**
   * Converts an ApiCollection back to Postman Collection v2.1.0 format.
   */
  public static toPostman(collection: ApiCollection): any {
    return {
      info: {
        _postman_id: collection.id,
        name: collection.name,
        description: collection.description || '',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: collection.items.map(item => this.convertItemToPostman(item)),
      variable: (collection.variables || []).map(v => ({
        key: v.key,
        value: v.value,
        type: 'string',
        disabled: v.enabled === false
      }))
    };
  }

  private static convertItemToPostman(item: CollectionItem): any {
    if (item.isFolder && item.items) {
      return {
        name: item.name,
        item: item.items.map(child => this.convertItemToPostman(child))
      };
    }

    const req = item.request || {
      method: 'GET',
      url: '',
      headers: [],
      queryParams: [],
      body: { mode: 'none' },
      auth: { type: 'none' }
    };

    const events: any[] = [];
    if (req.preRequestScript) {
      events.push({
        listen: 'prerequest',
        script: {
          type: 'text/javascript',
          exec: req.preRequestScript.split('\n')
        }
      });
    }
    if (req.testScript) {
      events.push({
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: req.testScript.split('\n')
        }
      });
    }

    let postmanBody: any;
    if (req.body.mode === 'raw-json' || req.body.mode === 'raw-text') {
      postmanBody = {
        mode: 'raw',
        raw: req.body.raw || '',
        options: {
          raw: {
            language: req.body.mode === 'raw-json' ? 'json' : 'text'
          }
        }
      };
    } else if (req.body.mode === 'x-www-form-urlencoded') {
      postmanBody = {
        mode: 'urlencoded',
        urlencoded: (req.body.formData || []).map(p => ({
          key: p.key,
          value: p.value,
          disabled: p.enabled === false
        }))
      };
    } else if (req.body.mode === 'form-data') {
      postmanBody = {
        mode: 'formdata',
        formdata: (req.body.formData || []).map(p => ({
          key: p.key,
          value: p.value,
          disabled: p.enabled === false
        }))
      };
    }

    let postmanAuth: any;
    if (req.auth.type === 'bearer') {
      postmanAuth = {
        type: 'bearer',
        bearer: [{ key: 'token', value: req.auth.bearerToken || '', type: 'string' }]
      };
    } else if (req.auth.type === 'basic') {
      postmanAuth = {
        type: 'basic',
        basic: [
          { key: 'username', value: req.auth.basicUsername || '', type: 'string' },
          { key: 'password', value: req.auth.basicPassword || '', type: 'string' }
        ]
      };
    } else if (req.auth.type === 'apikey') {
      postmanAuth = {
        type: 'apikey',
        apikey: [
          { key: 'key', value: req.auth.apiKeyName || '', type: 'string' },
          { key: 'value', value: req.auth.apiKeyValue || '', type: 'string' },
          { key: 'in', value: req.auth.apiKeyIn || 'header', type: 'string' }
        ]
      };
    }

    return {
      name: item.name,
      event: events,
      request: {
        method: req.method,
        header: req.headers.map(h => ({
          key: h.key,
          value: h.value,
          type: 'text',
          disabled: h.enabled === false
        })),
        body: postmanBody,
        url: {
          raw: req.url,
          query: req.queryParams.map(q => ({
            key: q.key,
            value: q.value,
            disabled: q.enabled === false
          }))
        },
        auth: postmanAuth
      },
      response: []
    };
  }

  /**
   * Parses a standard cURL command into an HttpRequest.
   */
  public static fromCurl(curlCommand: string): HttpRequest {
    let clean = curlCommand.trim().replace(/\\\r?\n/g, ' ');
    const methodMatch = clean.match(/-X\s+([A-Z]+)/i);
    let method: HttpMethod = (methodMatch ? methodMatch[1].toUpperCase() : 'GET') as HttpMethod;

    // URL match
    const urlMatch = clean.match(/(?:curl\s+)?(?:['"])(https?:\/\/[^'"]+)(?:['"])|(?:https?:\/\/\S+)/i);
    let url = urlMatch ? (urlMatch[1] || urlMatch[0]) : '';
    if (url.startsWith('curl ')) url = url.replace('curl ', '').trim();

    // Headers
    const headers: KeyValueParam[] = [];
    const headerRegex = /-H\s+['"]([^'"]+)['"]/g;
    let hMatch: RegExpExecArray | null;
    while ((hMatch = headerRegex.exec(clean)) !== null) {
      const parts = hMatch[1].split(':');
      if (parts.length >= 2) {
        headers.push({
          key: parts[0].trim(),
          value: parts.slice(1).join(':').trim(),
          enabled: true
        });
      }
    }

    // Body
    const body: RequestBody = { mode: 'none' };
    const dataMatch = clean.match(/(?:-d|--data|--data-raw)\s+(?:'([^']*)'|"([^"]*)")/);
    if (dataMatch) {
      if (!methodMatch) method = 'POST';
      body.mode = 'raw-json';
      body.raw = dataMatch[1] ?? dataMatch[2] ?? '';
    }

    return {
      id: crypto.randomUUID(),
      name: 'cURL Request',
      method,
      url,
      headers,
      queryParams: [],
      body,
      auth: { type: 'none' }
    };
  }
}
