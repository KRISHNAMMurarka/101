import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const REFERENCE_APP_IDS = Object.freeze(['pointer', 'sensor-dashboard', 'appliance-remote', 'media-sharing', 'collaborative-controls']);
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const root = realpathSync(resolve(import.meta.dirname, '..')), hash = bytes => createHash('sha256').update(bytes).digest('hex');
function bytes(path, max = 4194304) { const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.isFile(), true); assert.ok(stat.size <= max); const value = readFileSync(path); assert.ok(value.byteLength <= max); return value; }
function files(directory, budget = { left: 1024 }) { return readdirSync(directory).sort().flatMap(name => { assert.ok(--budget.left >= 0); const path = join(directory, name), stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false); if (stat.isDirectory()) return files(path, budget); assert.equal(stat.isFile(), true); return [path]; }); }
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }

/** Validate immutable clean SDK bytes before copying them into any independent app.
 * The caller owns the trusted manifest selection; no package install or download. */
export function readReferenceSdk(manifestPath, consumerPath) {
  const manifestFile = realpathSync(resolve(manifestPath)), consumer = realpathSync(resolve(consumerPath));
  assert.equal(manifestFile, resolve(manifestPath));
  const requestedConsumer = resolve(consumerPath), nativeTmp = realpathSync('/tmp');
  assert.ok(requestedConsumer === consumer || dirname(requestedConsumer) === '/tmp' && consumer === join(nativeTmp, relative('/tmp', requestedConsumer)), 'Only the platform /tmp alias is accepted');
  assert.equal(lstatSync(requestedConsumer).isSymbolicLink(), false); assert.ok(consumer.startsWith(join(nativeTmp, '101-sdk-consumer-')));
  assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
  const receipt = JSON.parse(bytes(join(consumer, 'receipt.json'))); assert.equal(receipt.status, 'pass'); assert.equal(receipt.manifest.path, manifestFile);
  const raw = bytes(manifestFile), sha256 = hash(raw); assert.equal(sha256, receipt.manifest.sha256); const manifest = JSON.parse(raw);
  assert.equal(manifest.schemaVersion, 1); assert.deepEqual(manifest.source.sha256, receipt.source.sha256); assert.equal(manifest.source.tree, receipt.source.tree); assert.match(manifest.source.tree, /^[0-9a-f]{40}$/);
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => '@101/' + name).sort());
  const installedPins = {}, packageVersions = {}; let total = 0;
  for (const item of manifest.packages) {
    assert.ok(Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 1024); const folder = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(folder), folder);
    const allowed = item.files.map(file => { assert.ok(typeof file.path === 'string' && !file.path.split('/').includes('..') && !file.path.startsWith('/'));
      assert.ok(['LICENSE', 'README.md', 'package.json'].includes(file.path) || /^(?:dist\/[^/]+\.(?:js|d\.ts)|schema\/device-descriptor\.json|examples\/[^/]+\.(?:js|ts|d\.ts))$/.test(file.path)); return file.path; });
    assert.equal(new Set(allowed).size, allowed.length); assert.deepEqual(files(folder).map(path => relative(folder, path)).sort(), [...allowed].sort());
    for (const file of item.files) { const path = resolve(folder, file.path); assert.ok(path.startsWith(folder + sep)); assert.equal(realpathSync(path), path); const value = bytes(path); assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.equal(value.byteLength, file.size); assert.equal(hash(value), file.sha256); total += value.byteLength; assert.ok(total <= 33554432); installedPins[item.name + '/' + file.path] = file.sha256; }
    const pkg = JSON.parse(bytes(join(folder, 'package.json'))); assert.equal(pkg.name, item.name); assert.match(pkg.version, /^\d+\.\d+\.\d+$/); packageVersions[item.name] = pkg.version;
  }
  return { manifest, manifestFile, manifestSha256: sha256, consumer, installedPins, packageVersions };
}

