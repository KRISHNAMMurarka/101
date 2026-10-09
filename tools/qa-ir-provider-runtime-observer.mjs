import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync, writeSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function validateRuntimeEnvironment(environment, platform, uid) {
  const expectedKeys = ['LANG', 'LC_ALL', 'TZ', 'IR_OBSERVER_NONCE', 'IR_OBSERVER_EPOCH', 'IR_OBSERVER_EXECUTABLE',
    'IR_OBSERVER_EXECUTABLE_SHA256', 'IR_OBSERVER_PRODUCER', 'IR_OBSERVER_PRODUCER_SHA256', 'IR_OBSERVER_OBSERVER', 'IR_OBSERVER_OBSERVER_SHA256'];
  if (platform === 'darwin') {
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('Invalid runtime UID');
    expectedKeys.push('__CF_USER_TEXT_ENCODING');
    assert.equal(environment.__CF_USER_TEXT_ENCODING, `0x${uid.toString(16).toUpperCase()}:0:0`);
  }
  assert.deepEqual(Object.keys(environment).sort(), expectedKeys.sort());
  assert.deepEqual([environment.LANG, environment.LC_ALL, environment.TZ], ['C', 'C', 'UTC']);
}

// The imported branch only observes the exact runtime; it never changes producer control flow.
function installRuntimeObserver() {
  const emit = (phase, exitCode) => {
    const actualExecutable = realpathSync(process.execPath), actualProducer = realpathSync(process.argv[1]);
    const actualObserver = realpathSync(fileURLToPath(import.meta.url));
    const record = { schemaVersion: 1, phase, nonce: process.env.IR_OBSERVER_NONCE, epoch: Number(process.env.IR_OBSERVER_EPOCH),
      pid: process.pid, ppid: process.ppid, nodeVersion: process.version, platform: process.platform, architecture: process.arch,
      execPath: process.execPath, executable: actualExecutable, executableSha256: hash(readFileSync(actualExecutable)),
      argv: [...process.argv], execArgv: [...process.execArgv], cwd: realpathSync(process.cwd()), environment: { ...process.env },
      producer: actualProducer, producerSha256: hash(readFileSync(actualProducer)), observer: actualObserver,
      observerSha256: hash(readFileSync(actualObserver)), clockDomain: { timeOrigin: performance.timeOrigin }, exitCode };
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    if (bytes.length > 8192) throw new Error('Runtime origin record too large');
    let offset = 0;
    while (offset < bytes.length) { const written = writeSync(3, bytes, offset, bytes.length - offset); if (!Number.isInteger(written) || written < 1) throw new Error('Runtime origin write incomplete'); offset += written; }
    validateRuntimeEnvironment(record.environment, process.platform, process.platform === 'darwin' ? process.getuid() : undefined);
    assert.match(record.nonce, /^[a-f0-9]{32}$/); assert.ok(Number.isSafeInteger(record.epoch) && record.epoch > 0);
    assert.equal(record.executable, record.environment.IR_OBSERVER_EXECUTABLE); assert.equal(record.executableSha256, record.environment.IR_OBSERVER_EXECUTABLE_SHA256);
    assert.equal(record.producer, record.environment.IR_OBSERVER_PRODUCER); assert.equal(record.producerSha256, record.environment.IR_OBSERVER_PRODUCER_SHA256);
    assert.equal(record.observer, record.environment.IR_OBSERVER_OBSERVER); assert.equal(record.observerSha256, record.environment.IR_OBSERVER_OBSERVER_SHA256);
    assert.deepEqual(record.argv, [record.executable, record.producer]); assert.deepEqual(record.execArgv, ['--import', pathToFileURL(record.observer).href]);
    assert.equal(record.cwd, realpathSync(dirname(record.producer)));
  };
  process.once('exit', code => emit('after', code));
  emit('before', null);
}

const turn = () => new Promise(resolveTurn => setImmediate(resolveTurn));
// Fixture roots are explicit main-entry inputs; the imported observer never uses them.
let root, scratch;
const allowedPackages = ['connect', 'device-model', 'device-runtime', 'device-web', 'vision', 'transport-webrtc', 'transport-websocket'];
const trace = [];
const note = (event, detail = {}) => trace.push({ event, ...detail });

