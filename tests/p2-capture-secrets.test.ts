import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { TrafficSnifferProxy } from '../src/core/sniffing/TrafficSnifferProxy.js';
import { OpenApiGenerator } from '../src/core/sniffing/OpenApiGenerator.js';
import { SdkGenerator } from '../src/core/sniffing/SdkGenerator.js';
import { SecretRedactor } from '../src/core/security/SecretRedactor.js';

describe('capture known credential boundaries', () => {
  it('forwards original values while removing decoded Basic, short and known encoded echoes from capture and exports', async () => {
    const basic = 'SEEDED-BASIC-PASSWORD';
    const known = 'SEEDED KNOWN/SECRET';
    const encoded = Buffer.from(known).toString('base64');
    const body = { echo: basic, short: 'prefix abc suffix', known, encoded,
      uri: encodeURIComponent(known), form: encodeURIComponent(known).replace(/%20/g, '+'),
      nested: { [known]: 'nested-value' }, ordinary: 'visible' };
    let authorization: string | undefined;
    const target = createServer((req, res) => {
      authorization = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(target.address() as any).port}`;
    const knownSecrets = new SecretRedactor(); knownSecrets.add(known);
    const proxy = new TrafficSnifferProxy(0, { knownSecrets });
    const published: unknown[] = []; proxy.subscribe(item => published.push(item));
    try {
      const port = await proxy.start();
      const auth = 'Basic ' + Buffer.from('user:' + basic).toString('base64');
      const response = await fetch(`http://127.0.0.1:${port}/${origin}/echo?password=abc&echo=${encodeURIComponent(known)}`, { headers: { Authorization: auth } });
      expect(await response.json()).toEqual(body); expect(authorization).toBe(auth);
      const captured = proxy.getCapturedItems(); expect(captured).toHaveLength(1);
      expect((captured[0].responseBody as any).ordinary).toBe('visible');
      const spec = OpenApiGenerator.generate(captured);
      const retained = JSON.stringify([captured, published, spec, SdkGenerator.generateTypeScript(spec)]);
      for (const secret of [basic, known, encoded, encodeURIComponent(known), encodeURIComponent(known).replace(/%20/g, '+'), 'prefix abc suffix'])
        expect(retained).not.toContain(secret);
    } finally {
      await proxy.stop(); target.closeAllConnections();
      await new Promise<void>(resolve => target.close(() => resolve()));
    }
  });

  it('fails closed when shared credential knowledge exceeds its bounded capacity', () => {
    const knownSecrets = new SecretRedactor(); knownSecrets.add('x'.repeat(8193));
    const proxy = new TrafficSnifferProxy(0, { knownSecrets });
    proxy.recordTraffic({ id: 'capture', timestamp: 1, method: 'GET', url: 'http://fixture.test/', pathname: '/', queryParams: {}, requestHeaders: {}, responseHeaders: {}, responseBody: { echo: 'unrecognized-private-value' }, responseStatus: 200, durationMs: 1 });
    expect(JSON.stringify(proxy.getCapturedItems())).not.toContain('unrecognized-private-value');
  });
});
