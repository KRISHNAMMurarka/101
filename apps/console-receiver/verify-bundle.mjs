import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = 'release/console-receiver/source-manifest.json';
const BUNDLE = 'release/console-receiver';
const REQUIRED_SOURCE = ['package.json', 'package-lock.json', 'examples/device-pipelines/remote-pointer.ts',
  ...['index.html', 'src/main.ts', 'src/receiver.ts', 'src/style.css', 'build.mjs', 'verify-bundle.mjs', 'serve.mjs', 'README.md',
    'windows/App.xaml', 'windows/App.xaml.cs', 'windows/MainPage.xaml', 'windows/MainPage.xaml.cs',
    'windows/Receiver.csproj', 'windows/Package.appxmanifest', 'windows/build.ps1'].map(path => 'apps/console-receiver/' + path)];
const REQUIRED_ARTIFACT = ['web/index.html', 'assets/Logo44.png', 'assets/Logo150.png', 'assets/StoreLogo.png'];
const sourcePrefix = /^(?:package(?:-lock)?\.json$|apps\/console-receiver\/|examples\/device-pipelines\/remote-pointer\.ts$|packages\/(?:connect|device-model|device-runtime|device-web|transport-webrtc|transport-websocket|vision)\/src\/)/;
const artifactPath = /^(?:web\/(?:index\.html|assets\/[A-Za-z0-9_-]+\.(?:js|css))|assets\/(?:Logo44|Logo150|StoreLogo)\.png)$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = path => path.replaceAll('\\', '/');
function fail(message) { throw new Error(`Console receiver bundle: ${message}`); }
function safePath(path) {
  if (typeof path !== 'string' || path.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.'))) fail('unsafe relative path');
  return path;
}
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function checkedPath(root, path, kind = 'file') {
  const parts = safePath(path).split('/'); let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let entry; try { entry = lstatSync(current); } catch { fail(`missing input: ${path}`); }
    if (entry.isSymbolicLink()) fail(`symbolic link input: ${path}`);
    if ((index < parts.length - 1 || kind === 'directory') ? !entry.isDirectory() : !entry.isFile()) fail(`nonregular input: ${path}`);
  }
  return current;
}
function hashes(value, kind) {
  if (!record(value) || Object.keys(value).length < 1 || Object.keys(value).length > 2048) fail(`invalid ${kind} hash map`);
  const seen = new Set();
  for (const [path, digest] of Object.entries(value)) {
    safePath(path);
    if (!(kind === 'source' ? sourcePrefix : artifactPath).test(path) || seen.has(path.toLowerCase())) fail(`invalid ${kind} path: ${path}`);
    seen.add(path.toLowerCase());
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) fail(`invalid ${kind} digest`);
  }
}

/** Checks current producer output, never an existence-only or historical build receipt. */
export function verifyConsoleReceiverBundle(repository = fileURLToPath(new URL('../..', import.meta.url))) {
  const root = resolve(repository), rootEntry = lstatSync(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || relative(root, realpathSync(root)) !== '') fail('repository must be a real directory without symbolic links');
  const manifestPath = checkedPath(root, MANIFEST), bytes = readFileSync(manifestPath);
  if (bytes.length > 1024 * 1024) fail('oversized manifest');
  let manifest; try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid manifest JSON'); }
  const keys = ['schemaVersion', 'sourceSha256', 'artifacts', 'windowsCompiled', 'xboxQualified'];
  if (!record(manifest) || Object.keys(manifest).length !== keys.length || !keys.every(key => Object.hasOwn(manifest, key)) ||
    manifest.schemaVersion !== 1 || manifest.windowsCompiled !== false || manifest.xboxQualified !== false) fail('invalid manifest schema');
  // The actual producer writes this form. This also rejects duplicate JSON keys.
  if (bytes.toString('utf8') !== JSON.stringify(manifest, null, 2) + '\n') fail('manifest is not in producer JSON form');
  hashes(manifest.sourceSha256, 'source'); hashes(manifest.artifacts, 'artifact');
  for (const path of REQUIRED_SOURCE) if (!Object.hasOwn(manifest.sourceSha256, path)) fail(`missing required source pin: ${path}`);
  for (const path of REQUIRED_ARTIFACT) if (!Object.hasOwn(manifest.artifacts, path)) fail(`missing required artifact pin: ${path}`);
  if (!Object.keys(manifest.artifacts).some(path => /^web\/assets\/.*\.js$/.test(path)) ||
    !Object.keys(manifest.artifacts).some(path => /^web\/assets\/.*\.css$/.test(path))) fail('missing executable web assets');
  for (const [path, digest] of Object.entries(manifest.sourceSha256)) {
    if (hash(readFileSync(checkedPath(root, path))) !== digest) fail(`source hash mismatch: ${path}`);
  }
  const bundleRoot = checkedPath(root, BUNDLE, 'directory'), actual = [];
  function inventory(path) {
    const directory = checkedPath(bundleRoot, path, 'directory');
    for (const name of readdirSync(directory)) {
      const child = path + '/' + name, entry = lstatSync(join(bundleRoot, child));
      if (entry.isSymbolicLink()) fail(`symbolic link artifact: ${child}`);
      if (entry.isDirectory()) { if (child !== 'web/assets') fail(`unexpected artifact directory: ${child}`); inventory(child); }
      else { checkedPath(bundleRoot, child); actual.push(posix(child)); }
    }
  }
  inventory('web'); inventory('assets');
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(manifest.artifacts).sort())) fail('artifact inventory differs from manifest');
  for (const [path, digest] of Object.entries(manifest.artifacts)) {
    if (hash(readFileSync(checkedPath(bundleRoot, path))) !== digest) fail(`artifact hash mismatch: ${path}`);
  }
  const pin = value => hash(JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  return Object.freeze({ schemaVersion: 1, status: 'verified', manifest: { path: MANIFEST, sha256: hash(bytes) },
    sourceSetSha256: pin(manifest.sourceSha256), artifactSetSha256: pin(manifest.artifacts),
    sourceFiles: Object.keys(manifest.sourceSha256).length, artifacts: actual.length });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) fail('use node verify-bundle.mjs [repository]');
    console.log(JSON.stringify(verifyConsoleReceiverBundle(process.argv[2]), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Console receiver bundle verification failed'); process.exitCode = 1; }
}
