import http from 'node:http';
import { SniffedTrafficItem, HttpMethod } from '../models/types.js';

export type TrafficListener = (item: SniffedTrafficItem) => void;

export class TrafficSnifferProxy {
  private server: http.Server | null = null;
  private port: number;
  private isCapturing: boolean = false;
  private readonly maxRingBufferSize: number = 500;
  private capturedItems: SniffedTrafficItem[] = [];
  private listeners: Set<TrafficListener> = new Set();

  constructor(port: number = 8085) {
    this.port = port;
  }

  public getPort(): number {
    return this.port;
  }

  public isRunning(): boolean {
    return this.isCapturing;
  }

  public getCapturedItems(): SniffedTrafficItem[] {
    return [...this.capturedItems];
  }

  public clearCapturedItems(): void {
    this.capturedItems = [];
  }

  public recordTraffic(trafficItem: SniffedTrafficItem): void {
    while (this.capturedItems.length >= this.maxRingBufferSize) {
      this.capturedItems.shift();
    }
    this.capturedItems.push(trafficItem);

    for (const listener of this.listeners) {
      try {
        listener(trafficItem);
      } catch (e) {
        // Ignore listener error
      }
    }
  }

  public subscribe(listener: TrafficListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public start(): Promise<number> {
    if (this.server) {
      return Promise.resolve(this.port);
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Handle CORS preflight for browser clients
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // Determine destination target URL
        let targetUrlStr = req.headers['x-target-url'] as string;
        if (!targetUrlStr && req.url) {
          // If URL starts with /http:// or /https://
          const match = req.url.match(/^\/(https?:\/\/.+)/i);
          if (match) {
            targetUrlStr = match[1];
          } else if (req.url.startsWith('http://') || req.url.startsWith('https://')) {
            targetUrlStr = req.url;
          }
        }

        if (!targetUrlStr) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'Missing destination URL. Pass X-Target-Url header or use /http://destination format.'
            })
          );
          return;
        }

        // Read request body chunks
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));

        req.on('end', async () => {
          const rawReqBody = Buffer.concat(chunks).toString('utf8');
          let parsedReqBody: any = undefined;
          if (rawReqBody.trim()) {
            try {
              parsedReqBody = JSON.parse(rawReqBody);
            } catch {
              parsedReqBody = rawReqBody;
            }
          }

          const forwardHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (v && !['host', 'x-target-url', 'connection'].includes(k.toLowerCase())) {
              forwardHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
            }
          }

          const startTime = performance.now();
          let responseStatus = 502;
          const responseHeaders: Record<string, string> = {};
          let responseBody: any = '';

          const hopByHopHeaders = new Set([
            'connection',
            'keep-alive',
            'proxy-authenticate',
            'proxy-authorization',
            'te',
            'trailer',
            'transfer-encoding',
            'upgrade',
            'content-encoding',
            'content-length'
          ]);

          try {
            const fetchRes = await fetch(targetUrlStr, {
              method: req.method,
              headers: forwardHeaders,
              body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : rawReqBody
            });

            responseStatus = fetchRes.status;
            fetchRes.headers.forEach((val, key) => {
              const kLower = key.toLowerCase();
              if (!hopByHopHeaders.has(kLower)) {
                responseHeaders[key] = val;
                res.setHeader(key, val);
              }
            });

            const arrayBuffer = await fetchRes.arrayBuffer();
            const resBuffer = Buffer.from(arrayBuffer);
            const contentType = (fetchRes.headers.get('content-type') || '').toLowerCase();
            const isTextual =
              !contentType ||
              contentType.includes('json') ||
              contentType.includes('text') ||
              contentType.includes('xml') ||
              contentType.includes('javascript') ||
              contentType.includes('html') ||
              contentType.includes('urlencoded');

            if (isTextual) {
              const rawResText = resBuffer.toString('utf8');
              try {
                responseBody = JSON.parse(rawResText);
              } catch {
                responseBody = rawResText;
              }
            } else {
              responseBody = `[Binary Data: ${resBuffer.length} bytes, type: ${contentType}]`;
            }

            res.writeHead(responseStatus);
            res.end(resBuffer);
          } catch (err: any) {
            responseStatus = 500;
            responseBody = { error: err.message || String(err) };
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responseBody));
          }

          const endTime = performance.now();
          const durationMs = Math.round(endTime - startTime);

          let urlObj: URL;
          try {
            urlObj = new URL(targetUrlStr);
          } catch {
            urlObj = new URL('http://unknown' + targetUrlStr);
          }

          const queryParams: Record<string, string> = {};
          urlObj.searchParams.forEach((v, k) => {
            queryParams[k] = v;
          });

          const trafficItem: SniffedTrafficItem = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            method: (req.method || 'GET').toUpperCase() as HttpMethod,
            url: targetUrlStr,
            pathname: urlObj.pathname,
            queryParams,
            requestHeaders: forwardHeaders,
            requestBody: parsedReqBody,
            responseStatus,
            responseHeaders,
            responseBody,
            durationMs
          };

          if (this.isCapturing) {
            this.recordTraffic(trafficItem);
          }
        });
      });

      this.server.listen(this.port, () => {
        this.isCapturing = true;
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

  public stop(): Promise<void> {
    this.isCapturing = false;
    if (!this.server) return Promise.resolve();

    return new Promise(resolve => {
      this.server?.close(() => {
        this.server = null;
        resolve();
      });
    });
  }
}
