#!/usr/bin/env node
// Run after `npm run build`. This checks semantic fields, not a JSON snapshot.
import fs from 'node:fs';
import { reportPostmanImport, comparePostmanSemantics } from '../dist/core/models/ImportDiagnostics.js';
import { PostmanConverter } from '../dist/core/models/PostmanConverter.js';

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
let result;
if (args.length) {
  if (args.length !== 4 || args[0] !== '--before' || args[2] !== '--after') {
    console.error('Usage: node scripts/check-import-corpus.mjs [--before original.json --after exported.json]');
    process.exit(2);
  }
  // Validate both formats before the comparison. No shell or request execution.
  const before = read(args[1]), after = read(args[3]);
  PostmanConverter.fromPostman(before);
  PostmanConverter.fromPostman(after);
  const differences = comparePostmanSemantics(before, after);
  result = { preserved: differences.length === 0, differences };
} else {
  const root = new URL('../tests/fixtures/imports/', import.meta.url);
  const collections = ['nested-v21.json', 'unsupported-v21.json'].map((file) => ({
    fixture: file, ...reportPostmanImport(read(new URL(file, root))).report,
  }));
  const curl = read(new URL('curl-cases.json', root)).map((entry) => {
    try {
      const request = PostmanConverter.fromCurl(entry.command);
      return { fixture: entry.name, passed: !entry.error && request.method === entry.method &&
        (entry.body === undefined || request.body.raw === entry.body) && (entry.url === undefined || request.url === entry.url) };
    } catch (error) {
      return { fixture: entry.name, passed: !!entry.error && error.message.includes(entry.error) };
    }
  });
  result = { preserved: collections.every((entry) => entry.preserved) && curl.every((entry) => entry.passed), collections, curl };
}
console.log(JSON.stringify(result, null, 2));
console.log(`VERDICT: ${result.preserved ? 'PASS' : 'FAIL -- semantic differences or unexpected cURL behavior'}`);
process.exitCode = result.preserved ? 0 : 1;
