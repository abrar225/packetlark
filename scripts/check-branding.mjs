import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const editor = JSON.parse(read('extensions/vscode/package.json'));
assert.equal(pkg.name, 'packetlark');
assert.equal(lock.name, pkg.name);
assert.equal(lock.packages[''].name, pkg.name);
assert.deepEqual(pkg.bin, { packetlark: './bin/packetlark.js' });
assert.equal(pkg.repository.url, 'https://github.com/abrar225/packetlark.git');
assert.equal(editor.name, pkg.name);
assert.equal(editor.displayName, 'PacketLark');
assert.equal(editor.repository.url, pkg.repository.url);
assert(editor.contributes.commands.every(({ command }) => command.startsWith('packetlark.')));
const cli = spawnSync(process.execPath, ['bin/packetlark.js', '--help'], { cwd: root, encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /^PacketLark\n/);
assert.match(cli.stdout, /packetlark run/);
assert.equal(read('public/favicon.svg'), read('public/brand/packetlark-symbol.svg'));
for (const htmlFile of ['public/index.html', 'public/studio.html']) {
  const html = read(htmlFile);
  assert.match(html, /<title>[^<]*PacketLark[^<]*<\/title>/);
  assert.match(html, /brand\/packetlark-symbol\.svg/);
  for (const [, source] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (/^(?:https?:|\/|mailto:)/.test(source) || source.includes('#')) continue;
    assert(fs.existsSync(path.join(root, 'public', source)), `Missing ${source} in ${htmlFile}`);
  }
}
for (const file of ['public/brand/packetlark-social.png', 'extensions/vscode/icon.png', 'assets/homepage.png', 'assets/homepage-mobile.png', 'assets/preview.png', 'assets/studio-mobile.png']) {
  const bytes = fs.readFileSync(path.join(root, file));
  assert(bytes.length > 500 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), `Invalid PNG: ${file}`);
}
assert.equal(read('dist-site/index.html'), read('public/index.html'));
assert.equal(read('dist-site/brand/packetlark-symbol.svg'), read('public/brand/packetlark-symbol.svg'));
console.log('PacketLark package, CLI, editor, HTML, logo and static deployment identity agree.');
console.log('VERDICT: PASS');
