import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'device-web', 'connect'];
const examples = ['pointer', 'sensor-feedback', 'threshold', 'telemetry-batch', 'spatial-joints', 'rich-input', 'resource-documents', 'media-description', 'run'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => hash(readFileSync(path));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function files(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error('SDK snapshot must not contain symbolic links');
    if (entry.isDirectory()) return files(path);
    if (!entry.isFile()) throw new Error('SDK snapshot must contain ordinary files');
    return [path];
  });
}
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function json(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }

function readme(name, version) {
  const intro = {
    'device-model': 'Bounded immutable device descriptions, signal schemas and conservative remote clocks.',
    'device-runtime': 'Embedded concrete-resource registration, trusted host authorization, leases, bounded delivery and operation evidence.',
    'transport-webrtc': 'Raw bounded reliable/disposable WebRTC lanes and immutable negotiated session bindings. Transport alone does not authorize resources.',
    'device-web': 'Authenticated endpoint peers, explicit identity stores, remote-resource binding and pointer providers.',
    connect: 'Game-independent public facade for the current 101 device model, embedded runtime, authenticated resource bridge and pointer provider.',
  }[name];
  return `# @101/${name}\n\n${intro}\n\nVersion ${version}. Compiled ESM JavaScript and TypeScript declarations; CommonJS and native-language distributions are not supplied. The public facade declarations include browser APIs: TypeScript consumers must include ES2022, DOM and DOM.Iterable libraries, including Node consumers of @101/connect. Node entry points use ordinary JavaScript, without type stripping. Browser APIs require the corresponding browser/OS capabilities. Node 22.13+ is the declared engine range; actual tested versions and limitations are recorded in the local distribution receipt.\n\nInstall the complete matching local tarball set with npm install --offline --ignore-scripts --no-audit --no-fund /absolute/path/to/*.tgz. This is a local dry run; no registry publication is implied.\n\n${name === 'connect' ? 'Import createDeviceRuntime, parseDeviceDescriptor, AuthenticatedResourcePeer or PointerResourceProvider from @101/connect. Run the compiled examples with node node_modules/@101/connect/examples/run.js. Source examples and their declarations are included alongside JavaScript. Examples simulate providers; they do not move the OS cursor or prove a physical actuator effect.\n\n' : ''}${name === 'connect' || name === 'device-model' ? 'The descriptor JSON schema is exported at @101/' + name + '/schema/device-descriptor.json. The runtime parser additionally enforces finite numbers, bounded plain JSON, relational limits and identity-safe snapshots. createUnitConverter explicitly maps reviewed numeric unit pairs with declared precision and error bounds; routing still requires exact units.\n\n' : ''}Value schemas support bounded records and arrays with explicit optional fields. Structured remote values negotiate json/2; json/1 and compact pointer bytes retain their existing contracts. Timestamp members remain in the declared application clock domain; nested timestamps are never silently translated. The telemetry-batch example includes explicit v1-to-v2 migration and opt-in KiBy-to-By publication with conversion provenance. Remote packets and runtime observation/options envelopes each have a separate 4 KiB limit; provenance consumes runtime space. Sender success does not establish host admission or effect. A host payload-limit drop preserves the grant without refreshing freshness or advancing received IDs, allowing a smaller batch to recover before the deadman expires.\n\nLabels, descriptors, invitation possession and endpoint key IDs supply no resource permission. The host must authorize concrete registrations. Remote resources require issued endpoint proof by default, bilateral connection enrollment and separate owner resource approval. Identity creation is explicit; missing storage stays unavailable. Release held input and cancel owned timers on stop, hide, disconnect and unmount. Native/physical, account identity, global service, wider SDK APIs and final security qualification remain separate.\n\nMIT license. Source: https://github.com/KRISHNAMMurarka/101. Private implementation subpaths are not exported.\n`;
}

