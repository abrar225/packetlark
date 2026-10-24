import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpExecutor } from '../core/engine/HttpExecutor.js';
import { PostmanConverter } from '../core/models/PostmanConverter.js';
import { TrafficSnifferProxy } from '../core/sniffing/TrafficSnifferProxy.js';
import { OpenApiGenerator } from '../core/sniffing/OpenApiGenerator.js';
import { SdkGenerator } from '../core/sniffing/SdkGenerator.js';
import { ApiCollection, CollectionItem, Environment, HttpRequest } from '../core/models/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');
const publicDir = path.resolve(projectRoot, 'public');
const storageDir = path.resolve(projectRoot, '.rea-api');
const collectionsDir = path.resolve(storageDir, 'collections');
const environmentsDir = path.resolve(storageDir, 'environments');

function findAndUpdateRequest(items: CollectionItem[], req: HttpRequest): boolean {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.request && (item.request.id === req.id || item.id === req.id)) {
      item.request = req;
      item.name = req.name || item.name;
      return true;
    }
    if (item.isFolder && item.items) {
      if (findAndUpdateRequest(item.items, req)) return true;
    }
  }
  return false;
}

function findAndDeleteRequest(items: CollectionItem[], reqId: string): boolean {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if ((item.request && item.request.id === reqId) || item.id === reqId) {
      items.splice(i, 1);
      return true;
    }
    if (item.isFolder && item.items) {
      if (findAndDeleteRequest(item.items, reqId)) return true;
    }
  }
  return false;
}

export class StudioServer {
  private server: http.Server | null = null;
  private port: number;
  private sniffer: TrafficSnifferProxy;
  private collections: Map<string, ApiCollection> = new Map();
  private environments: Map<string, Environment> = new Map();

  constructor(port: number = 4040, snifferPort: number = 8085) {
    this.port = port;
    this.sniffer = new TrafficSnifferProxy(snifferPort);
    this.ensureStorage();
    this.loadInitialCollections();
    this.loadInitialEnvironments();
  }

  private ensureStorage() {
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    if (!fs.existsSync(collectionsDir)) {
      fs.mkdirSync(collectionsDir, { recursive: true });
    }
    if (!fs.existsSync(environmentsDir)) {
      fs.mkdirSync(environmentsDir, { recursive: true });
    }
  }