class HeldWritable extends Writable {
  constructor(child) { super({ autoDestroy: true }); this.owner = child; this.holds = []; }
  write(...args) {
    note('actual-write-call', { type: JSON.parse(String(args[0])).type, callerCallback: typeof args.at(-1) === 'function' });
    return super.write(...args);
  }
  _write(chunk, encoding, completion) {
    const message = JSON.parse(chunk.toString());
    let resolveObserved;
    const observation = new Promise(resolveCompletion => { resolveObserved = resolveCompletion; });
    const record = { type: message.type, completed: false, observation, release(error) {
      assert.equal(record.completed, false, 'actual internal completion released twice');
      record.completed = true; note('actual-internal-write-completion', { type: message.type, error: Boolean(error) }); completion(error);
      resolveObserved({ type: message.type, completionCalled: true, error: error ? { message: error.message, code: error.code } : null });
    } };
    this.holds.push(record); note('actual-internal-write-issued', { type: message.type });
    this.owner.command(message);
    if (this.owner.holdWriteType !== message.type) record.release();
  }
  _destroy(error, completion) { note('actual-writable-destroy', { pendingInternal: this.holds.filter(v => !v.completed).length }); completion(error); }
}
class FixtureChild extends EventEmitter {
  constructor(kind, options = {}) {
    super(); Object.assign(this, options); this.kind = kind; this.pid = 43210; this.exitCode = null; this.signalCode = null;
    this.stdin = new HeldWritable(this); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.proof = new PassThrough();
    this.stdio = [this.stdin, this.stdout, this.stderr, this.proof]; this.closed = false; this.killCount = 0;
    this.spawnObserved = false; this.spawnErrors = []; this.exitObserved = false;
    this.once('spawn', () => { this.spawnObserved = true; });
    this.on('error', error => { this.spawnErrors.push({ code: error.code, message: error.message }); });
    this.once('exit', () => { this.exitObserved = true; });
    this.childCloseObservation = new Promise(resolveClose => { this.once('close', (code, signal) => {
      this.observedChildClose = { code, signal }; resolveClose(this.observedChildClose);
    }); });
    this.streamCloseObservations = this.stdio.map((stream, index) => new Promise(resolveClose => {
      stream.once('close', () => { resolveClose({ index, actualCloseObserved: true }); });
    }));
    note('fixture-observations-installed-before-start', { createdStreams: this.stdio.length, childCloseObservation: true, actualInternalWriteObservationInstalledOnIssue: true });
    for (const [index, stream] of this.stdio.entries()) { stream.on('error', error => note('fixture-stream-error', { index, message: error.message })); stream.on('close', () => note('actual-stream-close', { index })); }
  }
  start() {
    setImmediate(() => {
      if (this.failedSpawn) { const error = Object.assign(Error('owned fixture spawn ENOENT'), { code: 'ENOENT' }); this.emit('error', error); note('fixture-spawn-error', { code: error.code }); this.finish(); return; }
      this.emit('spawn'); note('fixture-child-spawn');
      if (this.runtimeProofEnabled) this.proof.write(JSON.stringify(this.fixtureProof('before', null)) + '\n');
      if (!this.noHello) this.stdout.write(JSON.stringify(this.kind === 'receive'
        ? { type: 'hello', revision: 1, profileId: 'app:nec-inverse-byte-demodulated-nominal/1', mode: 'LIRC_MODE_MODE2', resolutionMicros: 1, carrierMeasurement: false }
        : { type: 'hello', revision: 1, profileId: 'app:nec-inverse-byte-command-one-shot/1', carrierRanges: [{ minHz: 38000, maxHz: 38000 }] }) + '\n');
    });
  }
  fixtureProof(phase, exitCode) {
    const { executable, argv, options } = this.launchSpec;
    const producer = realpathSync(argv[2]), observer = realpathSync(fileURLToPath(argv[1]));
    return { schemaVersion: 1, phase, nonce: this.wrongProofNonce ? '0'.repeat(32) : options.env.IR_OBSERVER_NONCE, epoch: Number(options.env.IR_OBSERVER_EPOCH),
      pid: this.pid, ppid: process.pid, nodeVersion: process.version, platform: process.platform, architecture: process.arch,
      execPath: executable, executable: realpathSync(executable), executableSha256: hash(readFileSync(executable)), argv: [executable, producer],
      execArgv: argv.slice(0, 2), cwd: realpathSync(options.cwd), environment: this.environmentTransform ? this.environmentTransform(options.env, phase) : { ...options.env }, producer, producerSha256: hash(readFileSync(producer)),
      observer, observerSha256: hash(readFileSync(observer)), clockDomain: { timeOrigin: performance.timeOrigin }, exitCode };
  }
  command(message) {
    note('fixture-protocol-command', { message });
    this.commands ??= []; this.commands.push(message);
    const reply = value => setImmediate(() => { if (!this.stdout.destroyed) this.stdout.write(JSON.stringify(value) + '\n'); });
    if (message.type === 'open') reply({ type: 'ready', generation: message.generation, token: message.token });
    if (message.type === 'stop') reply({ type: 'stopped', generation: message.generation, token: message.token });
    if (message.type === 'capture' || message.type === 'emit') {
      assert.deepEqual(Object.keys(message).sort(), (message.type === 'capture' ? ['type','generation','token','operationId','deadline'] : ['type','generation','token','operationId','deadline','envelope','sha256']).sort());
      const opening = this.commands.find(item => item.type === 'open');
      assert.equal(message.generation, opening.generation); assert.equal(message.token, opening.token);
      assert.equal(message.operationId, 'direct-owned-operation'); assert.ok(message.deadline > performance.now());
      if (message.type === 'emit') { const bytes = Buffer.from(message.envelope, 'base64'); assert.deepEqual(bytes, envelopeFixture()); assert.equal(message.sha256, hash(bytes)); }
      if (!this.noOperationReply) reply(message.type === 'capture' ? { type: 'capture', operationId: message.operationId, packets: packetsFixture() } : { type: 'completed', operationId: message.operationId, sha256: message.sha256, providerEvidence: 'software-pattern-completed' });
    }
    if (message.type === 'close') {
      if (this.exitBeforeClosedData) {
        // The producer wrote closed before exit; its pipe data is delivered later in the parent.
        if (this.runtimeProofEnabled) this.proof.write(JSON.stringify(this.fixtureProof('after', 0)) + '\n');
        this.exitCode = 0; this.emit('exit', 0, null); note('fixture-exit-before-buffered-closed-data');
      }
      reply({ type: 'closed' });
      setImmediate(() => this.finish());
    }
  }
  finish() {
    if (!this.failedSpawn && this.exitCode === null) { if (this.runtimeProofEnabled) this.proof.write(JSON.stringify(this.fixtureProof('after', 0)) + '\n'); this.exitCode = 0; this.emit('exit', 0, null); note('fixture-child-exit'); }
    this.stdin.destroy(); this.stderr.end(); this.proof.end();
    if (!this.runtimeProofEnabled) { this.stderr.destroy(); this.proof.destroy(); }
    if (!this.holdStdoutClose) { this.stdout.end(); if (!this.runtimeProofEnabled) this.stdout.destroy(); }
    if (!this.holdChildClose && !this.closed) { this.closed = true; this.emit('close', this.failedSpawn ? -2 : 0, null); note('fixture-child-close', { failedSpawn: Boolean(this.failedSpawn) }); }
  }
  releaseAll(error) {
    for (const item of this.stdin.holds) if (!item.completed) item.release(error);
    this.holdStdoutClose = false; this.holdChildClose = false; this.finish();
  }
  kill(signal) { this.killCount++; note('fixture-kill-request', { signal }); return true; }
}

