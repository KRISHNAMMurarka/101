import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, lstatSync, realpathSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sdkNames = ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'];
const sourceNames = ['hub-server', 'pairing', 'protocol', 'input'];
const owned = ['examples/cross-host-workload/cross-host-workload.ts', 'examples/cross-host-workload/runtime-host.mjs', 'tests/cross-host-workload.test.ts', 'tools/qa-cross-host-workload.mjs'];
const sourceClosure = new Map(), compilePins = new Map();
let featureCleanup;
function json(path, limit) { const bytes = readFileSync(path); assert.ok(bytes.byteLength <= limit); return JSON.parse(bytes.toString('utf8')); }
function installHook(entries, observedRoot) {
  return registerHooks({ resolve(specifier, context, next) { return next(entries[specifier] ?? specifier, context); },
    load(url, context, next) {
      if (url.startsWith(pathToFileURL(observedRoot + '/').href) && /\.(ts|mjs)$/.test(url) && !url.includes('/node_modules/')) {
        assert.ok(sourceClosure.size < 256 || sourceClosure.has(url)); sourceClosure.set(url, hash(readFileSync(new URL(url))));
      } return next(url, context);
    } });
}
// Fixed child preload, independently checked public resolution table only. This
// branch imports no compiler, creates no fixture and opens no native transport.
if (new URL(import.meta.url).search === '?host-loader') {
  if (process.env.CROSS_HOST_RESOLUTIONS) {
    const path = process.env.CROSS_HOST_RESOLUTIONS;
    assert.ok(realpathSync(path) === path && /\/101-cross-host-exports-[A-Za-z0-9]+\/resolution\.json$/.test(path));
    const record = json(path, 16384); assert.ok(typeof record.sourceRoot === 'string');
    const permitted = new Set([...sdkNames, ...sourceNames].map(name => '@101/' + name));
    assert.deepEqual(Object.keys(record.entries).sort(), [...permitted].sort());
    for (const value of Object.values(record.entries)) { assert.ok(typeof value === 'string' && value.startsWith('file:')); assert.equal(existsSync(fileURLToPath(value)), true); }
    installHook(record.entries, record.sourceRoot);
  }
} else {
  const args = process.argv.slice(2);
  assert.ok(args.length === 1 && ['--source', '--feature-red'].includes(args[0]) || args.length === 2 && args[0] === '--sdk-root' && args[1]);
  assert.equal(process.version, 'v24.14.0'); assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
  const entries = Object.fromEntries([...sourceNames, ...sdkNames].map(name => ['@101/' + name, pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href]));
  const nativeLibrary = createRequire(import.meta.url).resolve('ws'), wsDirectory = dirname(nativeLibrary);
  assert.equal(json(join(wsDirectory, 'package.json'), 65536).version, '8.21.0');
  const nativePins = inventory(wsDirectory, 64), before = Object.fromEntries(owned.filter(path => existsSync(join(root, path))).map(path => [path, hash(readFileSync(join(root, path)))]));
  let consumer, producer, external, hook, resolverDirectory, featureError, failureDiagnostic, compilerReceipt;
  try {
    if (args[0] === '--sdk-root') {
      consumer = realpathSync(resolve(args[1])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
      const receipt = json(join(consumer, 'receipt.json'), 512 * 1024); assert.equal(receipt.status, 'pass');
      const manifestBytes = readFileSync(receipt.manifest.path); assert.equal(hash(manifestBytes), receipt.manifest.sha256);
      const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, receipt.source.tree); assert.deepEqual(manifest.source.sha256, receipt.source.sha256);
      assert.equal(manifest.packages.length, 7); let packedFiles = 0;
      for (const [path, digest] of Object.entries(manifest.source.sha256)) {
        assert.match(path, /^(LICENSE|schemas\/device-descriptor\.schema\.json|(packages|examples)\/[A-Za-z0-9_./-]+)$/); assert.equal(path.includes('..'), false);
        assert.equal(hash(execFileSync('git', ['show', manifest.source.tree + ':' + path], { cwd: root, maxBuffer: 2 * 1024 * 1024 })), digest);
      }
      for (const name of sdkNames) {
        const item = manifest.packages.find(value => value.name === '@101/' + name); assert.ok(item && item.files.length <= 1024);
        const directory = join(consumer, 'node_modules/@101', name), actual = inventory(directory, 1024);
        assert.deepEqual(Object.keys(actual).sort(), item.files.map(value => value.path).sort());
        for (const value of item.files) { assert.equal(actual[value.path], value.sha256); packedFiles++; }
      }
      external = mkdtempSync(join(consumer, 'cross-host-workload-'));
      const resolver = join(external, 'resolve.mjs');
      writeFileSync(resolver, 'const entries={};for(const name of ' + JSON.stringify(sdkNames.map(name => '@101/' + name)) + '){entries[name]=import.meta.resolve(name);await import(name);}export default entries;\n');
      // Resolve and import all installed exports normally before any hook.
      const installed = (await import(pathToFileURL(resolver).href)).default;
      for (const [specifier, url] of Object.entries(installed)) {
        const directory = join(consumer, 'node_modules', specifier), path = fileURLToPath(url); assert.ok(path.startsWith(directory + '/'));
        assert.equal(realpathSync(path), path); entries[specifier] = url;
      }
      producer = { tree: manifest.source.tree, manifest: receipt.manifest, packages: 7, sourcePins: Object.keys(manifest.source.sha256).length, packedFiles,
        ordinaryPublicEsmResolvedBeforeHooks: true };
    }
    resolverDirectory = realpathSync(mkdtempSync(join(tmpdir(), '101-cross-host-exports-')));
    const resolverFile = join(resolverDirectory, 'resolution.json'); writeFileSync(resolverFile, JSON.stringify({ entries, sourceRoot: root }), { mode: 0o600 });
    process.env.CROSS_HOST_RESOLUTIONS = resolverFile;
    hook = installHook(entries, root);
    if (args[0] === '--feature-red') {
      const prefix = await nativePrefix();
      console.log(JSON.stringify({ featurePrerequisite: prefix, node: process.version, producer: 'existing-public-source-hub-and-sdk', ownedNativeContexts: 0 }));
      assert.equal(existsSync(join(root, owned[0])), true, 'Actual native producer succeeded; missing cross-host workload runner is the unimplemented feature');
      throw Error('Feature-absence proof requires the old runner to be absent');
    }
    const { default: ts } = await import('typescript');
    let leaf = join(root, owned[0]);
    if (consumer) {
      for (const path of [owned[0], owned[1], owned[3], 'tools/qa-https-coordinator.mjs']) {
        const target = join(external, path); mkdirSync(dirname(target), { recursive: true }); cpSync(join(root, path), target);
      }
      leaf = join(external, owned[0]);
    }
    const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true, allowJs: true, allowImportingTsExtensions: true,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: ['node'], typeRoots: [join(root, 'node_modules/@types')] };
    const compilerHost = ts.createCompilerHost(options);
    compilerHost.resolveModuleNames = (names, containingFile) => names.map(name => {
      // SDK modules use ordinary NodeNext installed declaration resolution from
      // the external consumer anchor. Public source hub remains explicit.
      if (consumer && sdkNames.map(value => '@101/' + value).includes(name)) return ts.resolveModuleName(name, leaf, options, compilerHost).resolvedModule;
      if (sourceNames.map(value => '@101/' + value).includes(name)) return { resolvedFileName: fileURLToPath(entries[name]), extension: ts.Extension.Ts };
      return ts.resolveModuleName(name, containingFile, options, compilerHost).resolvedModule;
    });
    const program = ts.createProgram([leaf], options, compilerHost), diagnostics = ts.getPreEmitDiagnostics(program);
    for (const source of program.getSourceFiles()) { assert.ok(compilePins.size < 1024); compilePins.set(source.fileName, hash(readFileSync(source.fileName))); }
    compilerReceipt = { version: ts.version, strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, declarationPins: Object.fromEntries(compilePins),
      diagnostics: diagnostics.length, installedSdkUsesOrdinaryNodeNextDeclarations: !!consumer, sourceHubExplicit: true };
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => '\n' }));
    const { runCrossHostWorkloadQualification } = await import(pathToFileURL(leaf).href);
    const proof = await runCrossHostWorkloadQualification({ signal: new AbortController().signal });
    for (const [path, digest] of Object.entries(before)) assert.equal(hash(readFileSync(join(root, path))), digest);
    for (const [url, digest] of sourceClosure) assert.equal(hash(readFileSync(new URL(url))), digest);
    for (const [path, digest] of compilePins) assert.equal(hash(readFileSync(path)), digest);
    assert.deepEqual(inventory(wsDirectory, 64), nativePins);
    const provenanceDirectory = realpathSync(mkdtempSync(join(tmpdir(), '101-cross-host-provenance-'))), provenancePath = join(provenanceDirectory, 'receipt.json');
    writeFileSync(provenancePath, JSON.stringify({ callerPins: before, sourceClosure: Object.fromEntries(sourceClosure), compiler: compilerReceipt, nativePins, producer,
      node: process.version, sourceRoot: root, externalCaller: external, installedHub: false }, null, 2));
    const result = { result: 'pass', ...proof, node: process.version, producer, provenance: { path: provenancePath, sha256: hash(readFileSync(provenancePath)) },
      mode: consumer ? 'ordinary-installed-seven-sdk-with-explicit-source-hub' : 'owned-public-source-hosts', callerPins: before };
    const text = JSON.stringify(result) + '\n'; assert.ok(Buffer.byteLength(text) <= 16384); process.stdout.write(text);
  } catch (error) {
    featureError = error instanceof Error ? error.message : 'Feature prerequisite failed';
    const captured = error instanceof Error && Object.getOwnPropertyDescriptor(error, 'crossHostSampleDiagnostics');
    if (captured && 'value' in captured) {
      const bytes = JSON.stringify(captured.value); assert.ok(Buffer.byteLength(bytes) <= 4096);
      failureDiagnostic = JSON.parse(bytes);
    }
    throw error;
  } finally {
    try {
      if (args[0] === '--feature-red') {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), '101-cross-host-prefix-provenance-'))), path = join(directory, 'receipt.json');
        for (const [file, digest] of Object.entries(before)) assert.equal(hash(readFileSync(join(root, file))), digest);
        for (const [url, digest] of sourceClosure) assert.equal(hash(readFileSync(new URL(url))), digest);
        assert.deepEqual(inventory(wsDirectory, 64), nativePins);
        writeFileSync(path, JSON.stringify({ phase: 'existing-native-prefix', node: process.version, mode: 'owned-public-source-hub-and-sdk',
          callerPins: before, sourceClosure: Object.fromEntries(sourceClosure), nativeWsVersion: '8.21.0', nativePins,
          failure: featureError?.slice(0, 4096), nativeCleanupReceipt: featureCleanup }, null, 2));
        process.stderr.write('FEATURE_PROVENANCE ' + JSON.stringify({ path, sha256: hash(readFileSync(path)) }) + '\n');
      } else if (featureError !== undefined) {
        // Freeze the actual observed closure even when the unchanged native
        // assertion fails. This is a failed-run receipt, never qualification.
        const directory = realpathSync(mkdtempSync(join(tmpdir(), '101-cross-host-failure-provenance-'))), path = join(directory, 'receipt.json');
        for (const [file, digest] of Object.entries(before)) assert.equal(hash(readFileSync(join(root, file))), digest);
        for (const [url, digest] of sourceClosure) assert.equal(hash(readFileSync(new URL(url))), digest);
        for (const [file, digest] of compilePins) assert.equal(hash(readFileSync(file)), digest);
        assert.deepEqual(inventory(wsDirectory, 64), nativePins);
        const externalPins = external && Object.fromEntries([owned[0], owned[1], owned[3], 'tools/qa-https-coordinator.mjs'].map(file => [file, hash(readFileSync(join(external, file)))]));
        writeFileSync(path, JSON.stringify({ phase: 'failed-cross-host-run', node: process.version, callerPins: before,
          sourceClosure: Object.fromEntries(sourceClosure), compiler: compilerReceipt, nativeWsVersion: '8.21.0', nativePins,
          producer, installedHub: false, externalCaller: external, externalPins, failure: featureError.slice(0, 4096),
          sampleDiagnostic: failureDiagnostic, nativeCleanupReceipt: 'No successful public cleanup receipt; runner awaited its real native finally before rejection' }, null, 2));
        process.stderr.write('FAILURE_PROVENANCE ' + JSON.stringify({ path, sha256: hash(readFileSync(path)) }) + '\n');
      }
    } finally {
      hook?.deregister(); delete process.env.CROSS_HOST_RESOLUTIONS;
      if (resolverDirectory) rmSync(resolverDirectory, { recursive: true, force: true });
    }
    // Owned caller directories are retained as immutable evidence. No package,
    // original receipt or source installation is modified or removed.
  }
}