  private loadInitialCollections() {
    // 1. Load multi-file collections from .rea-api/collections/*.json
    try {
      const files = fs.readdirSync(collectionsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(path.join(collectionsDir, file), 'utf8');
            const col = JSON.parse(raw);
            if (col && col.id) {
              this.collections.set(col.id, col);
            }
          } catch {}
        }
      }
    } catch {}

    // 2. Fallback to monolithic collections.json for backwards compatibility
    if (this.collections.size === 0) {
      const collFile = path.join(storageDir, 'collections.json');
      if (fs.existsSync(collFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(collFile, 'utf8'));
          if (Array.isArray(data)) {
            for (const c of data) {
              this.collections.set(c.id, c);
              this.persistCollection(c.id);
            }
          }
        } catch {}
      }
    }

    // 3. If empty, create starter sample collection
    if (this.collections.size === 0) {
      const sampleCol: ApiCollection = {
        id: 'col_sample_1',
        name: 'GitHub Public API Sample',
        description: 'Demonstration collection with variables and assertions.',
        schemaVersion: '2.1.0',
        variables: [
          { key: 'baseUrl', value: 'https://api.github.com', enabled: true },
          { key: 'repo', value: 'morluto/rea', enabled: true }
        ],
        items: [
          {
            id: 'req_1',
            name: 'Get REA Repo Info',
            request: {
              id: 'req_1',
              name: 'Get REA Repo Info',
              method: 'GET',
              url: '{{baseUrl}}/repos/{{repo}}',
              headers: [{ key: 'User-Agent', value: 'ReaAPI-Studio', enabled: true }],
              queryParams: [],
              body: { mode: 'none' },
              auth: { type: 'none' },
              testScript: `pm.test("Status code is 200", function () {
    pm.expect(pm.response.code).to.equal(200);
    pm.response.to.have.status(200);
});

pm.test("Has valid repo name", function () {
    var data = pm.response.json();
    pm.expect(data.name).to.equal("rea");
});`
            }
          },
          {
            id: 'req_2',
            name: 'HTTPBin Echo Test',
            request: {
              id: 'req_2',
              name: 'HTTPBin Echo Test',
              method: 'POST',
              url: 'https://httpbin.org/post',
              headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
              queryParams: [{ key: 'traceId', value: '{{$guid}}', enabled: true }],
              body: {
                mode: 'raw-json',
                raw: JSON.stringify(
                  {
                    timestamp: '{{$timestamp}}',
                    client: 'ReaAPI Studio',
                    message: 'Clean-room reverse-engineered performance'
                  },
                  null,
                  2
                )
              },
              auth: { type: 'none' },
              testScript: `pm.test("Echo response received", function () {
    pm.expect(pm.response.code).to.equal(200);
    var json = pm.response.json();
    pm.expect(json.json.client).to.equal("ReaAPI Studio");
});`
            }
          }
        ]
      };
      this.collections.set(sampleCol.id, sampleCol);
      this.persistCollection(sampleCol.id);
    }
  }

  private loadInitialEnvironments() {
    // 1. Load multi-file environments from .rea-api/environments/*.json
    try {
      const files = fs.readdirSync(environmentsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(path.join(environmentsDir, file), 'utf8');
            const env = JSON.parse(raw);
            if (env && env.id) {
              this.environments.set(env.id, env);
            }
          } catch {}
        }
      }
    } catch {}

    // 2. Fallback to monolithic environments.json
    if (this.environments.size === 0) {
      const envFile = path.join(storageDir, 'environments.json');
      if (fs.existsSync(envFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(envFile, 'utf8'));
          if (Array.isArray(data)) {
            for (const env of data) {
              this.environments.set(env.id, env);
              this.persistEnvironment(env.id);
            }
          }
        } catch {}
      }
    }

    // 3. If empty, create default Development environment
    if (this.environments.size === 0) {
      const devEnv: Environment = {
        id: 'env_dev_1',
        name: 'Development',
        values: [
          { key: 'baseUrl', value: 'https://httpbin.org', enabled: true },
          { key: 'apiKey', value: 'dev-secret-token-12345', enabled: true }
        ]
      };
      this.environments.set(devEnv.id, devEnv);
      this.persistEnvironment(devEnv.id);
    }
  }

  public persistCollection(id: string) {
    const col = this.collections.get(id);
    if (!col) return;
    try {
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
      fs.writeFileSync(path.join(collectionsDir, `${safeId}.json`), JSON.stringify(col, null, 2), 'utf8');
      // Backwards compatibility mirror
      const collFile = path.join(storageDir, 'collections.json');
      fs.writeFileSync(collFile, JSON.stringify(Array.from(this.collections.values()), null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to persist collection:', e);
    }
  }

  public persistCollections() {
    for (const id of this.collections.keys()) {
      this.persistCollection(id);
    }
  }

  public deleteCollection(id: string) {
    this.collections.delete(id);
    try {
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const colFile = path.join(collectionsDir, `${safeId}.json`);
      if (fs.existsSync(colFile)) fs.unlinkSync(colFile);
      const allFile = path.join(storageDir, 'collections.json');
      fs.writeFileSync(allFile, JSON.stringify(Array.from(this.collections.values()), null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to delete collection file:', e);
    }
  }

  public persistEnvironment(id: string) {
    const env = this.environments.get(id);
    if (!env) return;
    try {
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
      fs.writeFileSync(path.join(environmentsDir, `${safeId}.json`), JSON.stringify(env, null, 2), 'utf8');
      // Backwards compatibility mirror
      const envFile = path.join(storageDir, 'environments.json');
      fs.writeFileSync(envFile, JSON.stringify(Array.from(this.environments.values()), null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to persist environment:', e);
    }
  }

  public deleteEnvironment(id: string) {
    this.environments.delete(id);
    try {
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const envFile = path.join(environmentsDir, `${safeId}.json`);
      if (fs.existsSync(envFile)) fs.unlinkSync(envFile);
      const allFile = path.join(storageDir, 'environments.json');
      fs.writeFileSync(allFile, JSON.stringify(Array.from(this.environments.values()), null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to delete environment file:', e);
    }
  }

  public async start(): Promise<number> {
    // Start sniffer proxy in parallel
    await this.sniffer.start();

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const urlObj = new URL(req.url || '/', `http://localhost:${this.port}`);
        const pathname = urlObj.pathname;

        // REST API routes with top-level error isolation
        if (pathname.startsWith('/api/')) {
          try {
            await this.handleApi(req, res, pathname, urlObj);
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  category: 'Internal Server Error',
                  message: err.message || 'An unhandled server exception occurred',
                  guidance: 'Please inspect the request payload or server diagnostics.',
                  code: err.code || 'INTERNAL_ERROR'
                }
              })
            );
          }
          return;
        }

        // Static files from public/
        this.serveStatic(req, res, pathname);
      });

      this.server.listen(this.port, () => {
        resolve(this.port);
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          this.port += 1;
          this.server?.listen(this.port);
        } else {
          reject(err);
        }
      });
    });
  }

  private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, urlObj: URL) {
    const sendJson = (data: any, statusCode = 200) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const readBody = async (): Promise<any> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const str = Buffer.concat(chunks).toString('utf8');
      if (!str.trim()) return {};
      try {
        return JSON.parse(str);
      } catch {
        return { raw: str };
      }
    };

    // 1. Health check & memory footprint
    if (pathname === '/api/health') {
      const mem = process.memoryUsage();
      sendJson({
        status: 'healthy',
        uptimeSec: Math.floor(process.uptime()),
        memoryRssMb: (mem.rss / 1024 / 1024).toFixed(2),
        memoryHeapUsedMb: (mem.heapUsed / 1024 / 1024).toFixed(2),
        snifferActive: this.sniffer.isRunning(),
        snifferPort: this.sniffer.getPort(),
        collectionsCount: this.collections.size,
        environmentsCount: this.environments.size
      });
      return;
    }

    // 2. Dispatch Request Execution with environment sync
    if (pathname === '/api/execute' && req.method === 'POST') {
      const body = await readBody();
      const httpRequest = body.request;
      const collectionVars = body.collectionVariables || [];
      const envId = body.environmentId;
      let envVars = body.environmentVariables || [];

      if (!httpRequest || !httpRequest.url) {
        sendJson({ error: 'Invalid request: url is required' }, 400);
        return;
      }

      if (envId && this.environments.has(envId)) {
        const env = this.environments.get(envId)!;
        if (!body.environmentVariables || body.environmentVariables.length === 0) {
          envVars = env.values;
        }
      }

      const response = await HttpExecutor.execute(httpRequest, collectionVars, envVars);

      // Auto-sync script mutations back to active environment file on disk
      if (envId && this.environments.has(envId) && response.updatedVariables) {
        const env = this.environments.get(envId)!;
        let changed = false;
        for (const [k, v] of Object.entries(response.updatedVariables)) {
          const existing = env.values.find(p => p.key === k);
          if (existing) {
            if (existing.value !== v) {
              existing.value = v;
              changed = true;
            }
          } else {
            env.values.push({ key: k, value: v, enabled: true });
            changed = true;
          }
        }
        if (changed) {
          this.persistEnvironment(envId);
        }
      }

      sendJson(response);
      return;
    }

    // 3. Environments CRUD & Variable Sync
    if (pathname === '/api/environments') {
      if (req.method === 'GET') {
        this.loadInitialEnvironments();
        sendJson(Array.from(this.environments.values()));
        return;
      }
      if (req.method === 'POST') {
        const newEnv: Environment = await readBody();
        if (!newEnv.id) newEnv.id = crypto.randomUUID();
        if (!newEnv.name) newEnv.name = 'New Environment';
        if (!Array.isArray(newEnv.values)) newEnv.values = [];

        this.environments.set(newEnv.id, newEnv);
        this.persistEnvironment(newEnv.id);
        sendJson(newEnv);
        return;
      }
    }

    const envMatch = pathname.match(/^\/api\/environments\/([a-zA-Z0-9_-]+)/);
    if (envMatch) {
      const envId = envMatch[1];
      if (req.method === 'GET' && pathname === `/api/environments/${envId}`) {
        const env = this.environments.get(envId);
        if (!env) {
          sendJson({ error: 'Environment not found' }, 404);
          return;
        }
        sendJson(env);
        return;
      }
      if (req.method === 'PUT' && pathname === `/api/environments/${envId}`) {
        const body = await readBody();
        const existing = this.environments.get(envId);
        if (!existing) {
          sendJson({ error: 'Environment not found' }, 404);
          return;
        }
        const updatedEnv: Environment = {
          ...existing,
          ...body,
          id: envId
        };
        this.environments.set(envId, updatedEnv);
        this.persistEnvironment(envId);
        sendJson(updatedEnv);
        return;
      }
      if (req.method === 'DELETE' && pathname === `/api/environments/${envId}`) {
        this.deleteEnvironment(envId);
        sendJson({ ok: true, deleted: envId });
        return;
      }
      if (req.method === 'POST' && pathname.endsWith('/sync')) {
        const { variables } = await readBody();
        if (variables && this.environments.has(envId)) {
          const env = this.environments.get(envId)!;
          for (const [k, v] of Object.entries(variables as Record<string, string>)) {
            const existing = env.values.find(p => p.key === k);
            if (existing) existing.value = v;
            else env.values.push({ key: k, value: v, enabled: true });
          }
          this.persistEnvironment(envId);
          sendJson(env);
          return;
        }
      }
    }

    // 4. Collections CRUD & Request Save/Update/Delete
    if (pathname === '/api/collections') {
      if (req.method === 'GET') {
        this.loadInitialCollections();
        sendJson(Array.from(this.collections.values()));
        return;
      }
      if (req.method === 'POST') {
        const newCol: ApiCollection = await readBody();
        if (!newCol.id) newCol.id = crypto.randomUUID();
        if (!newCol.name) newCol.name = 'New Collection';
        if (!Array.isArray(newCol.items)) newCol.items = [];
        if (!Array.isArray(newCol.variables)) newCol.variables = [];

        this.collections.set(newCol.id, newCol);
        this.persistCollection(newCol.id);
        sendJson(newCol);
        return;
      }
    }

    const colMatch = pathname.match(/^\/api\/collections\/([a-zA-Z0-9_-]+)/);
    if (colMatch) {
      const colId = colMatch[1];
      const collection = this.collections.get(colId);

      if (req.method === 'GET' && pathname === `/api/collections/${colId}`) {
        if (!collection) {
          sendJson({ error: 'Collection not found' }, 404);
          return;
        }
        sendJson(collection);
        return;
      }

      if (req.method === 'PUT' && pathname === `/api/collections/${colId}`) {
        const body = await readBody();
        if (!collection) {
          sendJson({ error: 'Collection not found' }, 404);
          return;
        }
        const updatedCol: ApiCollection = {
          ...collection,
          ...body,
          id: colId
        };
        this.collections.set(colId, updatedCol);
        this.persistCollection(colId);
        sendJson(updatedCol);
        return;
      }

      if (req.method === 'GET' && pathname === `/api/collections/${colId}/export/postman`) {
        if (!collection) {
          sendJson({ error: 'Collection not found' }, 404);
          return;
        }
        const postmanJson = PostmanConverter.toPostman(collection);
        sendJson(postmanJson);
        return;
      }

      if (req.method === 'DELETE' && pathname === `/api/collections/${colId}`) {
        this.deleteCollection(colId);
        sendJson({ ok: true, deleted: colId });
        return;
      }

      // Save/Update request inside collection
      if (pathname === `/api/collections/${colId}/requests` && req.method === 'POST') {
        if (!collection) {
          sendJson({ error: 'Collection not found' }, 404);
          return;
        }
        const body = await readBody();
        const reqToSave: HttpRequest = body.request || body;
        if (!reqToSave.id) reqToSave.id = crypto.randomUUID();

        const updated = findAndUpdateRequest(collection.items, reqToSave);
        if (!updated) {
          collection.items.push({
            id: reqToSave.id,
            name: reqToSave.name || 'New Request',
            isFolder: false,
            request: reqToSave
          });
        }
        this.persistCollection(colId);
        sendJson({ ok: true, request: reqToSave, collection });
        return;
      }

      // Delete request inside collection
      const delReqMatch = pathname.match(/^\/api\/collections\/([a-zA-Z0-9_-]+)\/requests\/([a-zA-Z0-9_-]+)/);
      if (delReqMatch && req.method === 'DELETE') {
        const reqId = delReqMatch[2];
        if (collection) {
          findAndDeleteRequest(collection.items, reqId);
          this.persistCollection(colId);
          sendJson({ ok: true, deleted: reqId });
          return;
        }
      }
    }

    // 5. Import Postman Collection
    if (pathname === '/api/import/postman' && req.method === 'POST') {
      const postmanJson = await readBody();
      const collection = PostmanConverter.fromPostman(postmanJson);
      this.collections.set(collection.id, collection);
      this.persistCollection(collection.id);
      sendJson(collection);
      return;
    }

    // 6. Import cURL
    if (pathname === '/api/import/curl' && req.method === 'POST') {
      const { curl } = await readBody();
      const request = PostmanConverter.fromCurl(curl || '');
      sendJson(request);
      return;
    }

    // 7. Sniffer Proxy Controls
    if (pathname === '/api/sniff/status') {
      sendJson({
        active: this.sniffer.isRunning(),
        port: this.sniffer.getPort(),
        capturedCount: this.sniffer.getCapturedItems().length
      });
      return;
    }

    if (pathname === '/api/sniff/toggle' && req.method === 'POST') {
      if (this.sniffer.isRunning()) {
        await this.sniffer.stop();
      } else {
        await this.sniffer.start();
      }
      sendJson({ active: this.sniffer.isRunning(), port: this.sniffer.getPort() });
      return;
    }

    if (pathname === '/api/sniff/traffic') {
      sendJson(this.sniffer.getCapturedItems());
      return;
    }

    if (pathname === '/api/sniff/clear' && req.method === 'POST') {
      this.sniffer.clearCapturedItems();
      sendJson({ ok: true });
      return;
    }

    // 8. Auto-generate OpenAPI 3.1 from captured traffic
    if (pathname === '/api/sniff/export/openapi') {
      const traffic = this.sniffer.getCapturedItems();
      const spec = OpenApiGenerator.generate(traffic);
      sendJson(spec);
      return;
    }

    // 9. Auto-generate Client SDK
    if (pathname === '/api/sniff/export/sdk') {
      const traffic = this.sniffer.getCapturedItems();
      const spec = OpenApiGenerator.generate(traffic);
      const sdkCode = SdkGenerator.generateTypeScript(spec);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(sdkCode);
      return;
    }

    sendJson({ error: 'Endpoint not found' }, 404);
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);

    if (!fs.existsSync(filePath)) {
      filePath = path.join(publicDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  }

  public async stop(): Promise<void> {
    await this.sniffer.stop();
    if (!this.server) return;
    return new Promise(resolve => {
      this.server?.close(() => resolve());
    });
  }
}