async function factoryModule(kind, phase, spawnBinding, readBoundary) {
  const relative = `examples/ir-${kind}/consumer.mjs`;
  const original = join(root, relative);
  const path = join(scratch, phase, relative);
  const source = readFileSync(path, 'utf8');
  const evaluated = source.includes('export function softwareProvider') ? source : `${source}\nexport { softwareProvider };\n`;
  const start = source.indexOf('function softwareProvider'); const end = source.indexOf('\nexport async function runIr', start);

  note('factory-source', { phase, path, fullSha256: hash(Buffer.from(source)), bodySha256: hash(Buffer.from(source.slice(start, end))), evaluatedSha256: hash(Buffer.from(evaluated)) });
  const factory = new vm.SourceTextModule(evaluated, { identifier: pathToFileURL(original).href, initializeImportMeta(meta) {
    meta.url = pathToFileURL(path).href; meta.filename = path;
  } });
  const requireFromOriginal = createRequire(original);
  await factory.link(async specifier => {
    let values;
    if (specifier === 'node:child_process') values = { ...(await import(specifier)), spawn: spawnBinding };
    else if (specifier === 'node:fs' && readBoundary) values = { ...(await import(specifier)), readFileSync: (...args) => { const bytes = readFileSync(...args); readBoundary(args[0]); return bytes; } };
    else if (specifier.startsWith('node:')) values = await import(specifier);
    else {
      const resolved = realpathSync(specifier.startsWith('.') ? resolve(dirname(original), specifier) : requireFromOriginal.resolve(specifier));
      if (specifier === '@101/connect') assert.ok(allowedPackages.some(name => resolved.startsWith(join(root, 'packages', name) + '/')), 'public graph outside permitted seven packages');
      else assert.ok(resolved === join(root, 'packages/hub-server/src', `nec32-ir-${kind}-gateway.ts`), 'unapproved relative module');
      note('actual-module-link', { specifier, resolved });
      values = await import(pathToFileURL(resolved).href);
    }
    const names = Object.keys(values); const forwarded = new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, values[name]); });
    return forwarded;
  });
  await factory.evaluate(); note('factory-module-setup-valid'); return factory.namespace.softwareProvider;
}

