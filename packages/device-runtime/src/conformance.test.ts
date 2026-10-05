import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ConnectorConformanceHost, TrustedConnectorCandidate } from './conformance.ts';
import type { DeliveryContext, PublishOptions } from './types.ts';

const modulePath = './conformance.ts';
async function runners() {
  const sdk = await import(modulePath).catch(() => undefined);
  assert.ok(sdk, 'Public behavioral conformance runners must exist');
  return sdk as typeof import('./conformance.ts');
}

function descriptor(id: string, sink = false, reliable = false) {
  return { schemaVersion: 1, id, label: id, revision: 1,
    adapter: { id: 'vendor:local', version: '1.0.0' }, runtime: { platform: 'local-test' },
    capabilities: [{ id: 'state', semantic: 'vendor:state', schemaVersion: 1,
      kind: sink ? reliable ? 'command' : 'property' : reliable ? 'event' : 'sample',
      value: { type: 'boolean' },
      delivery: reliable ? { mode: 'reliable', maxAgeMs: 1000 } : { mode: 'latest', maxHz: 100, maxAgeMs: 1000 },
      permissions: [sink ? reliable ? 'invoke' : 'write' : 'subscribe'] }] };
}

function connector(mode: 'healthy' | 'leak' | 'bypass' | 'bad-feedback' | 'bad-result' | 'token-only-stop' | 'throw-release' | 'async-release' = 'healthy', reliable = false): TrustedConnectorCandidate {
  return { source: { device: descriptor('source', false, reliable), capability: 'state' },
    sink: { device: descriptor('sink', true, reliable), capability: 'state' },
    factory(host: ConnectorConformanceHost) {
      let dispose: (() => void) | undefined, current: DeliveryContext | undefined;
      return {
        start() { dispose = host.trackResource(); host.setReadiness('source', 'available'); host.setReadiness('sink', 'available'); },
        send(value: unknown, options?: PublishOptions) {
          if (mode === 'bypass') host.recordEffect(value);
          const result = host.publish(value, options);
          return mode === 'bad-result' ? { ok: true, value: { accepted: 10000, rejected: 0 } } : result;
        },
        apply(observation, context) { current = context; host.recordEffect(observation.value);
          context.reportEvidence(mode === 'bad-feedback' ? 'observed' : 'dispatched'); },
        feedback(evidence) { current?.reportEvidence(evidence); },
        release() {
          if (mode === 'throw-release') throw new Error('private-held-effect-release-failure');
          if (mode === 'async-release') return Promise.reject(new Error('private-deferred-release-failure'));
          current = undefined;
        },
        stop() { if (mode !== 'leak') dispose?.();
          if (mode !== 'token-only-stop') { host.setReadiness('source', 'unavailable'); host.setReadiness('sink', 'unavailable'); } },
      };
    } };
}

const connectorFixture = { values: [true, false], invalidValue: 'private-invalid-payload' };

test('healthy connector produces repeatable behavioral evidence for latest and reliable delivery', async () => {
  const { runConnectorConformance } = await runners();
  for (const reliable of [false, true]) {
    const first = await runConnectorConformance(connector('healthy', reliable), connectorFixture);
    assert.equal(first.outcome, 'passed', JSON.stringify(first));
    assert.deepEqual(await runConnectorConformance(connector('healthy', reliable), connectorFixture), first);
    assert.equal(first.checks.find(check => check.id === 'denied-grant')?.status, 'passed');
    assert.equal(first.checks.find(check => check.id === 'revoked-grant')?.status, 'passed');
    assert.equal(first.checks.find(check => check.id === 'delivery-limits')?.status, 'passed');
    assert.equal(first.checks.find(check => check.id === 'feedback')?.status, reliable ? 'passed' : 'not-applicable');
  }
});

test('connector effects that bypass a denied route fail the public suite', async () => {
  const report = await (await runners()).runConnectorConformance(connector('bypass'), connectorFixture);
  assert.equal(report.outcome, 'failed');
  assert.equal(report.checks.find(check => check.id === 'denied-grant')?.status, 'failed');
});

test('connector resource leaks and fabricated admission results fail honestly', async () => {
  const { runConnectorConformance } = await runners();
  const leaked = await runConnectorConformance(connector('leak'), connectorFixture);
  assert.equal(leaked.checks.find(check => check.id === 'stop')?.status, 'failed');
  const fabricated = await runConnectorConformance(connector('bad-result'), connectorFixture);
  assert.equal(fabricated.outcome, 'failed');
  assert.equal(fabricated.checks.find(check => check.id === 'delivery')?.status, 'failed');
});

