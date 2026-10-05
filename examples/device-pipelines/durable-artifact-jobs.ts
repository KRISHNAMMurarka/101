import { createAssetReference, createDeviceRuntime, createDurableArtifactJobStore, verifyAssetContent } from '@101/connect';
import type { ArtifactJobRecord, ArtifactJobRequest, ArtifactJobStorage, DeliveryContext } from '@101/connect';

function required<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: string }>): T {
  if (!result.ok) throw new Error(`Local artifact job: ${result.reason}`);
  return result.value;
}
/** A real local output caller. The caller supplies and owns the atomic durable storage port. */
export async function runDurableArtifactJobsExample(storage: ArtifactJobStorage,
  ownerId = 'artifact-example-owner', idempotencyKey = 'artifact-example-job') {
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  const inputBytes = encoder.encode('101 local artifact source\n' + 'bounded public input\n'.repeat(8));
  const input = await createAssetReference('artifact:example-input', 'text', inputBytes);
  const selected: ArtifactJobRequest = { idempotencyKey, applicationId: 'artifact-example', profileId: '101:local-artifact',
    profileRevision: 1, destinationId: 'owner-local-artifacts', totalUnits: 8, input };
  let delivery: DeliveryContext | undefined;
  const jobs = createDurableArtifactJobStore({ ownerId, storage, authorize: request => {
    if (request.ownerId !== ownerId || JSON.stringify(request.request) !== JSON.stringify(selected)) return;
    if (request.action === 'read-output') return { expiresAt: Date.now() + 10000, isCurrent: () => true };
    if (request.action !== 'start' || !delivery?.isCurrent()) return;
    const current = delivery;
    return { expiresAt: Date.now() + 10000, isCurrent: () => current.isCurrent(), signal: current.signal };
  } });
  let resources: Readonly<{ source: string; sink: string }> | undefined;
  const runtime = createDeviceRuntime({ authorize: request => request.principalId === ownerId &&
    request.applicationId === selected.applicationId && request.sessionId === 'artifact-example-session' &&
    request.source.registrationId === resources?.source && request.sink.registrationId === resources.sink &&
    request.sinkOperation === 'invoke' ? { expiresAt: performance.now() + 10000, maxAgeMs: 10000, maxHz: 10 } : undefined });
  try {
    const admitted = required(await jobs.submit(selected));
    if (admitted.requiresReview) return Object.freeze({ status: 'review-required' as const, duplicate: true,
      handlerResult: 'not-started' as const, effectEvidence: 'none' as const });
    if (admitted.state === 'completed') {
      const retained = required(await jobs.readOutput(idempotencyKey));
      if (!await verifyAssetContent(retained.reference, retained.bytes)) throw new Error('Local artifact job: integrity');
      return Object.freeze({ status: 'completed' as const, duplicate: true, handlerResult: 'not-started' as const,
        effectEvidence: 'observed' as const, output: retained.reference, artifactText: decoder.decode(retained.bytes) });
    }
    const capability = { id: 'generate', semantic: 'example:local-artifact', schemaVersion: 1,
      value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 10000 } };
    const sourceDevice = { schemaVersion: 1, id: 'artifact-request-source', label: 'Local artifact request', revision: 1,
      adapter: { id: 'example:local-artifact', version: '1.0.0' }, runtime: { platform: 'local-sdk-caller' },
      capabilities: [{ ...capability, kind: 'event', permissions: ['subscribe'] }] };
    const sinkDevice = { ...sourceDevice, id: 'artifact-output-sink', label: 'Owner local artifact store',
      capabilities: [{ ...capability, kind: 'job', permissions: ['invoke'], ownership: { mode: 'exclusive' } }] };
    let completed!: (value: ArtifactJobRecord) => void, rejected!: (reason: Error) => void;
    const completion = new Promise<ArtifactJobRecord>((resolve, reject) => { completed = resolve; rejected = reject; });
    const source = runtime.registerSource({ device: sourceDevice, capability: 'generate' });
    const sink = runtime.registerSink({ device: sinkDevice, capability: 'generate',
      async apply(_observation, context) {
        delivery = context;
        try {
          const attempt = required(await jobs.start(idempotencyKey, inputBytes));
          const lines = ['101 retained local artifact', `input-sha256=${input.sha256}`];
          for (let unit = 1; unit <= selected.totalUnits; unit++) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            if (attempt.signal.aborted || !context.isCurrent()) throw new Error('Local artifact job: interrupted');
            const start = Math.floor((unit - 1) * inputBytes.byteLength / selected.totalUnits);
            const end = Math.floor(unit * inputBytes.byteLength / selected.totalUnits);
            let sum = 0; for (const byte of inputBytes.subarray(start, end)) sum += byte;
            lines.push(`chunk=${unit},bytes=${end - start},sum=${sum}`);
            required(await attempt.progress(unit));
          }
          const record = required(await attempt.commit(encoder.encode(lines.join('\n') + '\n')));
          context.reportEvidence('target-acknowledged'); completed(record);
        } catch {
          rejected(new Error('Local artifact job: interrupted')); throw new Error('Local artifact job: interrupted');
        }
      }, release() { void jobs.close(); } });
    resources = Object.freeze({ source: source.id, sink: sink.id });
    required(runtime.setReadiness(source, 'available')); required(runtime.setReadiness(sink, 'available'));
    const route = runtime.route({ from: source, to: sink, principalId: ownerId, applicationId: selected.applicationId,
      sessionId: 'artifact-example-session', leaseMs: 10000 });
    required(route.start());
    required(runtime.publish(source, true, { operationId: '1', deadline: performance.now() + 5000 }));
    runtime.flush(); await completion;
    // Read retained bytes independently after provider completion, then report the selected local effect.
    const retained = required(await jobs.readOutput(idempotencyKey));
    if (!await verifyAssetContent(retained.reference, retained.bytes)) throw new Error('Local artifact job: integrity');
    delivery?.reportEvidence('observed');
    await Promise.resolve();
    const operation = route.operations()[0];
    return Object.freeze({ status: 'completed' as const, duplicate: false, handlerResult: operation?.handlerResult,
      effectEvidence: operation?.effectEvidence, output: retained.reference, artifactText: decoder.decode(retained.bytes) });
  } finally { runtime.close(); await jobs.close(); }
}
