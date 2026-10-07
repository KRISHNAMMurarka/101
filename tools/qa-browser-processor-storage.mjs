import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Root supplies already installed ordinary artifacts, an owned server and this
// proof. This command never compiles, installs, launches a server or child tool.
// Proof schema1: origin/sourceRoot/sourceTree/sourcePins/qaToolSHA;
// sdkManifestSHA/sdkSourceTree/sdkRoot; importMap (seven public roots);
// moduleInputs [{url,path,sha256,kind:sdk|fixture|caller,sourcePath?}];
// sdkEntryURL, fixtureURLs [fixed original v1,v2 modules], callerURL (GREEN only).
const args = process.argv.slice(2), origin = new URL(args.shift());
const options = new Map(), flags = new Set();
while (args.length) {
  const name = args.shift();
  if (name === '--feature-red') { assert.ok(!flags.has(name)); flags.add(name); continue; }
  assert.ok(['--served-proof', '--sdk-manifest', '--sdk-manifest-sha256', '--sdk-root', '--engine', '--output'].includes(name) && !options.has(name));
  const value = args.shift(); assert.ok(value && !value.startsWith('--')); options.set(name, value);
}
assert.ok(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  && origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash, 'owned loopback origin');
for (const name of ['--served-proof', '--sdk-manifest', '--sdk-manifest-sha256', '--sdk-root', '--engine']) assert.ok(options.has(name));
const engine = options.get('--engine'), featureRed = flags.has('--feature-red');
assert.ok(['chromium', 'webkit'].includes(engine));
const sha = /^[a-f0-9]{64}$/, tree = /^[a-f0-9]{40}$/, hash = bytes => createHash('sha256').update(bytes).digest('hex');
function regular(path, limit) {
  assert.ok(isAbsolute(path)); const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= limit);
  const bytes = readFileSync(path), after = lstatSync(path);
  for (const name of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[name], before[name]);
  assert.equal(bytes.length, before.size); return bytes;
}
function localURL(input) {
  assert.ok(typeof input === 'string' && input.length <= 1024);
  const value = new URL(input, origin);
  assert.equal(value.origin, origin.origin); assert.ok(!value.search && !value.hash && !value.username && !value.password);
  assert.match(value.pathname, /^\/[A-Za-z0-9._/-]*$/); assert.ok(!value.pathname.split('/').includes('..'));
  return value.href;
}
const work = mkdtempSync(join(tmpdir(), '101-browser-processor-storage-'));
const output = resolve(options.get('--output') ?? join(work, 'receipt.json')); assert.ok(!existsSync(output));
const ownerId = `qa-browser-processor-${randomUUID()}`, installationKey = `101:processor-installation:${encodeURIComponent(ownerId)}`;
const report = { schemaVersion: 1, status: 'pending', mode: featureRed ? 'old-feature-absence' : 'ordinary-installed-native-browser',
  phase: 'input-pins', engine, browserVersion: undefined, sourceTree: undefined, sdkSourceTree: undefined,
  sdkManifestSHA: undefined, ordinaryPackages: 0, ordinaryPayloadFiles: 0, publicPrefix: undefined,
  checks: [], requestCount: 0, foreignRequests: 0, servedPayloadsVerified: 0, pageErrors: 0, integrityGuardsVerified: false,
  failure: undefined, secondaryFailures: [], cleanup: { ownedStorageRemoved: false, ownedLocksSettled: false, pagesClosed: false,
    contextCloseAwaited: false, browserClosed: false }, rawChildTools: 0, workerExitObserved: false,
  scope: 'Cooperative same-origin software storage only; no hostile-host rollback, browser eviction, OS power-loss, isolation, native-device, phone, UI or whole E10 qualification.' };
let browser, context, failure, proof, manifest, sourceRoot;
const pages = [], pendingResponses = new Set(), verifiedURLs = new Set(), allowed = new Map();
const fixedSources = ['examples/external-processor/processor.mjs', 'examples/extension-installation/temperature-band-v2.mjs'];
const requiredSource = ['packages/device-runtime/src/processor-installation.ts', 'packages/device-runtime/src/processor-registry.ts',
  'packages/device-runtime/src/conformance.ts', 'packages/device-model/src/extension-release.ts', 'packages/device-model/src/processor-manifest.ts',
  'packages/connect/src/index.ts', 'packages/device-web/src/index.ts', 'app/settings/processors/trusted-processors.ts', ...fixedSources,
  ...(!featureRed ? ['packages/device-web/src/processor-installation-storage.ts', 'examples/extension-installation/browser-storage.ts'] : [])];