test('connector stop must close a live route and cancel queued work before accepting cleanup evidence', async () => {
  const { runConnectorConformance } = await runners();
  for (const reliable of [false, true]) {
    const report = await runConnectorConformance(connector('token-only-stop', reliable), connectorFixture);
    assert.equal(report.outcome, 'failed', JSON.stringify(report));
    assert.equal(report.checks.find(check => check.id === 'stop')?.status, 'failed');
  }
});

test('connector release exceptions fail evidence without retaining private diagnostics', async () => {
  const { runConnectorConformance } = await runners();
  const report = await runConnectorConformance(connector('throw-release'), connectorFixture);
  assert.equal(report.outcome, 'failed', JSON.stringify(report));
  assert.equal(report.checks.find(check => check.id === 'revoked-grant')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'disconnect')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'release')?.status, 'failed');
  assert.equal(JSON.stringify(report).includes('private-held-effect-release-failure'), false);
});

test('connector async release cannot pass immediate cleanup or leak its rejection', async () => {
  const { runConnectorConformance } = await runners();
  const report = await runConnectorConformance(connector('async-release'), connectorFixture);
  assert.equal(report.outcome, 'failed', JSON.stringify(report));
  assert.equal(report.checks.find(check => check.id === 'release')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'revoked-grant')?.status, 'failed');
  assert.equal(JSON.stringify(report).includes('private-deferred-release-failure'), false);
  // An unconsumed rejected release promise also fails Node's test runner at this boundary.
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('connector fulfilled async release still fails the immediate release contract', async () => {
  const { runConnectorConformance } = await runners();
  const original = connector();
  const report = await runConnectorConformance({ ...original, factory(host) {
    const adapter = original.factory(host);
    return { ...adapter, async release(reason, context) { adapter.release(reason, context); } };
  } }, connectorFixture);
  assert.equal(report.outcome, 'failed', JSON.stringify(report));
  assert.equal(report.checks.find(check => check.id === 'release')?.status, 'failed');
});

test('connector dispatch cannot claim observed command feedback before the fixture supplies it', async () => {
  const report = await (await runners()).runConnectorConformance(connector('bad-feedback', true), connectorFixture);
  assert.equal(report.checks.find(check => check.id === 'feedback')?.status, 'failed');
});

test('invalid connector declarations and excessive fixtures never execute trusted code', async () => {
  const { runConnectorConformance } = await runners();
  let executions = 0;
  const candidate = { ...connector(), factory() { executions++; throw new Error('private factory error'); } };
  const invalid = await runConnectorConformance({ ...candidate, source: { device: { schemaVersion: 99 }, capability: 'state' } }, connectorFixture);
  assert.equal(invalid.outcome, 'failed');
  const excessive = await runConnectorConformance(candidate, { ...connectorFixture, values: Array(33).fill(true) });
  assert.equal(excessive.outcome, 'failed');
  assert.equal(executions, 0);
  assert.equal(JSON.stringify(invalid).includes('private'), false);
});

test('connector report does not retain payloads or thrown private diagnostics', async () => {
  const { runConnectorConformance } = await runners();
  const report = await runConnectorConformance({ ...connector(), factory() { throw new Error('secret-device-token'); } }, connectorFixture);
  assert.equal(report.outcome, 'failed');
  assert.equal(JSON.stringify(report).includes('secret-device-token'), false);
  assert.equal(JSON.stringify(report).includes('private-invalid-payload'), false);
  assert.equal(Object.isFrozen(report.checks), true);
});

test('connector class adapters can expose lifecycle methods through their prototype', async () => {
  const { runConnectorConformance } = await runners();
  const original = connector();
  const report = await runConnectorConformance({ ...original, factory(host) {
    const adapter = original.factory(host);
    return Object.create(adapter);
  } }, connectorFixture);
  assert.equal(report.outcome, 'passed', JSON.stringify(report));
});

test('inert connector descriptions never execute getters', async () => {
  const { runConnectorConformance } = await runners();
  let reads = 0, factories = 0;
  const candidate = { ...connector(), source: Object.defineProperty({}, 'device', { enumerable: true,
    get() { reads++; return descriptor('secret-device'); } }), factory() { factories++; throw new Error('private'); } };
  const report = await runConnectorConformance(candidate as unknown as TrustedConnectorCandidate, connectorFixture);
  assert.equal(report.outcome, 'failed'); assert.equal(reads, 0); assert.equal(factories, 0);
});

test('a nonsettling asynchronous connector fails within the bounded lifecycle check', { timeout: 3000 }, async () => {
  const { runConnectorConformance } = await runners();
  const original = connector();
  const report = await runConnectorConformance({ ...original, factory(host) {
    return { ...original.factory(host), start() { return new Promise<void>(() => {}); } };
  } }, connectorFixture);
  assert.equal(report.outcome, 'failed');
  assert.equal(report.checks.find(check => check.id === 'start')?.status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'cleanup')?.status, 'passed');
});

