import { startHttpFixture } from './http-fixture.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TrafficSnifferProxy } from '../src/core/sniffing/TrafficSnifferProxy.js';

describe('TrafficSnifferProxy Ring Buffer & Header Filtering', () => {
  let target: Awaited<ReturnType<typeof startHttpFixture>>;
  beforeAll(async()=>{target=await startHttpFixture();});
  afterAll(async()=>{await target.stop();});
  let proxy: TrafficSnifferProxy;
  const proxyPort = 8399;

  beforeAll(async () => {
    proxy = new TrafficSnifferProxy(proxyPort);
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
  });

  it('bounds captured traffic history to a 500-item circular FIFO ring buffer', () => {
    proxy.clearCapturedItems();

    // Exercise actual TrafficSnifferProxy.recordTraffic with 550 items
    for (let i = 1; i <= 550; i++) {
      proxy.recordTraffic({
        id: `item-${i}`,
        timestamp: new Date().toISOString(),
        method: 'GET',
        url: `https://api.example.com/item/${i}`,
        pathname: `/item/${i}`,
        queryParams: {},
        requestHeaders: {},
        responseStatus: 200,
        responseHeaders: {},
        durationMs: 1
      });
    }

    const items = proxy.getCapturedItems();
    expect(items.length).toBe(500);
    // Oldest items (1..50) should have been evicted by the FIFO ring buffer
    expect(items[0].id).toBe('item-51');
    expect(items[items.length - 1].id).toBe('item-550');
  });

  it('proxies requests and strips content-encoding headers to protect client decoders', async () => {
    // Send request through sniffer proxy to httpbin gzip endpoint
    const res = await fetch(`http://localhost:${proxyPort}/${target.url}/gzip`, {
      headers: {
        'Accept': 'application/json'
      }
    });

    expect(res.status).toBe(200);
    // Content-encoding should be stripped so consumer doesn't double-decompress
    expect(res.headers.get('content-encoding')).toBeNull();
    const data = await res.json();
    expect(data.gzipped).toBe(true);
  });

  it('proxies binary payloads transparently without UTF-8 corruption', async () => {
    const res = await fetch(`http://localhost:${proxyPort}/${target.url}/bytes/64`);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(64);
  });
});