let provision, sdkEntryURL, fixtureURLs, callerURL, proofSHA, manifestSHA;
const installedPayloads = new Map();
function diagnostic(error) {
  const bounded = (value, max) => typeof value === 'string' ? value.replaceAll(ownerId, '[owned scope]').replaceAll(installationKey, '[owned key]').slice(0, max) : '';
  return { name: bounded(error instanceof Error ? error.name : 'UnknownThrownValue', 128),
    message: bounded(error instanceof Error ? error.message : 'Unsupported QA error value', 4096),
    stack: bounded(error instanceof Error ? error.stack : '', 8192), phase: report.phase, engine, browserVersion: report.browserVersion };
}
function retainFailure(cause) {
  if (!failure) { failure = cause; report.status = 'fail'; report.failure = diagnostic(cause); }
  else if (report.secondaryFailures.length < 8) report.secondaryFailures.push(diagnostic(cause));
}
async function page() {
  const value = await context.newPage(); pages.push(value);
  value.on('pageerror', () => { report.pageErrors++; });
  value.on('request', request => { report.requestCount++; if (report.requestCount > 1024 ||
    request.url() !== origin.href && !allowed.has(request.url())) report.foreignRequests++; });
  value.on('response', response => {
    const expected = allowed.get(response.url()); if (!expected) return;
    const pending = response.body().then(bytes => { assert.equal(response.status(), 200); assert.equal(hash(bytes), expected.sha256);
      verifiedURLs.add(response.url()); }, cause => { throw cause; });
    pendingResponses.add(pending); void pending.then(() => pendingResponses.delete(pending), () => {});
  });
  assert.equal((await value.goto(origin.href, { waitUntil: 'domcontentloaded' }))?.status(), 200);
  await value.addScriptTag({ type: 'importmap', content: JSON.stringify({ imports: proof.importMap }) });
  return value;
}
async function prepare(value) {
  return value.evaluate(async ({ sdkEntryURL, fixtureURLs, provision, ownerId }) => {
    const sdk = await import(sdkEntryURL), source = [], factories = [];
    for (const url of fixtureURLs) { const response = await fetch(url); if (!response.ok) throw Error('fixed-source-unavailable');
      source.push(new Uint8Array(await response.arrayBuffer())); factories.push((await import(url)).createTemperatureBand); }
    const key = await crypto.subtle.importKey('jwk', provision.publisherKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const versions = [];
    for (let index = 0; index < 2; index++) {
      const release = sdk.parseProcessorExtensionRelease(provision.releases[index]);
      if (typeof factories[index] !== 'function' || !await sdk.verifyProcessorExtensionRelease(release, source[index], key)) throw Error('fixed-provision-integrity');
      const fixture = { configuration: { onAt: 30, offAt: 28 }, invalidConfiguration: { onAt: 'bad', offAt: 28 },
        invalidInputs: { temperature: 'bad' }, cases: index === 0
          ? [{ inputs: { temperature: 30 }, outputs: { switch: true } }, { inputs: { temperature: 29 } }, { inputs: { temperature: 28 }, outputs: { switch: false } }]
          : [{ inputs: { temperature: 30 } }, { inputs: { temperature: 31 }, outputs: { switch: true } }, { inputs: { temperature: 28 }, outputs: { switch: false } }] };
      const original = factories[index];
      versions.push({ release, trusted: { manifest: release.manifest, source: source[index], factory(configuration) {
        const owner = globalThis.__ownedProcessorStorageQa; if (owner) owner.factoryCalls++;
        const instance = original(configuration);
        return { process(inputs) { return instance.process(inputs); }, reset() { instance.reset(); } };
      } }, fixture });
    }
    globalThis.__ownedProcessorStorageQa = { sdk, bundle: { key, publisherId: 'example:local-publisher', minimumSequence: 1, versions },
      ownerId, tokens: [], effects: 0, releases: 0, routeReleases: 0, factoryCalls: 0, routes: [], approvedRoutePairs: new Set(), lockNames: new Set() };
    return { importedOrdinarySDK: true, publicVerifyOnlyKey: key.type === 'public' && key.usages.join(',') === 'verify',
      signedOriginalSourcesVerified: versions.length === 2, nonExecutableManifestSelection: true };
  }, { sdkEntryURL, fixtureURLs, provision, ownerId });
}
async function openExample(value) {
  return value.evaluate(async callerURL => {
    const s = globalThis.__ownedProcessorStorageQa, nativeRequest = navigator.locks.request;
    const locks = { request(name, options, callback) { s.lockNames.add(name); return nativeRequest.call(navigator.locks, name, options, callback); } };
    const caller = await import(callerURL); if (typeof caller.createBrowserProcessorStorageExample !== 'function') throw Error('ordinary-caller-unavailable');
    s.example = await caller.createBrowserProcessorStorageExample({ ownerId: s.ownerId, bundle: s.bundle, locks, now: () => Date.now(),
      authorize(scope) {
        if (!s.review || scope.ownerId !== s.ownerId || scope.action !== s.review.action ||
          s.review.version !== undefined && scope.version !== s.review.version ||
          scope.publisherId !== undefined && scope.publisherId !== s.bundle.publisherId) return undefined;
        const token = { current: true, until: Date.now() + 30_000 }; s.tokens.push(token);
        return { expiresAt: token.until, isCurrent: () => token.current && Date.now() < token.until };
      } });
    return { verifiedVersions: s.example.reviewedVersions.length, constructionInactive: s.routes.length === 0 };
  }, callerURL);
}
async function reviewed(value, action, version) {
  return value.evaluate(async ({ action, version }) => {
    const s = globalThis.__ownedProcessorStorageQa, installer = s.example.installation;
    s.review = { action, ...(version === undefined ? {} : { version }) };
    try {
      const chosen = s.bundle.versions.find(entry => entry.release.version === version);
      const result = action === 'install' ? await installer.install(chosen.release, chosen.trusted.source)
        : action === 'revoke-release' ? await installer.revokeRelease(chosen.release.packageId, version)
          : action === 'revoke-publisher' ? await installer.revokePublisher(s.bundle.publisherId)
            : action === 'remove' ? await installer.remove(s.bundle.versions[0].release.packageId)
              : await installer[action === 'rollback-reviewed' ? 'rollbackReviewed' : 'activateReviewed']({ packageId: chosen.release.packageId, version, codeSha256: chosen.release.source.sha256,
                trusted: chosen.trusted, fixture: chosen.fixture, configuration: chosen.fixture.configuration,
                retireOwned() { for (const route of s.routes) route.stop('installation-retired'); s.runtime?.close(); s.releases++; } });
      if (result.ok && ['activate-reviewed', 'rollback-reviewed'].includes(action)) s.activation = result.value;
      return { ok: result.ok, reason: result.ok ? undefined : result.reason };
    } finally { s.review = undefined; }
  }, { action, version });
}
try {
  const proofBytes = regular(resolve(options.get('--served-proof')), 2 * 1024 * 1024); proofSHA = hash(proofBytes); proof = JSON.parse(proofBytes);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.origin, origin.origin); assert.match(proof.sourceTree, tree);
  assert.equal(proof.qaToolSHA, hash(regular(fileURLToPath(import.meta.url), 256 * 1024)));
  sourceRoot = realpathSync(proof.sourceRoot); assert.equal(sourceRoot, resolve(proof.sourceRoot));
  const manifestBytes = regular(resolve(options.get('--sdk-manifest')), 2 * 1024 * 1024);
  assert.match(options.get('--sdk-manifest-sha256'), sha); assert.equal(hash(manifestBytes), options.get('--sdk-manifest-sha256'));
  manifest = JSON.parse(manifestBytes); assert.equal(manifest.schemaVersion, 1); assert.match(manifest.source.tree, tree);
  manifestSHA = hash(manifestBytes);
  assert.equal(proof.sdkManifestSHA, hash(manifestBytes)); assert.equal(proof.sdkSourceTree, manifest.source.tree);
  const sdkRoot = realpathSync(resolve(options.get('--sdk-root'))); assert.equal(proof.sdkRoot, sdkRoot);
  assert.ok(!lstatSync(join(sdkRoot, 'node_modules')).isSymbolicLink());
  const names = ['connect', 'device-model', 'device-runtime', 'device-web', 'vision', 'transport-webrtc', 'transport-websocket'];
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => `@101/${name}`).sort());
  let total = 0;
  for (const item of manifest.packages) {
    const base = join(sdkRoot, 'node_modules', item.name); assert.equal(realpathSync(base), base);
    assert.ok(Array.isArray(item.files) && item.files.length >= 1 && item.files.length <= 256);
    const seen = new Set();
    for (const file of item.files) {
      assert.ok(typeof file.path === 'string' && file.path.length <= 512 && !isAbsolute(file.path) && !file.path.split('/').some(part => !part || part === '..'));
      assert.ok(!seen.has(file.path)); seen.add(file.path);
      const path = join(base, file.path); assert.equal(realpathSync(path), path);
      const bytes = regular(path, 4 * 1024 * 1024); total += bytes.length; assert.ok(total <= 64 * 1024 * 1024);
      assert.ok(Number.isSafeInteger(file.size) && file.size >= 0); assert.match(file.sha256, sha);
      assert.equal(bytes.length, file.size); assert.equal(hash(bytes), file.sha256); installedPayloads.set(path, file.sha256);
    }
    assert.match(item.sha256, sha); const archive = regular(item.tarball, 4 * 1024 * 1024);
    assert.equal(archive.length, item.bytes); assert.equal(hash(archive), item.sha256);
  }
  for (const path of requiredSource) {
    const bytes = regular(join(sourceRoot, path), 2 * 1024 * 1024); assert.equal(hash(bytes), proof.sourcePins?.[path]);
    if (path.startsWith('packages/') || path === 'examples/extension-installation/browser-storage.ts')
      assert.equal(hash(bytes), manifest.source.sha256?.[path]);
  }
  const text = regular(join(sourceRoot, 'app/settings/processors/trusted-processors.ts'), 128 * 1024).toString('utf8');
  const match = text.match(/const provision = ([\s\S]*?);\n/); assert.ok(match); provision = JSON.parse(match[1]);
  assert.equal(provision.releases.length, 2); assert.deepEqual(provision.publisherKey.key_ops, ['verify']);
  const sourceMatch = text.match(/const sources = (\[[\s\S]*?\]) as const;/); assert.ok(sourceMatch); const originalSources = JSON.parse(sourceMatch[1]);
  for (let index = 0; index < 2; index++) {
    const bytes = regular(join(sourceRoot, fixedSources[index]), 1024 * 1024), release = provision.releases[index];
    assert.equal(originalSources[index], bytes.toString('utf8')); assert.equal(bytes.length, release.source.byteLength);
    assert.equal(hash(bytes), release.source.sha256); assert.equal(hash(bytes), release.manifest.codeSha256);
    assert.deepEqual(release.privileges, ['compute-local']); assert.deepEqual(release.dependencies, []);
  }
  assert.ok(Array.isArray(proof.moduleInputs) && proof.moduleInputs.length >= 7 && proof.moduleInputs.length <= 1024);
  for (const item of proof.moduleInputs) {
    const url = localURL(item.url); assert.ok(!allowed.has(url)); assert.ok(['sdk', 'fixture', 'caller'].includes(item.kind));
    const bytes = regular(item.path, 4 * 1024 * 1024); assert.equal(hash(bytes), item.sha256);
    if (item.kind === 'sdk' || item.kind === 'caller') assert.equal(installedPayloads.get(item.path), item.sha256);
    else { assert.ok(fixedSources.includes(item.sourcePath)); assert.equal(item.path, join(sourceRoot, item.sourcePath));
      assert.equal(item.sha256, proof.sourcePins[item.sourcePath]); }
    allowed.set(url, item);
  }
  assert.deepEqual(Object.keys(proof.importMap).sort(), names.map(name => `@101/${name}`).sort());
  for (const name of names) { const url = localURL(proof.importMap[`@101/${name}`]);
    assert.equal(allowed.get(url)?.path, join(sdkRoot, 'node_modules', `@101/${name}`, 'dist/index.js')); }
  sdkEntryURL = localURL(proof.sdkEntryURL); assert.equal(sdkEntryURL, localURL(proof.importMap['@101/connect']));
  assert.equal(proof.fixtureURLs.length, 2); fixtureURLs = proof.fixtureURLs.map(localURL);
  for (let index = 0; index < 2; index++) assert.equal(allowed.get(fixtureURLs[index])?.sourcePath, fixedSources[index]);
  if (!featureRed) {
    callerURL = localURL(proof.callerURL); assert.equal(allowed.get(callerURL)?.path,
      join(sdkRoot, 'node_modules', '@101/connect', 'examples/browser-storage.js'));
    const pkg = JSON.parse(regular(join(sdkRoot, 'node_modules', '@101/connect/package.json'), 128 * 1024));
    assert.equal(pkg.exports?.['./examples/browser-storage']?.import, './examples/browser-storage.js');
  }
  report.sourceTree = proof.sourceTree; report.sdkSourceTree = manifest.source.tree; report.sdkManifestSHA = hash(manifestBytes);
  report.ordinaryPackages = manifest.packages.length; report.ordinaryPayloadFiles = installedPayloads.size;
  const require = createRequire(join(sourceRoot, 'package.json')), engines = require('playwright');
  browser = await engines[engine].launch({ headless: true }); report.browserVersion = browser.version(); context = await browser.newContext();
  const first = await page(); report.phase = 'genuine-native-prefix';
  const nativePrefix = await first.evaluate(async ownerId => {
    const probe = `${ownerId}:prefix`, storage = localStorage, locks = navigator.locks;
    storage.setItem(probe, 'owned-prefix'); const storageReadback = storage.getItem(probe) === 'owned-prefix'; storage.removeItem(probe);
    const lock = await locks.request(probe, { mode: 'exclusive' }, entry => entry?.name === probe && entry.mode === 'exclusive');
    const observed = await locks.query();
    return { storageReadback, nativeExclusiveLock: lock, prefixKeyRemoved: storage.getItem(probe) === null,
      prefixLockSettled: ![...(observed.held ?? []), ...(observed.pending ?? [])].some(entry => entry.name === probe) };
  }, ownerId);
  const cryptographicPrefix = await prepare(first);
  const installationPrefix = await first.evaluate(async () => {
    const s = globalThis.__ownedProcessorStorageQa, values = new Map(), actions = [];
    const storage = { async read(key) { return values.get(key); }, async compareAndSwap(key, expected, value, guard) {
      if (values.get(key) !== expected || guard.signal.aborted || !guard.isCurrent()) return false; values.set(key, value); return true;
    }, isCurrent(key, expected) { return values.get(key) === expected; } };
    const installer = s.sdk.createProcessorInstallation({ ownerId: s.ownerId, storage, now: () => Date.now(),
      publisherTrust: id => id === s.bundle.publisherId ? { key: s.bundle.key, minimumSequence: 1 } : undefined,
      authorize(scope) { actions.push(scope.action); if (scope.ownerId !== s.ownerId || scope.action !== 'install') return undefined;
        return { expiresAt: Date.now() + 30_000, isCurrent: () => true }; } });
    try {
      const chosen = s.bundle.versions[0], installed = await installer.install(chosen.release, chosen.trusted.source), inspect = await installer.inspect();
      const read = await installer.readRelease(chosen.release.packageId, chosen.release.version);
      // read-release has no approval: the positive prefix must refuse it.
      return { genuineInstall: installed.ok, installFailure: installed.ok ? undefined : installed.reason,
        inspectionFailure: inspect.ok ? undefined : inspect.reason,
        inactiveInspection: inspect.ok && inspect.value.packages.length === 1 && inspect.value.packages[0].active === false,
        signedSourceRetained: inspect.ok && inspect.value.packages[0].releases[0].release.source.sha256 === chosen.release.source.sha256,
        deniedFreshReadApproval: !read.ok && read.reason === 'denied', existingPrefixWrites: values.size,
        newPublicFactoryAvailable: typeof s.sdk.createBrowserProcessorInstallationStorage === 'function' };
    } finally { installer.close(); values.clear(); }
  });
  report.publicPrefix = { ...nativePrefix, ...cryptographicPrefix, ...installationPrefix };
  for (const name of ['storageReadback', 'nativeExclusiveLock', 'prefixKeyRemoved', 'prefixLockSettled',
    'publicVerifyOnlyKey', 'signedOriginalSourcesVerified', 'genuineInstall', 'inactiveInspection', 'signedSourceRetained', 'deniedFreshReadApproval'])
    assert.equal(report.publicPrefix[name], true, `genuine positive prerequisite: ${name}`);
  assert.equal(report.publicPrefix.existingPrefixWrites, 1); report.phase = 'public-feature-availability';
  assert.equal(report.publicPrefix.newPublicFactoryAvailable, true, 'missing managed durable browser processor storage public factory after genuine prefix');
  assert.equal(featureRed, false, 'feature-red targets the old absence only; a new factory requires normal qualification');
  report.phase = 'native-default-ports';
  const defaults = await first.evaluate(async ownerId => {
    const sdk = globalThis.__ownedProcessorStorageQa.sdk;
    const nativeOwner = `${ownerId}-defaults`, key = `101:processor-installation:${encodeURIComponent(nativeOwner)}`;
    const session = sdk.createBrowserProcessorInstallationStorage({ ownerId: nativeOwner });
    try {
      const untouched = localStorage.getItem(key) === null;
      const controller = new AbortController();
      const committed = await session.storage.compareAndSwap(key, undefined, 'owned-default-port-document',
        { signal: controller.signal, isCurrent: () => true });
      const current = session.storage.isCurrent(key, 'owned-default-port-document');
      const readback = await session.storage.read(key);
      const pending = session.snapshot().pendingWrites;
      const close = session.close(), sameClose = session.close() === close; await close;
      return { untouched, committed, current, readback, pending, sameClose, closed: session.snapshot().closed };
    } finally { await session.close(); localStorage.removeItem(key); }
  }, ownerId);
  assert.deepEqual(defaults, { untouched: true, committed: true, current: true, readback: 'owned-default-port-document',
    pending: 0, sameClose: true, closed: true });
  report.checks.push('actual default native Storage and Web Locks commit and close');
  report.phase = 'native-guard-read-reentry';
  const guardRead = await first.evaluate(async ownerId => {
    const sdk = globalThis.__ownedProcessorStorageQa.sdk;
    const nativeOwner = `${ownerId}-guard-read`, key = `101:processor-installation:${encodeURIComponent(nativeOwner)}`;
    let current = true, nativeWrites = 0;
    const storage = { getItem(name) { const raw = localStorage.getItem(name); current = false; return raw; },
      setItem(name, value) { nativeWrites++; localStorage.setItem(name, value); } };
    const session = sdk.createBrowserProcessorInstallationStorage({ ownerId: nativeOwner, storage });
    try {
      const owner = new AbortController();
      const result = await session.storage.compareAndSwap(key, undefined, 'guarded-owned-document',
        { signal: owner.signal, isCurrent: () => current });
      return { result, nativeWrites, unchanged: localStorage.getItem(key) === null, liveSignal: !owner.signal.aborted };
    } finally { await session.close(); localStorage.removeItem(key); }
  }, ownerId);
  assert.deepEqual(guardRead, { result: false, nativeWrites: 0, unchanged: true, liveSignal: true },
    'a native-backed read that retires approval must refuse the final commit');
  report.checks.push('native-backed read revocation refuses write with live signal and unchanged original bytes');
  report.phase = 'durable-install'; await openExample(first);
  assert.equal((await reviewed(first, 'install', '1.0.0')).ok, true);
  assert.equal((await reviewed(first, 'activate-reviewed', '1.0.0')).ok, true);
  assert.equal((await reviewed(first, 'install', '2.0.0')).ok, true);
  assert.equal((await reviewed(first, 'activate-reviewed', '2.0.0')).ok, true);
  assert.equal((await reviewed(first, 'rollback-reviewed', '1.0.0')).ok, true);
  report.checks.push('reviewed update and explicit retained rollback precede inactive reload');
  await first.evaluate(async () => { await globalThis.__ownedProcessorStorageQa.example.close(); });
  const second = await page(); await prepare(second); await openExample(second);
  const reload = await second.evaluate(async () => { const s = globalThis.__ownedProcessorStorageQa, result = await s.example.installation.inspect();
    return { ok: result.ok, inactive: result.ok && result.value.packages[0].active === false,
      versions: result.ok ? result.value.packages[0].releases.length : 0, grantsRestored: s.tokens.length }; });
  assert.deepEqual(reload, { ok: true, inactive: true, versions: 2, grantsRestored: 0 }); report.checks.push('durable reload is inactive without grants');
  const denied = await second.evaluate(async () => { const s = globalThis.__ownedProcessorStorageQa, chosen = s.bundle.versions[0];
    const result = await s.example.installation.activateReviewed({ packageId: chosen.release.packageId, version: chosen.release.version,
      codeSha256: chosen.release.source.sha256, trusted: chosen.trusted, fixture: chosen.fixture, configuration: chosen.fixture.configuration, retireOwned() {} });
    return { ok: result.ok, reason: result.ok ? undefined : result.reason, factoryCalls: s.factoryCalls }; });
  assert.deepEqual(denied, { ok: false, reason: 'denied', factoryCalls: 0 });
  assert.equal((await reviewed(second, 'activate-reviewed', '1.0.0')).ok, true);
  report.phase = 'separate-live-route-grants';
  const live = await second.evaluate(() => {
    const s = globalThis.__ownedProcessorStorageQa, now = () => Date.now();
    const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
    const latest = { mode: 'latest', maxHz: 10, maxAgeMs: 2000 }, reliable = { mode: 'reliable', maxAgeMs: 2000 };
    const capability = (id, semantic, kind, value, delivery, permissions) => ({ id, semantic, schemaVersion: 1, kind, value, delivery, permissions });
    const description = (id, capabilities) => ({ schemaVersion: 1, id, label: 'Owned software fixture', revision: 1,
      adapter: { id: 'qa:browser-processor-storage', version: '1.0.0' }, runtime: { platform: 'browser' }, capabilities });
    let grants = false;
    s.runtime = s.sdk.createDeviceRuntime({ now, authorize(request) {
      if (!grants || request.principalId !== s.ownerId || request.applicationId !== 'qa-browser-processor-storage' ||
        request.sessionId !== 'owned-software-session' || !s.approvedRoutePairs.has(`${request.source.registrationId}/${request.sink.registrationId}/${request.sourceOperation}/${request.sinkOperation}`)) return undefined;
      return { expiresAt: now() + 30_000, maxAgeMs: 2000, maxHz: 10 };
    } });
    const inputDevice = description('qa:owned-input', [capability('number', 'qa:temperature/1', 'sample', scalar, latest, ['subscribe'])]);
    const inputTarget = description('qa:owned-processor-input', [capability('number', 'qa:temperature/1', 'property', scalar, latest, ['write'])]);
    const outputDevice = description('qa:owned-derived', [capability('state', 'qa:threshold/1', 'event', { type: 'boolean' }, reliable, ['subscribe'])]);
    const outputTarget = description('qa:owned-indicator', [{ ...capability('state', 'qa:threshold/1', 'command', { type: 'boolean' }, reliable, ['invoke']), ownership: { mode: 'exclusive' } }]);
    const input = s.runtime.registerSource({ device: inputDevice, capability: 'number' });
    const derived = s.runtime.registerSource({ device: outputDevice, capability: 'state' }); let sequence = 0;
    const processorInput = s.runtime.registerSink({ device: inputTarget, capability: 'number', apply(observation, context) {
      if (!context.isCurrent() || !s.activation.isCurrent()) return;
      const output = s.activation.processor.process({ temperature: observation.value });
      if (output?.switch !== undefined && context.isCurrent() && s.activation.isCurrent())
        s.runtime.publish(derived, output.switch, { operationId: String(++sequence), deadline: now() + 1000 });
    }, release() {} });
    const indicator = s.runtime.registerSink({ device: outputTarget, capability: 'state', apply(observation, context) {
      if (context.isCurrent() && s.activation.isCurrent() && typeof observation.value === 'boolean') { s.effects++; context.reportEvidence('observed'); }
    }, release() { s.routeReleases++; } });
    for (const handle of [input, derived, processorInput, indicator]) s.runtime.setReadiness(handle, 'available');
    const common = { principalId: s.ownerId, applicationId: 'qa-browser-processor-storage', sessionId: 'owned-software-session' };
    const sourceRoute = s.runtime.route({ ...common, from: input, to: processorInput, sourceOperation: 'subscribe' });
    const outputRoute = s.runtime.route({ ...common, from: derived, to: indicator, sourceOperation: 'subscribe' });
    s.routes.push(sourceRoute, outputRoute);
    const denied = sourceRoute.start(); grants = true;
    s.approvedRoutePairs.add(`${input.id}/${processorInput.id}/subscribe/write`); s.approvedRoutePairs.add(`${derived.id}/${indicator.id}/subscribe/invoke`);
    const admittedInput = sourceRoute.start(), admittedOutput = outputRoute.start();
    const publication = s.runtime.publish(input, 30); s.runtime.flush(); s.runtime.flush();
    return { independentInputDenial: !denied.ok && denied.reason === 'denied', inputGranted: admittedInput.ok,
      outputGranted: admittedOutput.ok, localInputAdmitted: publication.ok, observedSoftwareEffects: s.effects,
      registrations: 4, activeRoutes: s.routes.filter(route => route.status().state === 'active').length };
  });
  assert.deepEqual(live, { independentInputDenial: true, inputGranted: true, outputGranted: true, localInputAdmitted: true,
    observedSoftwareEffects: 1, registrations: 4, activeRoutes: 2 }); report.checks.push('genuine separate subscribe/write and subscribe/invoke live grants');
  const third = await page(); await prepare(third); await openExample(third); report.phase = 'cross-page-revoke';
  assert.equal((await reviewed(third, 'revoke-release', '1.0.0')).ok, true);
  const retired = await second.evaluate(() => { const s = globalThis.__ownedProcessorStorageQa; const current = s.activation.isCurrent();
    return { current, retiredCallouts: s.releases, activeRoutes: s.routes.filter(route => route.status().state === 'active').length, releasedOutput: s.routeReleases }; });
  assert.deepEqual(retired, { current: false, retiredCallouts: 1, activeRoutes: 0, releasedOutput: 1 }); report.checks.push('actual cross-page revision synchronously retires activation and output');
  assert.equal((await reviewed(second, 'activate-reviewed', '1.0.0')).reason, 'revoked');
  assert.equal((await reviewed(third, 'revoke-publisher')).ok, true);
  assert.equal((await reviewed(second, 'activate-reviewed', '2.0.0')).reason, 'revoked');
  await third.evaluate(async () => { await globalThis.__ownedProcessorStorageQa.example.close(); });
  const fourth = await page(); await prepare(fourth); await openExample(fourth);
  const tombstone = await fourth.evaluate(async () => { const s = globalThis.__ownedProcessorStorageQa, result = await s.example.installation.inspect();
    return { ok: result.ok, revokedPublisher: result.ok && result.value.revokedPublishers.includes(s.bundle.publisherId),
      inactive: result.ok && result.value.packages.every(entry => !entry.active), freshApprovals: s.tokens.length }; });
  assert.deepEqual(tombstone, { ok: true, revokedPublisher: true, inactive: true, freshApprovals: 0 }); report.checks.push('release and publisher revocation survive native storage reload');
  assert.equal((await reviewed(fourth, 'remove')).ok, true);
  const removed = await fourth.evaluate(async () => { const s = globalThis.__ownedProcessorStorageQa, result = await s.example.installation.inspect();
    return { ok: result.ok, retainedHistory: result.ok && result.value.packages.length === 1,
      removedSources: result.ok && result.value.packages[0].releases.length === 0,
      revokedPublisher: result.ok && result.value.revokedPublishers.includes(s.bundle.publisherId) }; });
  assert.deepEqual(removed, { ok: true, retainedHistory: true, removedSources: true, revokedPublisher: true });
  report.checks.push('reviewed removal drops source releases while retaining revocation history');
  report.phase = 'queued-native-abort';
  const lockName = await second.evaluate(() => { const s = globalThis.__ownedProcessorStorageQa; if (s.lockNames.size !== 1) throw Error('exact-owner-lock-unavailable'); return [...s.lockNames][0]; });
  await fourth.evaluate(name => { const s = globalThis.__ownedProcessorStorageQa; s.holderReady = false;
    s.holderPromise = navigator.locks.request(name, { mode: 'exclusive' }, () => { s.holderReady = true;
      return new Promise(resolve => { s.releaseHolder = resolve; }); }); }, lockName);
  await fourth.waitForFunction(() => globalThis.__ownedProcessorStorageQa.holderReady, undefined, { timeout: 5000 });
  const queued = await second.evaluate(async key => { const s = globalThis.__ownedProcessorStorageQa, before = localStorage.getItem(key), owner = new AbortController();
    const write = s.example.storage.compareAndSwap(key, before, before, { signal: owner.signal, isCurrent: () => true });
    await Promise.resolve(); owner.abort(); const close = s.example.close();
    const result = await write.catch(() => false); await close;
    return { refused: result === false, unchanged: localStorage.getItem(key) === before, closeAwaited: true }; }, installationKey);
  assert.deepEqual(queued, { refused: true, unchanged: true, closeAwaited: true });
  await fourth.evaluate(async () => { const s = globalThis.__ownedProcessorStorageQa; s.releaseHolder(); await s.holderPromise; s.releaseHolder = undefined; });
  report.checks.push('queued genuine lock request aborts and close awaits its actual return');
  report.phase = 'final-source-artifact-guards';
  assert.equal(hash(regular(resolve(options.get('--served-proof')), 2 * 1024 * 1024)), proofSHA);
  assert.equal(hash(regular(resolve(options.get('--sdk-manifest')), 2 * 1024 * 1024)), manifestSHA);
  for (const [path, expected] of installedPayloads) assert.equal(hash(regular(path, 4 * 1024 * 1024)), expected);
  for (const path of requiredSource) assert.equal(hash(regular(join(sourceRoot, path), 2 * 1024 * 1024)), proof.sourcePins[path]);
  report.status = 'pass';
} catch (cause) { retainFailure(cause); }
finally {
  report.phase = report.status === 'pass' ? 'cleanup' : report.phase;
  try {
    // Release this helper's independent holder before awaiting any adapter close.
    for (const value of pages.filter(page => !page.isClosed())) await value.evaluate(async () => {
      const s = globalThis.__ownedProcessorStorageQa; if (s?.releaseHolder) { s.releaseHolder(); await s.holderPromise; s.releaseHolder = undefined; }
    });
    for (const value of pages.filter(page => !page.isClosed())) await value.evaluate(async ({ key, probe }) => {
      const s = globalThis.__ownedProcessorStorageQa;
      if (s) { for (const token of s.tokens) token.current = false; for (const route of s.routes) route.stop('qa-close');
        s.runtime?.close(); await Promise.all(s.routes.map(route => {
          if (typeof route.whenSettled !== 'function') throw Error('public-route-settlement-unavailable'); return route.whenSettled(); }));
        if (s.example) await s.example.close(); }
      localStorage.removeItem(key); localStorage.removeItem(probe);
    }, { key: installationKey, probe: `${ownerId}:prefix` });
    report.cleanup.ownedStorageRemoved = pages.length > 0 && await pages[0].evaluate(key => localStorage.getItem(key) === null, installationKey);
    report.cleanup.ownedLocksSettled = pages.length > 0 && await pages[0].evaluate(async ownerId => { const state = await navigator.locks.query();
      return ![...(state.held ?? []), ...(state.pending ?? [])].some(entry => entry.name?.includes(ownerId)); }, ownerId);
    await Promise.all([...pendingResponses]); report.servedPayloadsVerified = verifiedURLs.size;
    assert.equal(report.foreignRequests, 0); assert.equal(report.pageErrors, 0);
  } catch (cause) { retainFailure(cause); }
  try {
    if (proofSHA && manifestSHA && proof && sourceRoot) {
      assert.equal(hash(regular(resolve(options.get('--served-proof')), 2 * 1024 * 1024)), proofSHA);
      assert.equal(hash(regular(resolve(options.get('--sdk-manifest')), 2 * 1024 * 1024)), manifestSHA);
      for (const [path, expected] of installedPayloads) assert.equal(hash(regular(path, 4 * 1024 * 1024)), expected);
      for (const path of requiredSource) assert.equal(hash(regular(join(sourceRoot, path), 2 * 1024 * 1024)), proof.sourcePins[path]);
      report.integrityGuardsVerified = true;
    }
  } catch (cause) { retainFailure(cause); }
  try { if (context) { await context.close(); report.cleanup.contextCloseAwaited = true; } } catch (cause) { retainFailure(cause); }
  try { if (browser) { await browser.close(); report.cleanup.browserClosed = true; } } catch (cause) { retainFailure(cause); }
  report.cleanup.pagesClosed = pages.every(page => page.isClosed());
  if (report.status === 'pass' && !Object.values(report.cleanup).every(Boolean)) { report.status = 'fail';
    report.failure = { name: 'CleanupError', message: 'Owned cleanup incomplete', phase: 'cleanup', engine }; }
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, mode: report.mode, receipt: output, sha256: hash(readFileSync(output)),
    phase: report.failure?.phase ?? 'settled', cleanup: report.cleanup, ordinaryPackages: report.ordinaryPackages,
    ordinaryPayloadFiles: report.ordinaryPayloadFiles, rawChildTools: 0 }));
}
if (failure || report.status !== 'pass') process.exitCode = 1;
