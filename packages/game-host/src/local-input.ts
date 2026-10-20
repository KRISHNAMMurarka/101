import { createLocalInputClient } from '@uynis-connect/connect';
import { createDeviceMapping, type InputBus, type InputSource } from '@101/input';

let nextScope = 0;
export interface LocalGameInputOptions {
  inputBus: InputBus;
  pointerTarget?: HTMLElement | null;
  onAvailability?(): void;
}

/** Owns SDK subscriptions; game components never receive their device implementations. */
export function connectLocalGameInput(options: LocalGameInputOptions) {
  const client = createLocalInputClient();
  const cleanups: Array<() => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { client.close(); }
    finally { for (const cleanup of cleanups.splice(0)) cleanup(); }
  };
  try {
    const requests = [
      { source: 'keyboard' as const },
      { source: 'gamepad' as const },
      ...(options.pointerTarget ? [{ source: 'pointer' as const, target: options.pointerTarget }] : []),
    ];
    for (const request of requests) {
      const scopeId = `browser-local-${++nextScope}`;
      const source: InputSource = request.source === 'pointer' ? 'mouse' : request.source;
      const mapping = createDeviceMapping({ scopeId, playerId: 'player-1',
        emit: frame => options.inputBus.accept(frame),
        removeDevice: (id, player) => { options.inputBus.removeDevice(id, player); },
      });
      const subscription = client.request(request);
      const unlisten = subscription.subscribe(snapshot => { if (!closed) mapping.accept(snapshot); });
      const unstatus = subscription.onStatus(status => {
        const available = !closed && status.state === 'usable';
        options.inputBus.setSourceAvailability(scopeId, source, available);
        if (status.state === 'closed' || status.state === 'denied') mapping.close();
        options.onAvailability?.();
      });
      cleanups.push(() => {
        unlisten(); unstatus(); mapping.close();
        options.inputBus.setSourceAvailability(scopeId, source, false);
      });
    }
    return { close };
  } catch (error) { close(); throw error; }
}
