import { createInvitationConnectionController, RemoteResourcePublisher, authenticatedPeerScope, parseDeviceDescriptor } from '@101/connect';
import type { InvitationConnectionOptions, InvitationConnectionHandle, InvitationConnectionPreview } from '@101/connect';

export interface InvitationConnectionSourceOptions extends InvitationConnectionOptions {
  readonly measurement: 'node-rss' | 'browser-viewport-width'; readonly clockId: string;
  /** Independent current source-owner approval. Connection consent and invitation possession are insufficient. */
  readonly sourceOwnerCurrent: () => boolean;
}
/** Actual optional local producer. No reads, sockets or timers occur during import/construction.
 * Native runtimes lacking either declared API report unavailable; no physical sensor is invented. */
export function createInvitationConnectionSource(options: InvitationConnectionSourceOptions) {
  const { measurement, clockId, sourceOwnerCurrent, ...connectionOptions } = options;
  if (!['node-rss', 'browser-viewport-width'].includes(measurement) || typeof sourceOwnerCurrent !== 'function') throw new TypeError('Unsupported local measurement');
  const controller = createInvitationConnectionController(connectionOptions);
  const unit = measurement === 'node-rss' ? 'By' : 'px';
  const device = parseDeviceDescriptor({ schemaVersion: 1, id: `owned-${measurement}`, label: measurement === 'node-rss' ? 'Owned process memory' : 'Owned browser viewport',
    revision: 1, adapter: { id: `example:${measurement}`, version: '1.0.0' }, runtime: { platform: measurement === 'node-rss' ? 'node-process' : 'browser-document' },
    capabilities: [{ id: 'measurement', semantic: measurement === 'node-rss' ? 'example:resident-memory' : 'example:viewport-width', schemaVersion: 1,
      kind: 'sample', value: { type: 'scalar', unit, min: 0, max: Number.MAX_SAFE_INTEGER }, delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 1000 }, permissions: ['subscribe'] }] });
  let closed = false, selected: InvitationConnectionHandle | undefined, publisher: RemoteResourcePublisher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, published = 0, lastPublishedAt = -1, measured: number | undefined;
  function approved() { try { return !closed && sourceOwnerCurrent() === true && !!selected && !!controller.connection(selected); } catch { return false; } }
  function read() {
    if (!approved()) return;
    const host = globalThis as unknown as { process?: { memoryUsage?(): { rss: number } }; innerWidth?: number };
    let value: number | undefined;
    if (measurement === 'node-rss') value = host.process?.memoryUsage?.().rss;
    else value = host.innerWidth;
    if (!approved() || typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return;
    return value;
  }
  function retireSource() { publisher?.stop(); publisher = undefined; measured = undefined; }
  function tick() {
    if (closed) return;
    const peer = selected ? controller.connection(selected) : undefined;
    if (!peer || !approved()) retireSource();
    else {
      if (!publisher) {
        const proof = authenticatedPeerScope(peer);
        if (proof) { publisher = new RemoteResourcePublisher({ peer, epoch: proof.epoch, device, now: options.now, clockId,
          available: capability => capability === 'measurement' && approved() }); if (!publisher.start()) retireSource(); }
      }
      publisher?.tick();
      const at = options.now();
      if (publisher?.isBound('measurement') && at - lastPublishedAt >= 50) {
        const value = read();
        if (value !== undefined && publisher.publish('measurement', value, { capturedAt: at })) {
          measured = value; published++; lastPublishedAt = at;
        }
      }
    }
    if (!closed && selected && controller.connection(selected)) timer = setTimeout(tick, 20);
  }
  return Object.freeze({ controller, device,
    review(input: string, source: InvitationConnectionPreview['source'], endpointId: string) { return controller.review(input, { source, endpointId }); },
    reviewDiscovered(candidate: unknown, input: string, source: InvitationConnectionPreview['source'], endpointId: string) {
      return controller.reviewDiscovered(candidate, input, { source, endpointId });
    },
    async connect(review: Parameters<typeof controller.connect>[0]) {
      const result = await controller.connect(review);
      if (result.ok && !closed) {
        if (timer !== undefined) clearTimeout(timer); retireSource(); selected = result.value; tick();
      }
      return result;
    },
    status() { return Object.freeze({ published, measured, sourceApproved: approved(), bound: publisher?.isBound('measurement') ?? false, connection: controller.snapshot() }); },
    close() { if (closed) return; closed = true; if (timer !== undefined) clearTimeout(timer); timer = undefined;
      retireSource(); controller.close(); selected = undefined; },
  });
}
