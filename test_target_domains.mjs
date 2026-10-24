async function testDomain(domain, extraPaths = []) {
  console.log(`\n======================================================`);
  console.log(`🔍 Testing Target Domain: ${domain}`);
  console.log(`======================================================`);

  const paths = ['', ...extraPaths];
  for (const p of paths) {
    const fullUrl = `https://${domain}${p}`;
    console.log(`\n[ReaAPI Studio Request] GET ${fullUrl}`);

    try {
      // 1. Direct Dispatch via ReaAPI Studio Executor
      const execRes = await fetch('http://localhost:4040/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: {
            method: 'GET',
            url: fullUrl,
            headers: [
              { key: 'User-Agent', value: 'ReaAPI-Studio/1.0 (Windows x64)', enabled: true },
              { key: 'Accept', value: '*/*', enabled: true }
            ],
            queryParams: [],
            body: { mode: 'none' },
            auth: { type: 'none' },
            testScript: `
              pm.test("Response received", function() {
                pm.expect(pm.response.code).to.be.above(0);
              });
            `
          }
        })
      });

      const execData = await execRes.json();
      console.log(`  -> Status: ${execData.status} ${execData.statusText}`);
      console.log(`  -> Total Duration: ${execData.timings?.totalMs} ms`);
      console.log(`  -> Payload Size: ${(execData.sizeBytes / 1024).toFixed(2)} KB`);
      console.log(`  -> Server Technology: ${execData.headers?.server || 'Hidden / Cloudflare'}`);
      console.log(`  -> Content Type: ${execData.headers?.['content-type'] || 'unknown'}`);
      if (execData.headers?.location) {
        console.log(`  -> Redirect Location: ${execData.headers.location}`);
      }

      // 2. Intercept via ReaAPI Sniffer Proxy to capture into OpenAPI & SDK pipeline
      const sniffRes = await fetch(`http://localhost:8085/${fullUrl}`, {
        headers: {
          'User-Agent': 'ReaAPI-Studio-Sniffer/1.0',
          'Accept': '*/*'
        }
      });
      console.log(`  -> Intercepted via Sniffer Proxy (Port 8085): HTTP ${sniffRes.status}`);
    } catch (err) {
      console.error(`  -> Failed to reach ${fullUrl}:`, err.message);
    }
  }
}

async function main() {
  // Test firehox.com
  await testDomain('firehox.com', ['/robots.txt', '/sitemap.xml', '/api', '/favicon.ico']);

  // Test abrarakhunji.com
  await testDomain('abrarakhunji.com', ['/robots.txt', '/sitemap.xml', '/api', '/favicon.ico']);

  // 3. Query the Sniffer for total captured traffic
  console.log(`\n======================================================`);
  console.log(`🛰️ Generating Autonomous OpenAPI 3.1 & SDK From Captured Traffic`);
  console.log(`======================================================`);

  const trafficRes = await fetch('http://localhost:4040/api/sniff/traffic');
  const trafficList = await trafficRes.json();
  console.log(`Total live requests intercepted by Sniffer: ${trafficList.length}`);

  // Generate OpenAPI 3.1
  const openApiRes = await fetch('http://localhost:4040/api/sniff/export/openapi', { method: 'POST' });
  const openApiSpec = await openApiRes.json();
  console.log(`\nGenerated OpenAPI 3.1 Specification:\n`, JSON.stringify(openApiSpec, null, 2));

  // Generate TypeScript SDK
  const sdkRes = await fetch('http://localhost:4040/api/sniff/export/sdk', { method: 'POST' });
  const sdkCode = await sdkRes.text();
  console.log(`\nGenerated TypeScript Client SDK Preview (first 40 lines):\n`, sdkCode.split('\n').slice(0, 45).join('\n'));
}

main().catch(console.error);
