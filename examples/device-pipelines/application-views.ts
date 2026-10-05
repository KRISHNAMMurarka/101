import { createApplicationViews, mountApplicationViewCanvas, parseValueSchema } from '@101/connect';
import type { ApplicationCanvasView, SignalValue } from '@101/connect';

const value = parseValueSchema({ type: 'record', fields: {
  position: { type: 'vector', unit: '1', min: 0, max: 1, frame: 'surface:normalized', components: ['x', 'y'] },
  label: { type: 'enum', values: ['Shared view', 'Owner view'] },
  privateValue: { type: 'scalar', unit: '1', min: 0, max: 100000 },
}, optional: ['privateValue'] });

/** Actual independent Canvas2D displays from one local authoritative simulation; approval below is an explicit test-host choice. */
export function createApplicationViewsExample(canvases: { left: HTMLCanvasElement; right: HTMLCanvasElement; owner: HTMLCanvasElement }, options: {
  now?: () => number;
  beforeDraw?: (outputId: string) => void;
} = {}) {
  let steps = 0, engineStops = 0, stopped = false, publicApproved = false, ownerApproved = false;
  const now = options.now ?? (() => performance.now());
  const received = new Map<string, SignalValue>(), mounts = new Map<string, ApplicationCanvasView>();
  const views = createApplicationViews({ applicationId: 'application-views-example', sessionId: 'local-session', clockDomain: 'application-clock', now,
    engine: { step() { steps++; return { position: { x: (steps % 10) / 10, y: (10 - steps % 10) / 10 }, privateValue: 7319 }; }, stop() { engineStops++; } },
    views: [
      { id: 'shared', value, project(state) { const current = state as { position: { x: number; y: number } }; return { position: current.position, label: 'Shared view' }; } },
      { id: 'owner', value, project(state) { const current = state as { position: { x: number; y: number }; privateValue: number }; return { position: current.position, label: 'Owner view', privateValue: current.privateValue }; } },
    ], authorize(request) {
      if (stopped || request.applicationId !== 'application-views-example' || request.sessionId !== 'local-session') return;
      const publicAllowed = publicApproved && request.viewId === 'shared' &&
        (request.outputId === 'left' && request.principalId === 'alice' || request.outputId === 'right' && request.principalId === 'bob');
      const ownerAllowed = ownerApproved && request.viewId === 'owner' && request.outputId === 'owner' && request.principalId === 'alice';
      if (publicAllowed || ownerAllowed) return { expiresAt: now() + 10000, maxAgeMs: 1000, maxHz: 120 };
    } });
  function mount(outputId: 'left' | 'right' | 'owner', principalId: string) {
    mounts.get(outputId)?.stop(); mounts.delete(outputId); received.delete(outputId);
    const mounted = mountApplicationViewCanvas({ views, canvas: canvases[outputId], viewId: outputId === 'owner' ? 'owner' : 'shared', outputId, principalId,
      label: outputId === 'owner' ? 'Private application display' : 'Shared application display',
      draw(context, frame, geometry) {
        options.beforeDraw?.(outputId);
        const current = frame as { position: { x: number; y: number }; label: string; privateValue?: number };
        context.fillStyle = '#f5f5f5'; context.fillRect(0, 0, geometry.width, geometry.height);
        context.fillStyle = outputId === 'owner' ? '#c33448' : '#235ca6';
        context.beginPath(); context.arc(current.position.x * geometry.width, current.position.y * geometry.height, 8, 0, Math.PI * 2); context.fill();
        context.fillStyle = '#111'; context.font = '14px sans-serif'; context.fillText(current.label, 12, 24);
        if (current.privateValue !== undefined) context.fillText(String(current.privateValue), 12, 45);
        received.set(outputId, frame);
      } });
    if (mounted.ok) mounts.set(outputId, mounted);
    return mounted.ok;
  }
  return {
    views,
    approvePublic(allow = true) { publicApproved = allow && !stopped; views.revoke('bob'); mounts.get('right')?.stop(); mounts.delete('right'); mounts.get('left')?.stop(); mounts.delete('left'); received.delete('left'); received.delete('right'); return publicApproved && mount('left', 'alice') && mount('right', 'bob'); },
    approveOwner(allow = true, principalId = 'alice') { ownerApproved = allow && !stopped; mounts.get('owner')?.stop(); mounts.delete('owner'); received.delete('owner'); return ownerApproved && mount('owner', principalId); },
    tick() { return views.tick(); },
    revoke(principalId: string) { const count = views.revoke(principalId); for (const outputId of principalId === 'alice' ? ['left', 'owner'] : ['right']) received.delete(outputId); return count; },
    state() { return Object.freeze({ steps, engineStops, stopped, outputs: views.status().outputs,
      received: Object.freeze(Object.fromEntries(received)) }); },
    stop() { if (stopped) return; stopped = true; publicApproved = false; ownerApproved = false; views.stop(); for (const mount of mounts.values()) mount.stop(); mounts.clear(); received.clear(); },
  };
}
