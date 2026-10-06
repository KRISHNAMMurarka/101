import { createBrowserApplicationVideoCodec } from '@101/connect';
import type { BrowserApplicationVideoCodecBinding, BrowserVideoCodec, BrowserVideoCodecGrantRequest, BrowserVideoCodecOwnerGrant } from '@101/connect';

/** Local application pixels only. Both host owners explicitly choose each
 * recipient; their native signals, not labels or copied requests, revoke it. */
export function createApplicationVideoCodecExample(sourceCanvas: HTMLCanvasElement, containers: { first: HTMLElement; second: HTMLElement }, options: {
  ownerSignal: AbortSignal; now?: () => number; beforeApproval?: (request: BrowserVideoCodecGrantRequest) => void;
}) {
  const now = options.now ?? (() => performance.now());
  const recipients = { first: 'alice', second: 'bob' } as const;
  const choices = new Map<string, AbortController>(), bindings = new Map<string, BrowserApplicationVideoCodecBinding>();
  const opening = new Map<string, number>(), deadlines = new Map<string, number>(); let closed = false, generation = 0;
  function approve(request: BrowserVideoCodecGrantRequest): BrowserVideoCodecOwnerGrant | undefined {
    options.beforeApproval?.(request);
    const key = request.outputId === 'video:first' ? 'first' : request.outputId === 'video:second' ? 'second' : undefined;
    if (!key || closed || options.ownerSignal.aborted || request.applicationId !== 'application-video-codec-example' || request.sessionId !== 'local-session' ||
      request.sourceId !== 'video:application' || request.sourceOwnerPrincipalId !== 'source-owner' || request.sinkOwnerPrincipalId !== recipients[key] ||
      request.recipientPrincipalId !== recipients[key] || request.ownerPrincipalId !== (request.role === 'source' ? 'source-owner' : recipients[key]) ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
    const selected = choices.get(key + ':' + request.role); if (!selected || selected.signal.aborted) return;
    const expiresAt = deadlines.get(key); if (expiresAt === undefined) return;
    return { request, signal: selected.signal, grant: { expiresAt, maxHz: 20, maxAgeMs: 1000 } };
  }
  const video = createBrowserApplicationVideoCodec({ ownerSignal: options.ownerSignal, applicationId: 'application-video-codec-example', sessionId: 'local-session',
    clockDomain: 'caller-performance', now, authorizeSource: approve, authorizeSink: approve });
  const source = video.registerSource({ sourceId: 'video:application', ownerPrincipalId: 'source-owner', canvas: sourceCanvas });
  return Object.freeze({
    video,
    setConsent(output: 'first' | 'second', role: 'source' | 'sink', allowed: boolean) {
      const key = output + ':' + role, previous = choices.get(key);
      if (!allowed || closed) { previous?.abort(); choices.delete(key); video.revokeOutput('video:' + output); return; }
      if (!previous || previous.signal.aborted) choices.set(key, new AbortController());
    },
    async start(output: 'first' | 'second', codecs: readonly BrowserVideoCodec[] = ['video/vp8', 'video/vp9']): Promise<BrowserApplicationVideoCodecBinding | undefined> {
      if (closed || !source || options.ownerSignal.aborted) return;
      const token = ++generation; opening.set(output, token);
      const previous = bindings.get(output); previous?.stop(); if (previous) await previous.closed;
      if (closed || options.ownerSignal.aborted || opening.get(output) !== token) return;
      const owner = new AbortController(); deadlines.set(output, now() + 10000);
      if (closed || options.ownerSignal.aborted || opening.get(output) !== token) return;
      const binding = video.bind({ source, outputId: 'video:' + output, ownerPrincipalId: recipients[output], container: containers[output],
        label: output === 'first' ? 'First application display' : 'Second application display', codecs, ownerSignal: owner.signal });
      bindings.set(output, binding); return binding;
    },
    capture() { return !closed && !!source && video.capture(source); },
    state() { return Object.freeze({ closed, controller: video.status(), bindings: Object.freeze(Object.fromEntries([...bindings].map(([key, binding]) => [key, binding.status()]))) }); },
    async stop() { if (!closed) { closed = true; generation++; opening.clear(); for (const owner of choices.values()) owner.abort(); choices.clear(); } await video.close(); },
  });
}