const reference = process.argv[2];
if (process.argv.length !== 3 || !reference || reference.startsWith('-') || reference.length > 256) {
  console.error('Usage: node tools/build-sdk.mjs <immutable Git revision or tree>'); process.exit(1);
}
const tree = git(['rev-parse', '--verify', `${reference}^{tree}`]);
let revision = null;
try { revision = git(['rev-parse', '--verify', `${reference}^{commit}`]); } catch { /* Exact trees have no unique owning commit. */ }
const snapshot = mkdtempSync(join(tmpdir(), '101-sdk-source-'));
let outputDir;
try {
  const selectedPaths = [...names.map(name => `packages/${name}`), 'LICENSE', 'schemas/device-descriptor.schema.json',
    ...examples.map(name => `examples/device-pipelines/${name}.ts`)];
  const archive = execFileSync('git', ['archive', '--format=tar', tree, '--', ...selectedPaths], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', snapshot], { input: archive });
  const manifests = new Map(names.map(name => [name, JSON.parse(readFileSync(join(snapshot, `packages/${name}/package.json`), 'utf8'))]));
  for (const [name, manifest] of manifests) {
    if (manifest.name !== `@101/${name}` || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) || manifest.license !== 'MIT') throw new Error('Unsupported SDK package identity/version/license');
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      const target = manifests.get(dependency.replace(/^@101\//, ''));
      if (!target || target.name !== dependency || target.version !== version) throw new Error('SDK dependency must match an explicitly packed version');
    }
  }
  const roots = names.flatMap(name => files(join(snapshot, `packages/${name}/src`)).filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts')));
  roots.push(...examples.map(name => join(snapshot, `examples/device-pipelines/${name}.ts`)));
  const sourcePaths = [...roots, ...names.map(name => join(snapshot, `packages/${name}/package.json`)),
    join(snapshot, 'LICENSE'), join(snapshot, 'schemas/device-descriptor.schema.json')].sort();
  const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [relative(snapshot, path).replaceAll(sep, '/'), fileHash(path)]));
  const compiled = join(snapshot, '.compiled');
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, types: [], skipLibCheck: false,
    declaration: true, noEmitOnError: true, rewriteRelativeImportExtensions: true, rootDir: snapshot, outDir: compiled,
    paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(snapshot, `packages/${name}/src/index.ts`)]])),
  });
  const allowedSources = new Set(roots);
  if (program.getSourceFiles().some(source => !source.isDeclarationFile && !allowedSources.has(source.fileName))) throw new Error('SDK compiler imported source outside the explicit package/example scope');
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => snapshot, getCanonicalFileName: file => file, getNewLine: () => '\n' }));
  const emitted = program.emit();
  if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error('SDK compiler could not emit the exact source tree');
  // JSON assets must match the actual compiled producer, not a stale generated file.
  const model = await import(pathToFileURL(join(compiled, 'packages/device-model/src/index.js')).href);
  const schema = readFileSync(join(snapshot, 'schemas/device-descriptor.schema.json'));
  if (JSON.stringify(JSON.parse(schema)) !== JSON.stringify(model.DEVICE_DESCRIPTOR_SCHEMA)) throw new Error('Descriptor schema asset differs from the compiled producer');
  mkdirSync(join(root, 'release'), { recursive: true });
  outputDir = mkdtempSync(join(root, 'release', 'sdk-'));
  const tarballs = join(outputDir, 'tarballs'); mkdirSync(tarballs);
  const packages = [];
  for (const name of names) {
    const original = manifests.get(name), directory = join(outputDir, 'packages', name);
    mkdirSync(directory, { recursive: true });
    const exportMap = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
    const publicFiles = ['dist', 'LICENSE', 'README.md'];
    if (name === 'device-model' || name === 'connect') {
      copy(join(snapshot, 'schemas/device-descriptor.schema.json'), join(directory, 'schema/device-descriptor.json'));
      exportMap['./schema/device-descriptor.json'] = './schema/device-descriptor.json'; publicFiles.push('schema');
    }
    if (name === 'connect') {
      for (const example of examples) {
        for (const extension of ['js', 'd.ts']) copy(join(compiled, `examples/device-pipelines/${example}.${extension}`), join(directory, `examples/${example}.${extension}`));
        copy(join(snapshot, `examples/device-pipelines/${example}.ts`), join(directory, `examples/${example}.ts`));
        exportMap[`./examples/${example}`] = { types: `./examples/${example}.d.ts`, import: `./examples/${example}.js` };
      }
      publicFiles.push('examples');
    }
    for (const path of files(join(compiled, `packages/${name}/src`))) {
      if (!path.endsWith('.js') && !path.endsWith('.d.ts')) throw new Error('Unexpected SDK compiler output');
      copy(path, join(directory, 'dist', relative(join(compiled, `packages/${name}/src`), path)));
    }
    copy(join(snapshot, 'LICENSE'), join(directory, 'LICENSE'));
    writeFileSync(join(directory, 'README.md'), readme(name, original.version));
    json(join(directory, 'package.json'), { name: original.name, version: original.version, description: `101 ${name} SDK`,
      type: 'module', license: 'MIT', repository: { type: 'git', url: 'https://github.com/KRISHNAMMurarka/101.git' },
      engines: { node: '>=22.13.0' }, types: './dist/index.d.ts', exports: exportMap, files: publicFiles,
      ...(original.dependencies ? { dependencies: original.dependencies } : {}) });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs], { cwd: directory, encoding: 'utf8' }));
    if (packed.length !== 1 || packed[0].name !== original.name || packed[0].version !== original.version || packed[0].bundled?.length || packed[0].filename.includes('/') || packed[0].filename.includes('\\')) throw new Error('Unexpected npm pack result');
    const inventory = packed[0].files.map(file => {
      const path = resolve(directory, file.path);
      if (!path.startsWith(directory + sep) || !existsSync(path) || !lstatSync(path).isFile()) throw new Error('Unexpected packed file path');
      if (!['LICENSE', 'README.md', 'package.json'].includes(file.path) && !/^(?:dist\/[^/]+\.(?:js|d\.ts)|schema\/device-descriptor\.json|examples\/[^/]+\.(?:js|ts|d\.ts))$/.test(file.path)) throw new Error('SDK tarball contains a file outside the public allowlist');
      return { path: file.path, size: readFileSync(path).length, sha256: fileHash(path) };
    }).sort((a, b) => a.path.localeCompare(b.path));
    const tarball = join(tarballs, packed[0].filename);
    packages.push({ name: original.name, version: original.version, directory, tarball,
      sha256: fileHash(tarball), bytes: readFileSync(tarball).length, files: inventory });
  }
  const result = { schemaVersion: 1, source: { revision, tree, sha256: sourceSha256 },
    environment: { node: process.versions.node, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), typescript: ts.version },
    builderSha256: fileHash(new URL(import.meta.url)), outputDir, packages };
  json(join(outputDir, 'manifest.json'), result); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (outputDir) rmSync(outputDir, { recursive: true, force: true });
  console.error(error.message); process.exitCode = 1;
} finally { rmSync(snapshot, { recursive: true, force: true }); }