async function fixtureCase(kind, phase, caseName) {
  trace.length = 0; let factoryResult, fixture, optionsSeen, reentrantCloseDone = false, originalOpen, originalOpenOutcome;
  const helperPin = { path: fileURLToPath(import.meta.url), sha256: hash(readFileSync(fileURLToPath(import.meta.url))) };
  note('helper-source-pin', helperPin);
  const spawnBinding = (executable, argv, options) => {
    optionsSeen = { executable, argv, options }; note('actual-factory-spawn-call', { executable, argv, options });
    fixture = new FixtureChild(kind, { holdChildClose: ['close', 'stop'].includes(caseName) || (phase === 'candidate' && ['startup', 'reentry'].includes(caseName)), holdStdoutClose: ['close', 'stop', 'failed-spawn'].includes(caseName) || (phase === 'candidate' && ['startup', 'reentry'].includes(caseName)), holdWriteType: ['write', 'write-error'].includes(caseName) ? 'close' : undefined, noHello: caseName === 'startup', failedSpawn: caseName === 'failed-spawn' });
    fixture.wrongProofNonce = caseName === 'proof';
    fixture.launchSpec = { executable, argv, options }; fixture.runtimeProofEnabled = argv[0] === '--import';
    if (fixture.failedSpawn) fixture.pid = undefined;
    if (caseName === 'reentry') { const returned = factoryResult.provider.close(); returned.then(() => { reentrantCloseDone = true; }, () => { reentrantCloseDone = true; }); note('close-during-spawn', { promise: typeof returned?.then === 'function' }); }
    fixture.start(); return fixture;
  };
  const factory = await factoryModule(kind, phase, spawnBinding); factoryResult = factory();
  const controller = new AbortController(); const context = { generation: 1, purpose: 'owned fixture only', deadline: performance.now() + 500, signal: controller.signal };
  try {
    if (caseName === 'reentry') {
      const result = factoryResult.provider.open(context); result.catch(() => {}); await turn(); await turn();
      assert.equal(reentrantCloseDone, false, 'IR-FACTORY-RED-SPAWN-REENTRY: pre-callout close must reserve and adopt the returning exact child');
    } else if (['startup', 'failed-spawn', 'proof'].includes(caseName)) {
      let rejected = false;
      if (caseName === 'failed-spawn') {
        const openedAt = performance.now(); note('original-open-call-reserved');
        originalOpen = factoryResult.provider.open(context);
        originalOpenOutcome = Promise.resolve(originalOpen).then(value => ({ state: 'fulfilled', value }), error => ({ state: 'rejected', error: { name: error.name, code: error.code, message: error.message } }));
        const outcome = await originalOpenOutcome; rejected = outcome.state === 'rejected';
        note('original-open-outcome', { ...outcome, elapsedMs: performance.now() - openedAt, originalHelloBudgetMs: 1500 });
      } else { try { await factoryResult.provider.open(context); } catch { rejected = true; } }
      assert.equal(rejected, true, 'startup observation must fail before oracle'); note('startup-observation-precondition-valid');
      let rawDone = false; factoryResult.provider.whenSettled().then(() => { rawDone = true; }, () => { rawDone = true; }); await turn();
      if (caseName !== 'proof') assert.equal(rawDone, false, caseName === 'startup' ? 'IR-FACTORY-RED-STARTUP: startup failure must retain uncertain child and raw settlement' : 'IR-FACTORY-RED-FAILED-SPAWN: raw settlement must retain the actually held created stdout stream after recognized failed spawn');
    } else {
      assert.equal(await factoryResult.provider.open(context), 'ready', 'fixture open precondition'); note('open-precondition-valid');
      if (caseName === 'restart') {
        assert.deepEqual(Object.keys(factoryResult.status()).sort(), ['childRunning', 'timers', 'waiters']);
        assert.equal(typeof factoryResult.provider[kind === 'receive' ? 'capture' : 'transmit'], 'function');
        assert.equal(factoryResult.provider.supported, true);
        const firstFixture = fixture, firstRaw = factoryResult.provider.whenSettled(), firstNonce = factoryResult.runtimeProof().before.nonce;
        await assert.rejects(factoryResult.provider.open({ ...context, generation: 2, deadline: performance.now() + 500 }), /busy/);
        assert.equal(factoryResult.spawnCount(), 1, 'busy admission must not launch a second child');
        assert.equal(factoryResult.provider.close(), firstRaw); await firstRaw;
        const firstLegs = await Promise.allSettled([firstFixture.childCloseObservation, ...firstFixture.streamCloseObservations,
          ...firstFixture.stdin.holds.map(item => item.observation)]);
        assert.ok(firstLegs.every(item => item.status === 'fulfilled')); assert.equal(factoryResult.lifecycleStatus().rawPending, 0);
        note('candidate-first-epoch-cleanup-joined', { status: factoryResult.lifecycleStatus(), actualFixtureLegCount: firstLegs.length });
        assert.equal(await factoryResult.provider.open({ ...context, generation: 2, deadline: performance.now() + 500 }), 'ready');
        assert.notEqual(factoryResult.provider.whenSettled(), firstRaw); assert.notEqual(factoryResult.runtimeProof().before.nonce, firstNonce);
        assert.equal(factoryResult.lifecycleStatus().epoch, 2); assert.equal(factoryResult.spawnCount(), 2);
        await factoryResult.provider.close();
        assert.deepEqual(kind === 'receive' ? factoryResult.commands : factoryResult.sentTypes, ['open', 'stop', 'close', 'open', 'stop', 'close']);
        note('candidate-restart-contract-verified', { exactTwoAdoptions: true, rawEpochsDistinct: true, nonceEpochsDistinct: true });
      }
      else if (caseName === 'env') {
        assert.ok(optionsSeen.options.env && optionsSeen.argv[0] === '--import', 'IR-FACTORY-RED-ENV: child startup must specify exact sanitized environment and pins');
        if (phase === 'candidate') {
          assert.deepEqual(Object.keys(optionsSeen.options.env).sort(), ['LANG', 'LC_ALL', 'TZ', 'IR_OBSERVER_NONCE', 'IR_OBSERVER_EPOCH', 'IR_OBSERVER_EXECUTABLE', 'IR_OBSERVER_EXECUTABLE_SHA256', 'IR_OBSERVER_PRODUCER', 'IR_OBSERVER_PRODUCER_SHA256', 'IR_OBSERVER_OBSERVER', 'IR_OBSERVER_OBSERVER_SHA256', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])].sort());
          if (process.platform === 'darwin') assert.equal(optionsSeen.options.env.__CF_USER_TEXT_ENCODING, `0x${process.getuid().toString(16).toUpperCase()}:0:0`);
          assert.deepEqual([optionsSeen.options.env.LANG, optionsSeen.options.env.LC_ALL, optionsSeen.options.env.TZ], ['C', 'C', 'UTC']);
          assert.deepEqual(optionsSeen.options.stdio, ['pipe', 'pipe', 'pipe', 'pipe']); assert.equal(optionsSeen.options.shell, false); assert.equal(optionsSeen.options.detached, false);
          assert.equal(optionsSeen.options.windowsHide, true); assert.deepEqual(optionsSeen.argv.slice(0, 2), ['--import', pathToFileURL(realpathSync(fileURLToPath(optionsSeen.argv[1]))).href]);
          // End the env-only fixture through the real provider close protocol before releaseAll.
          await factoryResult.provider.close();
        }
      }
      else {
        let closeDone = false;
        if (caseName === 'stop') factoryResult.provider.stop();
        const closing = factoryResult.provider.close();
        if (phase === 'candidate') {
          assert.equal(closing, factoryResult.provider.close(), 'per-epoch close Promise must be shared');
          assert.equal(closing, factoryResult.provider.whenSettled(), 'settlement must name the actual raw epoch barrier');
          assert.equal(factoryResult.lifecycleStatus().fenced, true, 'close/stop must synchronously fence admission');
        }
        closing.then(() => { closeDone = true; }, () => { closeDone = true; });
        await turn(); await turn(); await turn();
        if (['write', 'write-error'].includes(caseName)) {
          const pending = fixture.stdin.holds.filter(v => !v.completed);
          assert.deepEqual(pending.map(v => v.type), ['close'], 'actual Writable held close completion precondition');
          assert.ok(trace.some(v => v.event === 'actual-stream-close' && v.index === 0), 'actual Writable close before held completion precondition');
          note('write-oracle-precondition-valid', { pendingInternal: pending.length, callerCallbackPresent: trace.find(v => v.event === 'actual-write-call' && v.type === 'close').callerCallback });
          assert.equal(closeDone, false, 'IR-FACTORY-RED-WRITE: raw settlement must retain the genuinely issued write');
        } else assert.equal(closeDone, false, 'IR-FACTORY-RED-CLOSE: close must stay pending while actual child close or any adopted stdio close is held');
      }
    }
    return { helperPin, status: 'pass', kind, phase, caseName, trace: [...trace] };
  } finally {
    if (phase === 'old' && caseName === 'failed-spawn') {
      assert.ok(fixture && fixture.failedSpawn && fixture.pid === undefined && !fixture.spawnObserved &&
        fixture.spawnErrors.length === 1 && fixture.spawnErrors[0].code === 'ENOENT' && !fixture.exitObserved,
        'recognized old failed-spawn cleanup precondition');
      assert.ok(originalOpen && originalOpenOutcome, 'original open promise/outcome must be retained');
      assert.equal(fixture.holdChildClose, false, 'this schedule holds stdout only, not child close');
      assert.equal(fixture.stdin.holds.length, 0, 'failed-spawn schedule must issue no internal Writable work');
      assert.equal(trace.filter(item => item.event === 'actual-write-call').length, 0, 'failed-spawn schedule must issue no protocol writes');
      const actualInternalWrites = fixture.stdin.holds.map(item => item.observation);
      fixture.releaseAll();
      const joined = await Promise.allSettled([fixture.childCloseObservation, ...fixture.streamCloseObservations,
        ...actualInternalWrites, originalOpenOutcome]);
      const errors = joined.filter(item => item.status === 'rejected').map(item => item.reason);
      // eslint-disable-next-line no-unsafe-finally -- Cleanup assertion failure must keep this fixture failed.
      if (errors.length) throw new AggregateError(errors, 'old failed-spawn fixture cleanup did not join every exact leg');
      assert.deepEqual(fixture.observedChildClose, { code: -2, signal: null }, 'actual failed-spawn child close outcome');
      assert.equal(fixture.exitObserved, false, 'failed-spawn must not fabricate exit');
      assert.equal(fixture.stdin.holds.length, 0, 'failed-spawn cleanup cannot issue an internal write');
      const status = factoryResult.status();
      assert.equal(status.waiters, 0, 'original open must naturally retire every actual waiter');
      assert.equal(status.timers, 0, 'original open must naturally retire every actual timer');
      assert.equal(status.childRunning, kind === 'receive', 'truthful old residual child reference must remain visible');
      note('old-only-failed-spawn-cleanup-joined', { outcome: 'recognized-fixture-no-process', actualChildClose: fixture.observedChildClose,
        actualStreamCloses: joined.slice(1, 1 + fixture.stdio.length).map(item => item.value),
        actualInternalWriteCount: actualInternalWrites.length, originalOpenOutcome: joined.at(-1).value,
        status, unsafeOldCloseSkipped: true, heldChildClose: false, heldStream: 'stdout',
        extraProofStream: 'test-owned fixture work; no old fd3 runtime evidence' });
    } else {
      if (fixture) fixture.releaseAll(caseName === 'write-error' ? Error('owned actual Writable completion error') : undefined);
      await turn(); await turn();
      // eslint-disable-next-line no-unsafe-finally -- Missing actual terminal proof must keep this fixture failed.
      if (fixture && fixture.exitCode === null && !(fixture.failedSpawn && fixture.closed)) throw Error('fixture cleanup did not observe terminal');
      if (factoryResult) {
        let rawError; try { await factoryResult.provider.close(); } catch (error) { rawError = { name: error.name, message: error.message }; }
        if (phase === 'candidate') {
          const legs = await Promise.allSettled([fixture.childCloseObservation, ...fixture.streamCloseObservations, ...fixture.stdin.holds.map(item => item.observation)]);
          assert.ok(legs.every(item => item.status === 'fulfilled'), 'candidate actual fixture joins must complete');
          const status = factoryResult.lifecycleStatus();
          assert.equal(status.rawPending, 0, 'candidate raw ownership must be joined'); assert.equal(status.pendingWrites, 0);
          assert.equal(status.waiters, 0); assert.equal(status.timers, 0); assert.equal(status.childRunning, false);
          assert.ok(status.streams.every(item => item.closed), 'candidate must retain every adopted stream until close');
          if (['close', 'write', 'env', 'stop', 'restart'].includes(caseName)) assert.equal(rawError, undefined, 'clean candidate fixture closure must succeed');
          if (caseName === 'failed-spawn') { assert.equal(status.noProcessConfirmed, true); assert.equal(status.terminal, null); assert.ok(rawError); }
          if (caseName === 'proof') assert.ok(rawError, 'invalid actual origin must survive complete cleanup');
          if (caseName === 'write-error') assert.ok(rawError, 'actual write error must survive raw join');
          note('candidate-cleanup-joined', { status, rawError, proof: factoryResult.runtimeProof(), fixtureOnlyOrigin: true });
        }
      }
    }
    note('fixture-cleanup-complete');
  }
}