function inventory(directory, limit) {
  const value = {}; let visits = 0;
  function walk(current, prefix) {
    assert.equal(realpathSync(current), current); assert.equal(lstatSync(current).isSymbolicLink(), false);
    for (const name of readdirSync(current).sort()) {
      assert.ok(++visits <= 2048); const path = join(current, name), key = prefix + name, stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false); assert.equal(realpathSync(path), path);
      if (stat.isDirectory()) walk(path, key + '/'); else { assert.ok(stat.isFile()); assert.ok(Object.keys(value).length < limit); value[key] = hash(readFileSync(path)); }
    }
  }
  walk(realpathSync(directory), ''); return value;
}

async function nativePrefix() {
  const { createCoordinatorFixtures } = await import('./qa-https-coordinator.mjs');
  const { createHostedApplication, hostedApplicationRequirements, createAuthenticatedLoopbackRelay, connectAuthenticatedRelay, HOSTED_APPLICATION_SOURCE_SHA256 } = await import('@101/hub-server');
  const { createEphemeralWebIdentity, createDeviceRuntime, createWorkloadHandoff, RemoteResourcePublisher, RemoteResourceReceiver } = await import('@101/connect');
  const fixture = createCoordinatorFixtures(), owner = new AbortController(), publicationOwner = new AbortController(), commandOwner = new AbortController(), outputOwner = new AbortController();
  const now = performance.now.bind(performance), deadline = now() + 8000, clients = [], openings = [], requirements = hostedApplicationRequirements('prefix-host');
  let runtime, publisher, receiver, tick, actualResult;
  const identities = await Promise.all([createEphemeralWebIdentity(), createEphemeralWebIdentity()]);
  const selected = [fixture.clients[0], fixture.clients[2]], provider = createHostedApplication({ ownerId: 'prefix-host', providerId: 'prefix-host', applicationId: 'cross-host-prefix', sessionId: 'prefix', signal: owner.signal,
    authorize(request) { if (owner.signal.aborted || request.codeSha256 !== HOSTED_APPLICATION_SOURCE_SHA256) return; return { request, signal: request.action === 'input' ? commandOwner.signal : request.action === 'frame' ? outputOwner.signal : owner.signal, expiresAt: deadline }; } });
  const gateway = createAuthenticatedLoopbackRelay({ serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem, clientCaCertificatePem: fixture.ca,
    origin: 'https://cross-host-prefix.example', signal: owner.signal, enrollments: selected.map((value, index) => ({ principalId: value.principalId, deviceId: value.deviceId, certificatePem: value.certificatePem, endpointKeyId: identities[index].keyId })) });
  const handoff = createWorkloadHandoff({ workload: requirements.workload, context: requirements.context, source: provider.handoffHost(), validateState: value => !!value && typeof value === 'object' });
  async function until(condition) { const until = now() + 2500; let turns = 0; while (!condition()) { assert.ok(++turns < 500 && now() < until); await new Promise(resolve => setTimeout(resolve, 5)); } }
  try {
    const launched = await provider.start({ purpose: 'approved-prefix-launch', version: 1 }); assert.ok(launched.ok); await provider.handoffHost().resume(handoff.authority());
    await gateway.start(); const epoch = 'b'.repeat(32);
    const credentials = gateway.issuePair({ selectedPath: 'authenticated-loopback-relay', applicationId: 'cross-host-prefix', sessionId: 'prefix', epoch, sourcePrincipalId: selected[0].principalId,
      receiverPrincipalId: selected[1].principalId, ttlMs: 6000 }, request => ({ request, signal: owner.signal, expiresAt: request.expiresAt }));
    openings.push(...[credentials.source, credentials.receiver].map((credential, index) => connectAuthenticatedRelay({ credential, caCertificatePem: fixture.ca,
      certificatePem: selected[index].certificatePem, privateKeyPem: selected[index].privateKeyPem, identity: identities[index], signal: owner.signal }).then(client => { clients.push(client); return client; })));
    const [source, target] = await Promise.all(openings);
    runtime = createDeviceRuntime({ now, clockDomain: 'prefix-host-clock', maxRoutes: 1, maxRegistrations: 2, maxPendingDeliveries: 1,
      authorize(request) { if (commandOwner.signal.aborted || request.principalId !== 'prefix-owner' || request.applicationId !== 'cross-host-prefix' || request.sessionId !== 'prefix' || request.sinkOperation !== 'invoke') return;
        return { expiresAt: deadline, maxAgeMs: 250, maxHz: 30 }; } });
    const sink = runtime.registerSink({ device: requirements.inputSink, capability: 'cursor', async apply(observation, context) {
      actualResult = await provider.input(launched.value, observation.value, { purpose: 'approved-prefix-input', signal: commandOwner.signal, context });
      if (actualResult.ok && context.isCurrent() && !context.signal.aborted) context.reportEvidence('target-acknowledged');
    }, release() {} }); runtime.setReadiness(sink, 'available');
    receiver = new RemoteResourceReceiver({ peer: target.peer, epoch, clockId: 'prefix-host-clock', now, runtime, principalId: 'prefix-owner', applicationId: 'cross-host-prefix', sessionId: 'prefix' });
    publisher = new RemoteResourcePublisher({ peer: source.peer, epoch, clockId: 'prefix-source-clock', now, device: requirements.inputSource, available: capability => capability === 'cursor' && !publicationOwner.signal.aborted });
    assert.ok(publisher.start(), 'Actual approved public publisher must start');
    tick = setInterval(() => { receiver.tick(); publisher.tick(); runtime.flush(); }, 5);
    await until(() => !!receiver.description()); assert.ok(receiver.approve({ capability: 'cursor', sink, sinkDevice: requirements.inputSink, sinkCapability: 'cursor', grant: { expiresAt: deadline, maxAgeMs: 250, maxHz: 30 }, leaseMs: 1000 }));
    await until(() => receiver.status().active === 1 && receiver.status().clockReady);
    const admittedAt = now();
    assert.ok(publisher.publish('cursor', { x: 3, y: 2 }, { capturedAt: admittedAt, deadline: admittedAt + 250 })); await until(() => !!actualResult); assert.ok(actualResult.ok);
    const frame = await provider.frame(launched.value, { purpose: 'approved-prefix-private-output', signal: outputOwner.signal }); assert.ok(frame.ok);
    assert.deepEqual(frame.value.state, { x: 3, y: 2, revision: 1 }); assert.deepEqual(frame.value.pixels.slice(44, 48), [255, 0, 64, 255]);
    return { actualNativeWssInput: true, independentlyApprovedNativeRaster: true, existingCodeSha256: HOSTED_APPLICATION_SOURCE_SHA256,
      providerProfile: provider.status().profile, topology: 'explicit-trusted-plaintext-loopback-gateway', physicalMachines: false };
  } catch (error) {
    const facts = { receiver: receiver?.status(), publisher: publisher?.status(), commandResult: actualResult && { ok: actualResult.ok, reason: actualResult.ok ? undefined : actualResult.reason } };
    throw Error('Existing native prefix failed: ' + JSON.stringify(facts), { cause: error });
  } finally {
    owner.abort(); publicationOwner.abort(); commandOwner.abort(); outputOwner.abort(); if (tick) clearInterval(tick); publisher?.stop(); receiver?.stop(); runtime?.close();
    await Promise.allSettled(openings); await Promise.all(clients.map(value => value.stop())); await provider.close(); await gateway.stop(); fixture.close();
    assert.equal(provider.status().cleanupVerified, true); assert.equal(gateway.snapshot().nativeConnections, 0); assert.equal(gateway.snapshot().pendingRaw, 0); assert.equal(existsSync(fixture.directory), false);
    featureCleanup = { providerCleanupVerified: provider.status().cleanupVerified, clientStopsAwaited: clients.length,
      gatewayNativeConnections: gateway.snapshot().nativeConnections, gatewayPendingRaw: gateway.snapshot().pendingRaw,
      ownedPkiDirectoryAbsent: !existsSync(fixture.directory), ownedTickCleared: true };
  }
}
