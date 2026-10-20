import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { verifyConsoleReceiverBundle } from './verify-bundle.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(root, '../..'), out = resolve(repo, 'release/console-receiver'), hashes = {};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = path => path.split(sep).join('/');
await build({ configFile: false, root, base: './', plugins: [{ name: 'pin-receiver-sources', generateBundle() {
  for (const id of this.getModuleIds()) {
    if (!isAbsolute(id) || id.includes('?')) continue;
    const path = resolve(id), name = posix(relative(repo, path));
    if (name && !name.startsWith('../') && !name.startsWith('node_modules/') && !name.includes('/node_modules/') && statSync(path).isFile()) hashes[name] = hash(readFileSync(path));
  }
} }], build: { outDir: join(out, 'web'), emptyOutDir: true,
  target: 'es2022', sourcemap: false, assetsInlineLimit: 0 } });
// Deterministic monochrome app marks, generated with the bundle rather than stored binaries.
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, bytes) { const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes]))); return Buffer.concat([length, name, bytes, checksum]); }
function logo(size) {
  const pixels = Buffer.alloc(size * (size * 4 + 1)), glyph = ['010111010', '110101110', '010101010', '010101010', '111111111'];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const offset = y * (size * 4 + 1) + x * 4 + 1;
    const gx = Math.floor((x / size - .15) / .7 * 9), gy = Math.floor((y / size - .28) / .44 * 5);
    const value = gx >= 0 && gx < 9 && gy >= 0 && gy < 5 && glyph[gy][gx] === '1' ? 255 : 0;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value; pixels[offset + 3] = 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync(join(out, 'assets'), { recursive: true });
for (const [name, size] of [['Logo44', 44], ['Logo150', 150], ['StoreLogo', 50]]) writeFileSync(join(out, 'assets', name + '.png'), logo(size));
for (const path of ['index.html', 'build.mjs', 'verify-bundle.mjs', 'serve.mjs', 'README.md', ...readdirSync(join(root, 'windows')).map(name => 'windows/' + name)]) hashes['apps/console-receiver/' + path] = hash(readFileSync(join(root, path)));
for (const path of ['package.json', 'package-lock.json']) hashes[path] = hash(readFileSync(join(repo, path)));
const artifacts = {};
for (const dir of ['web', 'assets']) { const walk = path => { for (const name of readdirSync(path)) { const file = join(path, name); if (statSync(file).isDirectory()) walk(file); else artifacts[posix(relative(out, file))] = hash(readFileSync(file)); } }; walk(join(out, dir)); }
writeFileSync(join(out, 'source-manifest.json'), JSON.stringify({ schemaVersion: 1, sourceSha256: hashes, artifacts, windowsCompiled: false, xboxQualified: false }, null, 2) + '\n');
console.log(JSON.stringify(verifyConsoleReceiverBundle(repo), null, 2));
