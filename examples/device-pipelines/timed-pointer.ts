import { createDeviceRuntime, createPipelineTimingCollector, parseObservationTiming, snapshotJson } from '@101/connect';
import type { DeviceDescriptor, PipelineTimingCollector, SignalValue } from '@101/connect';
import { RemoteResourcePublisher, RemoteResourceReceiver, pointerSourceDescriptor } from '@101/device-web';
import type { RemoteValueTiming, ResourcePeer } from '@101/device-web';

type Lane = 'reliable' | 'disposable';
interface TimedPointerOptions {
  readonly now: () => number;
  /** Resolve after the actual local output commit. A browser caller may await its owned animation frame. */
  readonly output: (value: SignalValue, context: { readonly signal: AbortSignal; readonly isCurrent: () => boolean }) => void | Promise<void>;
  readonly release: () => void;
  readonly capacity?: number;
  readonly sourceOffsetMs?: number;
}

/** Actual local MessagePorts. These explicit diagnostic peers supply no remote identity or resource permission. */
function peer(port: MessagePort): ResourcePeer & { close(): void } {
  const listeners = new Set<(lane: Lane, data: string | ArrayBuffer) => void>();
  const states = new Set<(state: 'connected' | 'disconnected') => void>();
  let closed = false;
  const receive = (event: MessageEvent) => {
    if (closed || !event.data || !['reliable', 'disposable'].includes(event.data.lane)) return;
    for (const listener of [...listeners]) listener(event.data.lane, event.data.data);
  };
  port.addEventListener('message', receive);
  port.start();
  return {
    get state() { return closed ? 'disconnected' as const : 'connected' as const; },
    isOpen() { return !closed; },
    send(lane, data) {
      if (closed) return false;
      port.postMessage({ lane, data: typeof data === 'string' ? data : data instanceof ArrayBuffer ? data : data.slice().buffer });
      return true;
    },
    onData(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onStateChange(listener) { states.add(listener); listener(closed ? 'disconnected' : 'connected'); return () => { states.delete(listener); }; },
    close() {
      if (closed) return;
      closed = true; port.removeEventListener('message', receive); port.close();
      for (const listener of [...states]) listener('disconnected');
      listeners.clear(); states.clear();
    },
  };
}

/** Local, opt-in timing example: genuine negotiated codec, clock exchange, host grants and sink callbacks. */
export function createTimedPointerExample(options: TimedPointerOptions) {
  if (typeof options.now !== 'function' || typeof options.output !== 'function' || typeof options.release !== 'function')
    throw new TypeError('A clock, actual output and release callback are required');
  const offset = options.sourceOffsetMs ?? 1000;
  if (!Number.isFinite(offset) || offset < 0 || offset > 60000) throw new RangeError('Invalid local clock offset');
  const startedAt = options.now();
  if (!Number.isFinite(startedAt) || startedAt < 0 || startedAt > Number.MAX_SAFE_INTEGER - 60000) throw new RangeError('Invalid local clock');
  const collector: PipelineTimingCollector = createPipelineTimingCollector({ capacity: options.capacity });
  const channel = new MessageChannel(), sourcePeer = peer(channel.port1), targetPeer = peer(channel.port2);
  const epoch = '74696d6564706f696e74657230303031';
  const sourceClock = 'timed-pointer-source', targetClock = 'timed-pointer-output';
  const encodings = new Map<string, RemoteValueTiming>(), decodings = new Map<string, RemoteValueTiming>();
  let closed = false, selected = false, slot: number | undefined, dropped = 0;
  const key = (value: Pick<RemoteValueTiming, 'slot' | 'sequence'>) => `${value.slot}:${value.sequence}`;
  function retain(map: Map<string, RemoteValueTiming>, timing: RemoteValueTiming) {
    if (closed || timing.slot !== slot) return;
    if (map.size >= 64) { map.delete(map.keys().next().value!); dropped++; }
    map.set(key(timing), timing);
  }
  const sourceDevice = pointerSourceDescriptor('local-message-port-timing');
  const sinkDevice: DeviceDescriptor = { ...sourceDevice, id: 'timed-pointer-output', label: 'Timed application output', capabilities: [
    { ...sourceDevice.capabilities.find(capability => capability.id === 'position')!, kind: 'property',
      permissions: ['write'], ownership: { mode: 'exclusive' } },
  ] };
  const grant = { expiresAt: startedAt + 30000, maxAgeMs: 1000, maxHz: 60 };
  const runtime = createDeviceRuntime({ now: options.now, clockDomain: targetClock,
    authorize: request => !closed && selected && request.principalId === 'local-timing-owner' &&
      request.applicationId === 'local-timing-example' && request.sessionId === epoch ? grant : undefined });
  const sink = runtime.registerSink({ device: sinkDevice, capability: 'position',
    async apply(observation, context) {
      const appliedAt = options.now();
      if (closed || !context.isCurrent() || context.signal.aborted) return;
      await options.output(snapshotJson(observation.value) as SignalValue, context);
      const renderedAt = options.now();
      if (closed || !context.isCurrent() || context.signal.aborted || slot === undefined) return;
      const frameKey = `${slot}:${observation.sequence}`;
      const encoding = encodings.get(frameKey), decoding = decodings.get(frameKey);
      encodings.delete(frameKey); decodings.delete(frameKey);
      if (!encoding || !decoding) { dropped++; return; }
      const timing = parseObservationTiming(observation.provenance?.timing);
      collector.record({ source: { clockId: sourceClock, capturedAt: encoding.capturedAt,
        encodingStartedAt: encoding.startedAt, encodedAt: encoding.finishedAt },
      target: { clockId: targetClock, receivedAt: decoding.startedAt, decodedAt: decoding.finishedAt, appliedAt, renderedAt },
      mapping: timing.mapping });
    }, release() { encodings.clear(); decodings.clear(); options.release(); },
  });
  runtime.setReadiness(sink, 'available');
  const receiver = new RemoteResourceReceiver({ peer: targetPeer, runtime, epoch, clockId: targetClock, now: options.now,
    authentication: 'local-diagnostic', principalId: 'local-timing-owner', applicationId: 'local-timing-example', sessionId: epoch,
    onTiming: timing => { retain(decodings, timing); } });
  const publisher = new RemoteResourcePublisher({ peer: sourcePeer, epoch, clockId: sourceClock,
    now: () => options.now() + offset, authentication: 'local-diagnostic', device: sourceDevice, available: () => !closed,
    onTiming: timing => { retain(encodings, timing); } });
  publisher.start();
  return Object.freeze({
    tick() { if (!closed) { receiver.tick(); publisher.tick(); } },
    descriptionReady() { return !closed && !!receiver.description(); },
    approve() {
      if (closed || selected || !receiver.description()) return false;
      selected = true;
      slot = receiver.approve({ capability: 'position', sink, sinkDevice, sinkCapability: 'position', grant, codec: 'normalized-pointer/1' });
      if (slot === undefined) selected = false;
      return slot !== undefined;
    },
    ready() { return !closed && publisher.isBound('position') && receiver.status().clockReady; },
    publish(value: unknown, capturedAt = options.now()) {
      if (closed || !selected) return false;
      return publisher.publish('position', value, { capturedAt: capturedAt + offset });
    },
    snapshot() { return Object.freeze({ timing: collector.snapshot(), unmatched: dropped,
      pending: encodings.size + decodings.size, ready: !closed && publisher.isBound('position'), closed }); },
    close() {
      if (closed) return;
      closed = true; selected = false;
      publisher.stop(); receiver.stop(); runtime.close(); sourcePeer.close(); targetPeer.close();
      encodings.clear(); decodings.clear(); collector.close();
    },
  });
}