function packetsFixture() {
  const out = [0x01000000 | 9000, 4500];
  for (const byte of [0x34, 0xcb, 0xa2, 0x5d]) for (let bit = 0; bit < 8; bit++) out.push(0x01000000 | 560, byte >>> bit & 1 ? 1690 : 565);
  out.push(0x01000000 | 560, 0x03000000 | 20000); return out;
}
function envelopeFixture() {
  const bytes = Buffer.alloc(282); bytes.write('IRN1'); bytes.writeUInt32BE(38000, 4);
  Buffer.from([0x34, 0xcb, 0xa2, 0x5d]).copy(bytes, 8); bytes.writeUInt16BE(67, 12);
  const timings = packetsFixture().slice(0, -1).map(value => value & 0x00ffffff);
  timings.forEach((value, index) => bytes.writeUInt32BE(value, 14 + index * 4)); return bytes;
}
async function observe(promise, turns = 6) {
  const result = { state: 'pending' }; promise.then(value => Object.assign(result, { state: 'fulfilled', value }), error => Object.assign(result, { state: 'rejected', error: { name: error.name, message: error.message } }));
  for (let i = 0; i < turns; i++) await turn(); return result;
}
async function lifecycleCase(kind, phase, caseName) {
  trace.length = 0; let result, fixture, spawnCalls = 0, originalOutcome, failure, preflightArmed = false;
  const controller = new AbortController(), nativeAdd = controller.signal.addEventListener, nativeRemove = controller.signal.removeEventListener;
  const context = { generation: 1, purpose: 'owned fixture only', deadline: performance.now() + 800, signal: controller.signal };
  const factory = await factoryModule(kind, phase, (executable, argv, options) => {
    spawnCalls++; note('actual-factory-spawn-call', { executable, argv, options });
    if (caseName === 'sync-spawn-throw') { note('issued-spawn-callout-throws-without-handle'); throw Error('owned synchronous spawn uncertainty'); }
    fixture = new FixtureChild(kind, { holdChildClose: caseName.startsWith('direct-') && caseName !== 'direct-success', holdStdoutClose: caseName.startsWith('direct-') && caseName !== 'direct-success', holdWriteType: caseName.startsWith('direct-') ? (kind === 'receive' ? 'capture' : 'emit') : undefined, noOperationReply: caseName === 'direct-cancel', exitBeforeClosedData: caseName === 'exit-drain' });
    fixture.launchSpec = { executable, argv, options }; fixture.runtimeProofEnabled = true; fixture.start(); return fixture;
  }, path => {
    if (preflightArmed && ['preflight-deadline','preflight-abort'].includes(caseName)) {
      preflightArmed = false; note('actual-read-completed-before-preflight-boundary', { path });
      if (caseName === 'preflight-abort') controller.abort();
      else while (performance.now() <= context.deadline) { /* Cross the real deadline without replacing the clock. */ }
      note('real-preflight-retirement', { caseName, aborted: controller.signal.aborted, deadline: context.deadline, observed: performance.now() });
    }
  });
  result = factory();
  let retirement;
  if (['add-reentry', 'add-abort', 'add-throw', 'deadline'].includes(caseName)) {
    Object.defineProperty(controller.signal, 'addEventListener', { value(...args) {
      note('own-branded-signal-add-enter', { caseName });
      if (caseName === 'add-reentry') { retirement = result.provider.close(); void retirement.catch(() => {}); note('pre-spawn-retirement', { status: result.lifecycleStatus() }); }
      if (caseName === 'add-abort') { controller.abort(); note('real-controller-aborted', { aborted: controller.signal.aborted }); }
      if (caseName === 'add-throw') { note('original-registration-throw'); throw Error('owned signal registration fault'); }
      const returned = Reflect.apply(nativeAdd, this, args);
      if (caseName === 'deadline') { while (performance.now() <= context.deadline) { /* Cross the real deadline without replacing the clock. */ } note('real-deadline-crossed-in-registration', { deadline: context.deadline, observed: performance.now() }); }
      return returned;
    } });
    if (caseName === 'deadline') context.deadline = performance.now() + 25;
  }
  if (['remove-throw','remove-before-throw'].includes(caseName)) Object.defineProperty(controller.signal, 'removeEventListener', { value(...args) { if (caseName !== 'remove-before-throw') Reflect.apply(nativeRemove, this, args); note('original-retirement-throw'); throw Error('owned signal retirement fault'); } });
  try {
    preflightArmed = true; if (caseName === 'preflight-deadline') context.deadline = performance.now() + 25;
    originalOutcome = await observe(result.provider.open(context));
    if (caseName === 'sync-spawn-throw') {
      assert.equal(originalOutcome.state, 'rejected'); assert.equal(spawnCalls, 1); assert.equal(result.lifecycleStatus().spawnUnconfirmed, true);
      await assert.rejects(result.provider.open({ ...context, deadline: performance.now() + 800 }), /busy/);
      assert.equal(spawnCalls, 1); assert.equal((await observe(result.provider.whenSettled())).state, 'pending');
      note('truthful-unconfirmed-spawn-reservation', { status: result.lifecycleStatus(), noHandle: true });
    } else if (['add-reentry','add-abort','deadline','preflight-deadline','preflight-abort'].includes(caseName)) {
      assert.equal(spawnCalls, 0, 'IR-LIFECYCLE-RED: admission must not spawn after pre-spawn retirement, real abort or elapsed deadline');
      assert.equal(originalOutcome.state, 'rejected');
    } else if (caseName === 'add-throw') {
      assert.equal(originalOutcome.state, 'rejected'); assert.equal(spawnCalls, 0);
      assert.equal(result.lifecycleStatus().operations, 0, 'IR-LIFECYCLE-RED: throwing activity acquisition must roll back operation reservation');
    } else if (['remove-throw','remove-before-throw'].includes(caseName)) {
      assert.equal(originalOutcome.state, 'rejected');
      assert.equal(result.lifecycleStatus().operations, 0, 'IR-LIFECYCLE-RED: throwing listener retirement must still retire operation reservation');
    } else {
      assert.equal(originalOutcome.state, 'fulfilled', 'fixture open must complete'); assert.equal(originalOutcome.value, 'ready');
      if (caseName === 'exit-drain') {
        const closing = result.provider.close(); const closed = await observe(closing);
        assert.equal(closed.state, 'fulfilled', 'IR-LIFECYCLE-RED: exit before buffered closed data must drain graceful protocol before deciding failure');
      } else if (caseName.startsWith('operation-')) {
        const operationController = new AbortController();
        Object.defineProperty(operationController.signal, caseName === 'operation-add-throw' ? 'addEventListener' : 'removeEventListener', { value() { note('direct-activity-fault', { caseName }); throw Error('owned direct signal activity fault'); } });
        const operation = { ...context, deadline: performance.now() + 800, signal: operationController.signal, operationId: 'direct-owned-operation' };
        const invocation = kind === 'receive' ? result.provider.capture(operation) : result.provider.transmit(envelopeFixture(), operation);
        const outcome = await observe(invocation); assert.equal(outcome.state, 'rejected');
        assert.equal(result.lifecycleStatus().operations, 0, 'IR-LIFECYCLE-RED: direct activity fault must retire its operation reservation');
        if (caseName === 'operation-add-throw') assert.equal(fixture.commands.filter(item => ['capture','emit'].includes(item.type)).length, 0);
        note('direct-activity-outcome', { outcome, status: result.lifecycleStatus() });
      } else if (caseName.startsWith('direct-')) {
        const operationController = new AbortController(); const operation = { ...context, deadline: performance.now() + 800, signal: operationController.signal, operationId: 'direct-owned-operation' };
        const operationPromise = kind === 'receive' ? result.provider.capture(operation) : result.provider.transmit(envelopeFixture(), operation);
        const held = await observe(operationPromise); assert.equal(held.state, 'pending', 'matching reply cannot release actual held Writable completion');
        const pending = fixture.stdin.holds.find(item => !item.completed); assert.equal(pending.type, kind === 'receive' ? 'capture' : 'emit');
        if (caseName === 'direct-success') {
          pending.release(); const outcome = await observe(operationPromise); assert.equal(outcome.state, 'fulfilled'); assert.deepEqual(outcome.value, kind === 'receive' ? packetsFixture() : 'completed'); await result.provider.close();
        } else {
          if (caseName === 'direct-cancel') operationController.abort();
          const closing = result.provider.close();
          await turn(); await turn(); await turn();
          assert.equal((await observe(closing)).state, 'pending'); assert.ok(result.lifecycleStatus().pendingWrites >= 1);
          note('held-operation-write-delays-serialized-cleanup', { status: result.lifecycleStatus() });
          if (caseName === 'direct-error') pending.release(Error('owned operation actual write error')); else pending.release();
          const outcome = await observe(operationPromise); fixture.finish(); assert.ok(result.lifecycleStatus().terminal, 'actual fixture terminal observed while stdout and child close remain held'); assert.ok(outcome.state === 'rejected' || (kind === 'emitter' && outcome.value === 'rejected'));
          assert.equal((await observe(closing)).state, 'pending', 'terminal and write join must not release held stdout/child close');
        }
      }
    }
  } catch (error) { failure = error; }
  finally {
    // No raw settlement is synthesized. Every issued fixture handle and internal write joins independently.
    const raw = result.provider.close(); void raw.catch(() => {}); await turn(); await turn(); await turn();
    if (fixture) {
      fixture.releaseAll();
      const joins = await Promise.allSettled([fixture.childCloseObservation, ...fixture.streamCloseObservations, ...fixture.stdin.holds.map(item => item.observation)]);
      assert.ok(joins.every(item => item.status === 'fulfilled')); note('independent-exact-fixture-legs-joined', { joins });
    }
    const rawOutcome = await observe(raw), status = result.lifecycleStatus();
    note('method-and-raw-outcomes', { originalOutcome, rawOutcome, status, spawnCalls, fixtureOnlyOrigin: true });
    if (caseName === 'remove-before-throw' && rawOutcome.state !== 'pending') {
      const failures = status.failures.length; controller.abort();
      assert.equal(result.lifecycleStatus().failures.length, failures, 'IR-LIFECYCLE-RED: throwing own listener removal must still remove the real listener before raw settlement');
    }
    if (phase === 'candidate' && caseName !== 'sync-spawn-throw') {
      assert.equal(status.operations, 0); assert.equal(status.pendingWrites, 0); assert.equal(status.waiters, 0); assert.equal(status.timers, 0); assert.equal(status.rawPending, 0);
      if (spawnCalls === 0) assert.equal(status.noProcessConfirmed, true);
      if (['add-throw','remove-throw','remove-before-throw'].includes(caseName)) { assert.equal(rawOutcome.state, 'rejected'); assert.ok(status.failures.some(item => /signal (registration|retirement) fault/.test(item))); }
    }
    if (['before','repair1'].includes(phase) && ['add-throw','remove-throw'].includes(caseName)) note('old-stuck-reservation-retained-without-rescue', { status, rawOutcome });
  }
  if (failure) throw failure;
  return { status: 'pass', kind, phase, caseName, trace: [...trace] };
}
function recordedEnvironmentFact() {
  const facts = JSON.parse(readFileSync(join(scratch, 'recorded-env-facts.json')));
  assert.deepEqual(facts.records.map(record => record.platform), ['darwin', 'darwin']);
  assert.deepEqual(facts.records.map(record => record.extraValue), ['0x1F5:0:0', '0x1F5:0:0']);
  const uid = process.getuid(); assert.equal(uid, 501, 'retained macOS record must match trusted current UID');
  assert.equal(`0x${uid.toString(16).toUpperCase()}:0:0`, facts.records[0].extraValue);
  note('recorded-environment-fact', { source: join(scratch, facts.source), sourceSha256: hash(readFileSync(join(scratch, facts.source))), extraKey: facts.records[0].extraKey, extraValue: facts.records[0].extraValue, trustedHostUid: uid, fixtureOnly: true });
  return facts.records[0].extraValue;
}
async function environmentalCase(kind, phase, caseName) {
  trace.length = 0; const observedTextEncoding = recordedEnvironmentFact(); let fixture, result, failure, openOutcome;
  const factory = await factoryModule(kind, phase, (executable, argv, options) => {
    note('actual-factory-spawn-call', { executable, argv, options });
    fixture = new FixtureChild(kind); fixture.launchSpec = { executable, argv, options }; fixture.runtimeProofEnabled = true;
    fixture.environmentTransform = (environment, proofPhase) => {
      const value = { ...environment, __CF_USER_TEXT_ENCODING: observedTextEncoding };
      if (caseName === 'env-extra') value.UNAPPROVED_EXTRA = 'fixture-only-extra';
      if (caseName === 'env-missing') delete value.__CF_USER_TEXT_ENCODING;
      if (caseName === 'env-changed' || (caseName === 'env-after-changed' && proofPhase === 'after')) value.__CF_USER_TEXT_ENCODING = '0x1F5:1:0';
      note('fixture-readback-environment', { proofPhase, environment: value, fromRetainedRawExtraKey: true, fixtureOnlyOrigin: true }); return value;
    };
    fixture.start(); return fixture;
  });
  result = factory(); const controller = new AbortController(); const context = { generation: 1, purpose: 'environment fixture only', deadline: performance.now() + 800, signal: controller.signal };
  try {
    openOutcome = await observe(result.provider.open(context));
    if (caseName === 'env-recorded') {
      assert.equal(openOutcome.state, 'fulfilled', 'IR-LIFECYCLE-RED: parent must explicitly enroll retained macOS startup text encoding in its exact environment plan');
      assert.equal(openOutcome.value, 'ready');
      assert.equal(fixture.launchSpec.options.env.__CF_USER_TEXT_ENCODING, '0x1F5:0:0');
      await result.provider.close();
    } else if (caseName === 'env-after-changed') { assert.equal(openOutcome.state, 'fulfilled'); await observe(result.provider.close()); }
    else assert.equal(openOutcome.state, 'rejected', 'unapproved extra/missing/changed environment must reject open');
  } catch (error) { failure = error; }
  finally {
    const raw = result.provider.close(); void raw.catch(() => {}); await turn(); await turn(); await turn();
    fixture.releaseAll(); const joins = await Promise.allSettled([fixture.childCloseObservation, ...fixture.streamCloseObservations, ...fixture.stdin.holds.map(item => item.observation)]);
    assert.ok(joins.every(item => item.status === 'fulfilled')); const rawOutcome = await observe(raw), status = result.lifecycleStatus();
    assert.equal(status.rawPending, 0); assert.equal(status.operations, 0); assert.equal(status.pendingWrites, 0); assert.equal(status.waiters, 0); assert.equal(status.timers, 0);
    if (phase === 'candidate') assert.equal(rawOutcome.state, caseName === 'env-recorded' ? 'fulfilled' : 'rejected');
    note('environment-fixture-independent-join', { openOutcome, rawOutcome, joins, status, fixtureOnlyOrigin: true });
  }
  if (failure) throw failure; return { status: 'pass',kind,phase,caseName,trace: [...trace] };
}
async function observerEnvironmentCase(kind, phase, caseName) {
  trace.length = 0; recordedEnvironmentFact();
  const sourcePath = join(scratch, phase, 'tools/qa-ir-provider-runtime-observer.mjs'), source = readFileSync(sourcePath, 'utf8'); let evaluated, ranges;
  if (source.includes('function validateRuntimeEnvironment(')) {
    const start = source.indexOf('function validateRuntimeEnvironment('), end = source.indexOf('\n// The imported branch', start);
    evaluated = `(${source.slice(start,end)})`; ranges = [{startByte: Buffer.byteLength(source.slice(0,start)),endExclusiveByte: Buffer.byteLength(source.slice(0,end)),sha256:hash(Buffer.from(source.slice(start,end)))}];
  } else {
    // Exercise only the retained observer's exact pure key/value assertions, never its install/emit branch.
    const keysStart = source.indexOf('  const expectedKeys = '), keysEnd = source.indexOf('\n  const emit =',keysStart);
    const checkStart = source.indexOf('    assert.deepEqual(Object.keys(record.environment)'), checkEnd = source.indexOf('\n    assert.match(record.nonce', checkStart);
    evaluated = `(environment => { const record = {environment}; ${source.slice(keysStart,keysEnd)} ${source.slice(checkStart,checkEnd)} })`;
    ranges = [[keysStart,keysEnd],[checkStart,checkEnd]].map(([start,end])=>({startByte:Buffer.byteLength(source.slice(0,start)),endExclusiveByte:Buffer.byteLength(source.slice(0,end)),sha256:hash(Buffer.from(source.slice(start,end)))}));
  }
  note('observer-environment-evaluated-source', {path:sourcePath,fullSha256:hash(Buffer.from(source)),evaluatedSha256:hash(Buffer.from(evaluated)),ranges,installBranchExecuted:false});
  const validate = new vm.Script(evaluated).runInNewContext({ assert });
  const records = readFileSync(join(scratch,'actual-red/actual-failure-fd3.bin'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  for (const record of records) {
    let error;try {validate({...record.environment}, 'darwin', process.getuid());}catch(caught){error=caught;}
    note('retained-raw-environment-validation', {phase:record.phase,error:error?.message??null});
    assert.equal(error,undefined,'IR-LIFECYCLE-RED: observer expected keys must explicitly admit trusted macOS startup text encoding');
  }
  if (phase === 'candidate') {
    const valid = {...records[0].environment};
    for (const [label,environment] of [['extra',{...valid,UNAPPROVED_EXTRA:'blocked'}],['missing',Object.fromEntries(Object.entries(valid).filter(([key])=>key!=='__CF_USER_TEXT_ENCODING'))],['changed',{...valid,__CF_USER_TEXT_ENCODING:'0x1F5:1:0'}]]) {assert.throws(()=>validate(environment,'darwin',501));note('observer-env-negative-rejected',{label});}
    const portable = Object.fromEntries(Object.entries(valid).filter(([key])=>key!=='__CF_USER_TEXT_ENCODING'));
    for (const platform of ['linux','win32']) {validate(portable,platform,undefined);assert.throws(()=>validate(valid,platform,undefined));note('portable-environment-contract',{platform,expectedKeyCount:11,syntheticPureCheckOnly:true});}
    assert.throws(()=>validate(valid,'darwin',undefined));assert.throws(()=>validate(valid,'darwin',-1));
  }
  return {status:'pass',kind,phase,caseName,trace:[...trace]};
}

async function main() {
  assert.equal(process.argv.length, 6, 'Fixture harness requires phase, case, fixture root and repository root');
  assert.ok(process.argv[4].startsWith('/') && process.argv[5].startsWith('/'), 'Fixture roots must be absolute');
  scratch = realpathSync(process.argv[4]); root = realpathSync(process.argv[5]);
  assert.notEqual(root, scratch); assert.ok(existsSync(join(scratch, 'logs')));
  assert.ok(allowedPackages.every(name => existsSync(join(root, 'packages', name))), 'Fixture repository public graph is unavailable');
  assert.equal(process.version, 'v24.14.0');
  assert.equal(hash(readFileSync(realpathSync(process.execPath))), '20a18709f0154d668f1bd6f6ea8c2a7ae001447b4b2c339732f22e57a8767a55');
  const phase = process.argv[2], caseName = process.argv[3]; assert.ok(['before','repair1','candidate'].includes(phase));
  const legacy = ['close','write','write-error','env','reentry','startup','failed-spawn','stop','proof','restart'];
  const additions = ['add-reentry','add-abort','add-throw','remove-throw','remove-before-throw','deadline','preflight-deadline','preflight-abort','exit-drain','direct-success','direct-error','direct-cancel','operation-add-throw','operation-remove-throw','sync-spawn-throw'];
  const environmental = ['env-recorded','env-extra','env-missing','env-changed','env-after-changed','observer-env-recorded'];
  assert.ok([...legacy, ...additions, ...environmental].includes(caseName)); const results = [];
  for (const kind of caseName === 'observer-env-recorded' ? ['observer'] : ['receive','emitter']) {
    let record;
    try { record = environmental.includes(caseName) ? (caseName === 'observer-env-recorded' ? await observerEnvironmentCase(kind,phase,caseName) : await environmentalCase(kind,phase,caseName)) : additions.includes(caseName) ? await lifecycleCase(kind, phase, caseName) : await fixtureCase(kind, phase, caseName); record.trace = [...trace]; }
    catch (error) { record = { status: error.code === 'ERR_ASSERTION' && error.message.startsWith('IR-LIFECYCLE-RED:') ? 'semantic-red' : 'setup-or-test-failure', kind, phase, caseName, error: { code: error.code, message: error.message, stack: error.stack }, trace: [...trace] }; }
    record.helperPin = { path: fileURLToPath(import.meta.url), sha256: hash(readFileSync(fileURLToPath(import.meta.url))) };
    writeFileSync(join(scratch,'logs', `${phase}-${caseName}-${kind}.json`), JSON.stringify(record,null,2)+'\n'); results.push(record);
    if (record.status === 'setup-or-test-failure') break;
  }
  console.log(JSON.stringify({phase,caseName,results:results.map(({trace:omitted,...record})=>{ void omitted; return record; }),realProcesses:0}));
  if (results.some(record => phase === 'candidate' ? record.status !== 'pass' : record.status === 'setup-or-test-failure')) process.exitCode=1;
}
const isMainEntry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMainEntry) await main();
else if (Object.hasOwn(process.env,'IR_OBSERVER_NONCE')) installRuntimeObserver();