const serverSource = `import {createServer} from 'node:http';import {readFileSync,lstatSync,realpathSync} from 'node:fs';import {join,resolve,sep} from 'node:path';import {createHash} from 'node:crypto';
const root=realpathSync(import.meta.dirname),inventory=JSON.parse(readFileSync(join(root,'serve-inventory.json'),'utf8')),allowed=new Map(),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
if(!Array.isArray(inventory)||inventory.length<3||inventory.length>512)throw Error('Closed asset inventory required');let total=0;for(const entry of inventory){if(typeof entry.url!=='string'||!entry.url.startsWith('/')||entry.url.includes('..')||typeof entry.path!=='string'||entry.path.startsWith('/')||entry.path.split('/').includes('..')||allowed.has(entry.url))throw Error('Invalid asset');const file=resolve(root,entry.path);if(!file.startsWith(root+sep)||realpathSync(file)!==file||lstatSync(file).isSymbolicLink()||lstatSync(file).size>4194304)throw Error('Invalid owned asset');const bytes=readFileSync(file);if(hash(bytes)!==entry.sha256||bytes.byteLength!==entry.bytes)throw Error('Immutable app asset mismatch');total+=bytes.byteLength;if(total>33554432)throw Error('Asset budget');allowed.set(entry.url,{bytes,type:entry.url.endsWith('.js')?'text/javascript':entry.url==='/'?'text/html':'application/octet-stream'});}
let requests=0,closing=false;const sockets=new Set();const server=createServer((request,response)=>{if(closing||++requests>1024||request.method!=='GET'||request.url.length>1024){response.writeHead(400);response.end();return;}let url;try{url=new URL(request.url,'http://127.0.0.1');}catch{response.writeHead(400);response.end();return;}const asset=allowed.get(url.pathname);if(!asset||url.search){response.writeHead(404);response.end();return;}response.setHeader('Content-Type',asset.type);response.setHeader('Cache-Control','no-store');response.setHeader('Permissions-Policy','camera=(),microphone=(),geolocation=(),hid=(),serial=(),bluetooth=()');response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; media-src blob:; object-src 'none'; frame-src 'none'; base-uri 'none'");response.end(asset.bytes);});
server.on('connection',socket=>{if(closing||sockets.size>=16){socket.destroy();return;}sockets.add(socket);socket.setTimeout(5000,()=>socket.destroy());socket.on('close',()=>sockets.delete(socket));});server.on('clientError',(_error,socket)=>socket.destroy());
let reported=false;function close(){if(closing)return;closing=true;server.close(()=>{if(!reported){reported=true;console.log(JSON.stringify({kind:'closed',sockets:sockets.size}));}});for(const socket of sockets)socket.destroy();}process.on('SIGTERM',close);process.on('SIGINT',close);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));console.log(JSON.stringify({kind:'ready',url:'http://127.0.0.1:'+server.address().port}));
`;
const explanations = {
  pointer: 'Approve the local input source and application destination. Start, focus the pointer pad, then drag or use Arrow keys. Hold Space for contact and release it to end. Only the application cursor moves: no operating-system cursor or game dependency.',
  'sensor-dashboard': 'The software sensor measures actual lateness of this app’s 200ms browser timer using performance.now. Start to chart the latest32 typed observations and set the alert threshold. This is scheduling data, never physical sensor or precise clock calibration evidence.',
  'appliance-remote': 'The target is an authored software lamp inside this app, not a physical appliance. Request on/off. The reliable invoke handler acknowledges the request; a separate200ms typed state observation updates the preview. An acknowledgment never proves physical or independently external state.',
  'media-sharing': 'The source is this app’s owned64×48 drawing. Separate drawing-owner and destination-owner approvals permit native canvas capture and decoded pixels at the local recipient. Change drawing toggles actual red/blue pixels. No camera, microphone, screen or remote participant is acquired. A browser with missing native frame format reports unsupported; do not substitute a fake success.',
  'collaborative-controls': 'Two local browser control surfaces represent selected software producers, not authenticated remote people. Request and approve each left/right partition. Move sliders or hold contacts. Request a transfer, then decline/cancel to retain the incumbent or explicitly approve to release old ownership before activating new ownership.',
};

/** Importing is inert. Generation creates one fresh owned /tmp root, compiles ordinary
 * external TypeScript against installed declarations, and copies only closed SDK bytes. */
