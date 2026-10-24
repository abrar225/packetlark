import { StudioServer } from './StudioServer.js';

const PORT = Number(process.env.PORT || 4040);
const SNIFFER_PORT = Number(process.env.SNIFFER_PORT || 8085);

const server = new StudioServer(PORT, SNIFFER_PORT);

server.start().then(actualPort => {
  const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  console.log('='.repeat(65));
  console.log('  🚀 ReaAPI Studio — Next-Gen Clean-Room API Platform');
  console.log('='.repeat(65));
  console.log(`  ⚡ Web / Desktop Studio:  http://localhost:${actualPort}`);
  console.log(`  🛰️ Live Traffic Sniffer:  http://localhost:${SNIFFER_PORT}`);
  console.log(`  💾 Local-First Git Data:  .rea-api/collections/ & .rea-api/environments/`);
  console.log(`  🏎️ Idle Memory Baseline:  ~${mem} MB (vs Postman ~1.2 GB)`);
  console.log(`  🔒 Data Privacy:          100% Offline / Zero-Cloud Mandate`);
  console.log('='.repeat(65));
}).catch(err => {
  console.error('Failed to launch ReaAPI Studio:', err);
  process.exit(1);
});
