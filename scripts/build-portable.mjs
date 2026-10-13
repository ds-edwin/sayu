import { execFileSync } from 'node:child_process';
import { cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'portable/vite.config.ts'], {stdio:'inherit'});
for (const file of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png']) await cp('public/' + file, 'portable-dist/' + file);
await cp('portable-dist/index.html', 'portable-dist/offline.html');
const assets = ['index.html', 'offline.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  ...(await readdir('portable-dist/pwa-assets')).filter(f => !f.startsWith('.')).map(f => 'pwa-assets/' + f)];
await writeFile('portable-dist/pwa-precache.json', JSON.stringify(assets));
const hash = createHash('sha256');
for (const path of assets) hash.update(await readFile('portable-dist/' + path));
const version = hash.digest('hex').slice(0,16);
const worker = (await readFile('public/sw.js','utf8')).replace("const CACHE=PREFIX+'v04';", `const CACHE=PREFIX+'${version}';`);
await writeFile('portable-dist/sw.js', worker);
await writeFile('portable-dist/.nojekyll', '');
console.log('Static PWA built:', version);