export function generateReferenceApps({ manifestPath, consumerPath }) {
  const sdk = readReferenceSdk(manifestPath, consumerPath), directory = realpathSync(mkdtempSync('/tmp/101-reference-apps-')), token = randomUUID();
  const marker = join(directory, '.owner'); write(marker, token);
  let success = false;
  const appBytes = bytes(join(root, 'examples/reference-apps/applications.ts'), 131072), generatedPins = {}, appDirectories = {};
  function cleanup() { assert.ok(directory.startsWith(join(realpathSync('/tmp'), '101-reference-apps-'))); if (existsSync(directory)) { assert.equal(realpathSync(directory), directory); assert.equal(bytes(marker, 128).toString(), token); rmSync(directory, { recursive: true, force: true }); } }
  try {
    for (const id of REFERENCE_APP_IDS) {
      const app = join(directory, id); appDirectories[id] = app; mkdirSync(app);
      for (const item of sdk.manifest.packages) for (const file of item.files) { const target = join(app, 'node_modules', item.name, file.path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(sdk.consumer, 'node_modules', item.name, file.path), target); assert.equal(hash(bytes(target)), file.sha256); }
      write(join(app, 'package.json'), JSON.stringify({ name: '101-reference-' + id, version: '1.0.0', private: true, type: 'module', scripts: { start: 'node serve.mjs' }, dependencies: sdk.packageVersions }, null, 2) + '\n');
      write(join(app, 'src/applications.ts'), appBytes);
      write(join(app, 'src/main.ts'), `import {mountReferenceApplication} from './applications.js';\nconst host=document.querySelector('body');if(!host)throw Error('Application host unavailable');\nconst scope=globalThis as typeof globalThis & {reference?:ReturnType<typeof mountReferenceApplication>};\nscope.reference=mountReferenceApplication(host,${JSON.stringify(id)});\n`);
      const compiler = ts.createProgram([join(app, 'src/applications.ts'), join(app, 'src/main.ts')], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true, types: [], skipLibCheck: false, noEmitOnError: true, rootDir: join(app, 'src'), outDir: join(app, 'dist') });
      const sourceFiles = compiler.getSourceFiles(); assert.deepEqual(sourceFiles.filter(file => !file.isDeclarationFile).map(file => file.fileName).sort(), [join(app, 'src/applications.ts'), join(app, 'src/main.ts')].sort());
      const library = realpathSync(join(root, 'node_modules/typescript/lib'));
      for (const file of sourceFiles.filter(file => file.isDeclarationFile)) { const path = realpathSync(file.fileName); assert.ok(path.startsWith(join(app, 'node_modules') + sep) || path.startsWith(library + sep), 'External compiler declaration escaped installed SDK and compiler'); }
      const diagnostics = ts.getPreEmitDiagnostics(compiler); assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => app, getCanonicalFileName: value => value, getNewLine: () => '\n' })); assert.equal(compiler.emit().emitSkipped, false);
      const imports = Object.fromEntries(names.map(name => ['@101/' + name, '/sdk/' + name + '/dist/index.js']));
      write(join(app, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>101 ${id} reference</title><script type="importmap">${JSON.stringify({ imports })}</script><script type="module" src="/dist/main.js"></script><body></body></html>`);
      write(join(app, 'serve.mjs'), serverSource);
      write(join(app, 'README.md'), `# Independent ${id} reference\n\n${explanations[id]}\n\n## Run locally\n\nUse Node24.14 or later and run \`node serve.mjs\` from this directory. Open only the printed owned127.0.0.1 URL. Stop the launcher with Ctrl-C. No install, download or remote service is required; all seven SDK packages are included with manifest hashes. Runtime imports use ordinary public ESM package exports.\n\n## Consent and recovery\n\nInitially stopped. Review and approve the selected source and destination separately, then press Start. Decline grants nothing. Stop, approval revocation, page hiding, focus loss and30s expiry release routes, held input, observers, timers and owned native output. Retry requires two fresh approvals. A pending native or handler promise stays reserved through actual settlement. Local host code and grants are trusted application policy, not authentication or a same-origin sandbox.\n\n## Build and inspect\n\nSource is in src/applications.ts and src/main.ts; ready-to-run ES2022 output is in dist. The generator strictly compiled this external source against the included installed declarations with no monorepo aliases or TS loader. To edit, use a locally installed TypeScript5.9 compiler with tsconfig.json; the runtime itself has no compiler dependency. No app, game or internal monorepo module is imported.\n\n## Bounds and evidence\n\nSelected session30s,16 activation attempts per mounted app; pointer cadence<=30Hz, sensor/lamp<=5Hz with32 retained chart rows, reliable queue${id === 'collaborative-controls' ? 4 : 1}, pending runtime effects<=2. Media uses existing native local-application-video/1 limits and truthful unsupported outcomes. Browser sample points and software state are declared explicitly; no physical device, external authentication, capture-clock mapping or cross-host media claim. SDK artifact source tree: ${sdk.manifest.source.tree}.\n`);
      write(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM', 'DOM.Iterable'], strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, types: [], rootDir: 'src', outDir: 'dist' }, include: ['src/*.ts'] }, null, 2) + '\n');
      const inventory = [{ url: '/', path: 'index.html' }, ...files(join(app, 'dist')).map(path => ({ url: '/' + relative(app, path), path: relative(app, path) })),
        ...sdk.manifest.packages.flatMap(item => item.files.filter(file => file.path.endsWith('.js') && file.path.startsWith('dist/')).map(file => ({ url: '/sdk/' + item.name.slice(5) + '/' + file.path, path: 'node_modules/' + item.name + '/' + file.path })))];
      write(join(app, 'serve-inventory.json'), JSON.stringify(inventory.map(item => ({ ...item, sha256: hash(bytes(join(app, item.path))), bytes: bytes(join(app, item.path)).byteLength })), null, 2) + '\n');
      for (const path of files(app, { left: 1024 })) generatedPins[relative(directory, path)] = hash(bytes(path));
    }
    success = true; return { directory, appDirectories, generatedPins, sdk, sourceSha256: hash(appBytes), cleanup };
  } finally { if (!success) cleanup(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 4, 'Use generate-sdk-reference-apps.mjs <immutable-manifest> <qualified-clean-consumer>');
  const generated = generateReferenceApps({ manifestPath: process.argv[2], consumerPath: process.argv[3] });
  console.log(JSON.stringify({ directory: generated.directory, apps: generated.appDirectories, sourceSha256: generated.sourceSha256, manifest: { path: generated.sdk.manifestFile, sha256: generated.sdk.manifestSha256 }, generatedPins: generated.generatedPins }, null, 2));
}
