import { runConnectorConformance, runProcessorConformance } from '@101/connect';
import type { ConnectorConformanceHost, DeliveryContext, PublishOptions, TrustedConnectorCandidate, TrustedProcessorRegistration } from '@101/connect';

const valueSchema = { type: 'boolean' };
function descriptor(id: string, sink: boolean) {
  return { schemaVersion: 1, id, label: 'Local conformance fixture', revision: 1,
    adapter: { id: 'independent:relay-fixture', version: '1.0.0' }, runtime: { platform: 'standalone-local' },
    capabilities: [{ id: 'state', semantic: 'independent:state', schemaVersion: 1,
      kind: sink ? 'command' : 'event', value: valueSchema,
      delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: [sink ? 'invoke' : 'subscribe'] }] };
}

/** The effect and resource hooks wrap an adapter's own observable local work. No hardware is accessed. */
export function createConformanceExampleConnector(leakResource = false): TrustedConnectorCandidate {
  return { source: { device: descriptor('fixture-source', false), capability: 'state' },
    sink: { device: descriptor('fixture-relay', true), capability: 'state' },
    factory(host: ConnectorConformanceHost) {
      let resource: (() => void) | undefined, feedback: DeliveryContext | undefined;
      return {
        start() { resource = host.trackResource(); host.setReadiness('source', 'available'); host.setReadiness('sink', 'available'); },
        send(value: unknown, options?: PublishOptions) { return host.publish(value, options); },
        apply(observation, context) {
          if (context.signal.aborted || !context.isCurrent()) return;
          host.recordEffect(observation.value); feedback = context; context.reportEvidence('dispatched');
        },
        feedback(evidence) { feedback?.reportEvidence(evidence); },
        release() { feedback = undefined; },
        stop() {
          if (!leakResource) resource?.();
          host.setReadiness('source', 'unavailable'); host.setReadiness('sink', 'unavailable');
        },
      };
    } };
}

function counterFactory() {
  let count = 0;
  return { process(inputs: Readonly<Record<string, unknown>>) { if (inputs.step) count++; return { count }; }, reset() { count = 0; } };
}
function brokenCounterFactory() {
  let count = 0;
  return { process(inputs: Readonly<Record<string, unknown>>) { if (inputs.step) count++; return { count }; }, reset() {} };
}

async function counterRegistration(broken: boolean): Promise<TrustedProcessorRegistration> {
  // These explicit local factories are the trusted code; no manifest can select executable code.
  const factory = broken ? brokenCounterFactory : counterFactory;
  const source = new TextEncoder().encode(factory.toString());
  const codeSha256 = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', source)), byte => byte.toString(16).padStart(2, '0')).join('');
  return { source, factory, manifest: { schemaVersion: 1, id: 'independent:counter', version: '1.0.0', codeSha256,
    inputs: [{ id: 'step', value: valueSchema }], outputs: [{ id: 'count', value: { type: 'scalar', unit: '1', min: 0, max: 10 } }],
    configuration: { type: 'record', fields: { enabled: valueSchema } },
    state: { mode: 'resettable', resetOn: ['input-loss', 'stop', 'reconfigure'] }, assets: [], license: 'MIT',
    budgets: { maxComputeMs: 1000, maxMemoryBytes: 65536, privacy: 'local-only' } } };
}

/** This module runs unchanged in an external SDK consumer: public imports only, no 101 app or private package. */
export async function runConformanceExample() {
  const connectorFixture = { values: [true, false], invalidValue: 'invalid' };
  const processorFixture = { configuration: { enabled: true }, invalidConfiguration: { enabled: 'invalid' },
    invalidInputs: { step: 'invalid' }, cases: [
      { inputs: { step: true }, outputs: { count: 1 } },
      { inputs: { step: false }, outputs: { count: 1 } },
      { inputs: { step: true }, outputs: { count: 2 } },
    ] };
  const healthyConnector = await runConnectorConformance(createConformanceExampleConnector(), connectorFixture);
  const brokenConnector = await runConnectorConformance(createConformanceExampleConnector(true), connectorFixture);
  const healthyProcessor = await runProcessorConformance(await counterRegistration(false), processorFixture);
  const brokenProcessor = await runProcessorConformance(await counterRegistration(true), processorFixture);
  if (healthyConnector.outcome !== 'passed' || healthyProcessor.outcome !== 'passed' ||
    brokenConnector.outcome !== 'failed' || brokenProcessor.outcome !== 'failed') throw new Error('Conformance fixture verdict mismatch');
  return { kind: 'independent-local-conformance', healthyConnector, brokenConnector, healthyProcessor, brokenProcessor };
}