test('every reliable fixture value is delivered and checked rather than silently ignored', async () => {
  const { runConnectorConformance } = await runners();
  const original = connector('healthy', true);
  const numericDevice = (id: string, sink: boolean) => {
    const value = descriptor(id, sink, true);
    value.capabilities[0].value = { type: 'scalar', unit: '1', min: 0, max: 10 } as never;
    return value;
  };
  const report = await runConnectorConformance({ ...original,
    source: { device: numericDevice('source', false), capability: 'state' },
    sink: { device: numericDevice('sink', true), capability: 'state' },
    factory(host) {
      const adapter = original.factory(host);
      return { ...adapter, send(value, options) { return host.publish(value === 3 ? 0 : value, options); } };
    } }, { values: [1, 2, 3], invalidValue: 'invalid' });
  assert.equal(report.outcome, 'failed');
  assert.equal(report.checks.find(check => check.id === 'fixture-vectors')?.status, 'failed');
});

test('a parsed descriptor with an invalid source role returns a failed report', async () => {
  const { runConnectorConformance } = await runners();
  const sourceDevice = descriptor('source', false, true);
  sourceDevice.capabilities[0].kind = 'command';
  const report = await runConnectorConformance({ ...connector('healthy', true), source: { device: sourceDevice, capability: 'state' } }, connectorFixture);
  assert.equal(report.outcome, 'failed');
  assert.equal(report.checks.find(check => check.id === 'manifest')?.status, 'failed');
});

const source = new TextEncoder().encode('vendor-counter-processor-v1');
const manifest = { schemaVersion: 1, id: 'vendor:counter', version: '1.0.0',
  codeSha256: createHash('sha256').update(source).digest('hex'),
  inputs: [{ id: 'step', value: { type: 'boolean' } }],
  outputs: [{ id: 'count', value: { type: 'scalar', unit: '1', min: 0, max: 10 } }],
  configuration: { type: 'record', fields: { enabled: { type: 'boolean' } } },
  state: { mode: 'resettable', resetOn: ['input-loss', 'stop', 'reconfigure'] }, assets: [], license: 'MIT',
  budgets: { maxComputeMs: 1000, maxMemoryBytes: 65536, privacy: 'local-only' } };
const processorFixture = { configuration: { enabled: true }, invalidConfiguration: { enabled: 'private-invalid-config' },
  invalidInputs: { step: 'private-invalid-input' }, cases: [
    { inputs: { step: true }, outputs: { count: 1 } },
    { inputs: { step: false }, outputs: { count: 1 } },
    { inputs: { step: true }, outputs: { count: 2 } },
  ] };
function processor(broken: 'none' | 'reset' | 'output' = 'none') {
  return { manifest, source, factory() {
    let count = 0;
    return { process(inputs: Readonly<Record<string, unknown>>) { if (inputs.step) count++;
      return { count: broken === 'output' ? 'secret-broken-output' : count }; },
    reset() { if (broken !== 'reset') count = 0; } };
  } };
}

test('processor suite executes pinned trusted code and deterministic vectors across reset causes', async () => {
  const { runProcessorConformance } = await runners();
  const report = await runProcessorConformance(processor(), processorFixture);
  assert.equal(report.outcome, 'passed', JSON.stringify(report));
  assert.deepEqual(await runProcessorConformance(processor(), processorFixture), report);
  for (const id of ['input-rejection', 'configuration-rejection', 'deterministic-replay', 'reset-input-loss', 'reset-stop', 'reset-reconfigure'])
    assert.equal(report.checks.find(check => check.id === id)?.status, 'passed');
});

test('broken processor output and retained state fail against hand-authored vectors', async () => {
  const { runProcessorConformance } = await runners();
  const output = await runProcessorConformance(processor('output'), processorFixture);
  assert.equal(output.checks.find(check => check.id === 'output-vectors')?.status, 'failed');
  assert.equal(JSON.stringify(output).includes('secret-broken-output'), false);
  const reset = await runProcessorConformance(processor('reset'), processorFixture);
  assert.equal(reset.checks.find(check => check.id === 'reset-input-loss')?.status, 'failed');
});

test('processor mismatched code pins and invalid test data never invoke the factory', async () => {
  const { runProcessorConformance } = await runners();
  let factories = 0;
  const registration = { ...processor(), factory() { factories++; throw new Error('private'); } };
  const pin = await runProcessorConformance({ ...registration, source: new TextEncoder().encode('modified') }, processorFixture);
  assert.equal(pin.checks.find(check => check.id === 'code-pin')?.status, 'failed');
  const fixture = await runProcessorConformance(registration, { ...processorFixture, cases: Array(33).fill(processorFixture.cases[0]) });
  assert.equal(fixture.outcome, 'failed');
  assert.equal(factories, 0);
});
