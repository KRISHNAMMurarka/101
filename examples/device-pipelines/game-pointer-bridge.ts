import { INPUT_SOURCES, parseInputManifest, type InputFrame, type InputManifest, type InputSource } from '@101/input';
import { createPointerResourceConnection, parseDeviceDescriptor, parseSignalValue, pointerSourceDescriptor, schemasCompatible } from '@uynis-connect/connect';
import type { Observation, EndpointIdentity, ReceiverInvitation } from '@uynis-connect/connect';

/** App-owned declaration of the diagnostic's existing controls, not a new game manifest. */
export const INPUT_LAB_POINTER_MANIFEST: InputManifest = {
  game: 'input-lab', vectors: { aim: { recommended: ['mouse', 'touch', 'gamepad', 'custom'] } },
  actions: { trigger: { recommended: ['keyboard', 'mouse', 'touch', 'gamepad', 'custom'] } },
};
export interface GamePointerScope {
  applicationId: string; sessionId: string; playerId: string; roleId: string; deviceId: string; clockDomain: string;
}
export interface GamePointerBridgeOptions {
  manifest: unknown; scope: GamePointerScope;
  mapping: { vector: string; action: string; coordinates: 'normalized-to-signed'; source: InputSource };
  emit: (frame: InputFrame) => boolean;
  removeDevice: (deviceId: string, playerId: string) => void;
  now: () => number;
  onStatus?: (reason: string) => void;
}
type Kind = 'position' | 'contact';
function pointerCapabilities(descriptor: unknown) {
  const source = parseDeviceDescriptor(descriptor), expected = pointerSourceDescriptor();
  const capabilities = expected.capabilities.map(sink => source.capabilities.filter(capability =>
    capability.semantic === sink.semantic && capability.schemaVersion === sink.schemaVersion &&
    capability.delivery.mode === sink.delivery.mode && schemasCompatible(capability, sink) &&
    capability.permissions.includes('subscribe')));
  if (capabilities.some(matches => matches.length !== 1)) throw new TypeError('Select one compatible position and contact resource');
  return { source, position: capabilities[0][0], contact: capabilities[1][0] };
}

/** Application policy boundary. Only a local owner call to approve enables typed observations. */
export function createGamePointerBridge(options: GamePointerBridgeOptions) {
  const manifest = parseInputManifest(options.manifest), scope = Object.freeze({ ...options.scope });
  const mapping = Object.freeze({ ...options.mapping });
  if (Object.values(scope).some(value => typeof value !== 'string' || !value.trim() || value.length > 128) || scope.applicationId !== manifest.game ||
    mapping.coordinates !== 'normalized-to-signed' || !INPUT_SOURCES.includes(mapping.source)) throw new TypeError('Explicit application/player/role scope and coordinate mapping required');
  const vector = manifest.vectors?.[mapping.vector], action = manifest.actions?.[mapping.action];
  if (!vector || !action || ![vector, action].every(control => [...control.recommended, ...(control.fallback ?? [])].includes(mapping.source))) {
    throw new TypeError('Mapped controls must declare the owner-selected input source');
  }
  const emit = options.emit, removeDevice = options.removeDevice, now = options.now, onStatus = options.onStatus;
  let approved: ReturnType<typeof pointerCapabilities> | undefined;
  let stopped = false, reason = 'awaiting-owner-approval';
  const sequences: Record<Kind, number> = { position: 0, contact: 0 };
  const device = (kind: Kind) => `${scope.deviceId}:${kind}`;
  const report = (next: string) => { reason = next; try { onStatus?.(next); } catch { /* Diagnostics cannot own input. */ } };
  function frame(kind: Kind, value: Observation['value'], sequence: number, timestamp: number, receivedAt: number): InputFrame {
    const position = kind === 'position' && typeof value === 'object' && 'x' in value && 'y' in value &&
      typeof value.x === 'number' && typeof value.y === 'number' ? { x: 2 * value.x - 1, y: 2 * value.y - 1 } : undefined;
    return { deviceId: device(kind), playerId: scope.playerId, sequence, timestamp, receivedAt, source: mapping.source,
      actions: kind === 'contact' ? { [mapping.action]: value === true } : {},
      ...(position ? { vectors: { [mapping.vector]: position } } : {}) };
  }
  function stop(next = 'stopped'): void {
    if (stopped) return;
    stopped = true; approved = undefined;
    let time = 0; try { const current = now(); if (Number.isFinite(current) && current >= 0) time = current; } catch { /* Release remains necessary. */ }
    // Emitted neutral states are visible to diagnostics; removal also clears any held contribution.
    for (const kind of ['position', 'contact'] as const) {
      if (sequences[kind] > 0) {
        try { emit(frame(kind, kind === 'position' ? { x: 0.5, y: 0.5 } : false, ++sequences[kind], time, time)); } catch { /* Removal is the final local release. */ }
      }
      try { removeDevice(device(kind), scope.playerId); } catch { /* A failing app callback cannot resurrect this scope. */ }
    }
    report(next);
  }
  return {
    approve(descriptor: unknown): boolean {
      if (stopped || approved) return false;
      try { approved = pointerCapabilities(descriptor); report('owner-approved'); return true; } catch { return false; }
    },
    apply(kind: Kind, observation: Observation, isCurrent: () => boolean): boolean {
      if (stopped || !approved || !['position', 'contact'].includes(kind)) return false;
      let current = false; try { current = isCurrent(); } catch { return false; }
      if (!current || observation.quality !== 'valid' || observation.clockDomain !== scope.clockDomain ||
        observation.source.deviceId !== approved.source.id || observation.source.capabilityId !== approved[kind].id ||
        !Number.isSafeInteger(observation.sequence) || observation.sequence <= sequences[kind] || observation.sequence >= Number.MAX_SAFE_INTEGER ||
        !Number.isFinite(observation.timestamp) || observation.timestamp < 0 || !Number.isFinite(observation.receivedAt) || observation.receivedAt < observation.timestamp) return false;
      let value: Observation['value'];
      try { value = parseSignalValue(observation.value, approved[kind].value); } catch { return false; }
      sequences[kind] = observation.sequence;
      try { return emit(frame(kind, value, observation.sequence, observation.timestamp, observation.receivedAt)); }
      catch { stop('application-error'); return false; }
    },
    stop,
    state() { return Object.freeze({ approved: !!approved, stopped, reason, playerId: scope.playerId, roleId: scope.roleId }); },
  };
}

export interface GamePointerReceiverOptions extends GamePointerBridgeOptions { identity: EndpointIdentity; invitation: ReceiverInvitation }
/** Game scope and mapping remain local; the SDK owns the authorized connection and resource sinks. */
export function createGamePointerReceiver(options: GamePointerReceiverOptions) {
  const bridge=createGamePointerBridge(options);
  const connection=createPointerResourceConnection({identity:options.identity,invitation:options.invitation,clockDomain:options.scope.clockDomain,now:options.now,
    onObservation(kind,observation,isCurrent){bridge.apply(kind,observation,isCurrent);},onRelease(reason){bridge.stop(reason);} });
  return {
    connection, receiver:connection, bridge,
    select(){if(!bridge.approve(connection.description()))return false;if(!connection.select()){bridge.stop();return false;}return true;},
    tick(){connection.tick();if(bridge.state().stopped)connection.close();},
    stop(){bridge.stop();connection.close();},
  };
}
