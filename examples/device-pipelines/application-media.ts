import { createBrowserApplicationMedia } from '@101/connect';
import type { BrowserApplicationMediaBinding, BrowserMediaGrantRequest, BrowserMediaOwnerGrant } from '@101/connect';

/** The caller owns this generated source; separate host decisions approve each native output. */
export function createApplicationMediaExample(sourceCanvas: HTMLCanvasElement, containers: { first: HTMLElement; second: HTMLElement }, options: {
  now?: () => number;
  beforeApproval?: (request: Readonly<BrowserMediaGrantRequest>) => void;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const sourceConsent = new Set<string>(), sinkConsent = new Set<string>(), bindings = new Map<string, BrowserApplicationMediaBinding>();
  let closed = false;
  const recipients = { first: 'alice', second: 'bob' } as const;
  function approve(request: Readonly<BrowserMediaGrantRequest>): BrowserMediaOwnerGrant | undefined {
    options.beforeApproval?.(request);
    const key = request.outputId === 'media:first' ? 'first' : request.outputId === 'media:second' ? 'second' : undefined;
    if (!key || closed || request.applicationId !== 'application-media-example' || request.sessionId !== 'local-session' ||
        request.sourceId !== 'media:application' || request.sourceOwnerPrincipalId !== 'source-owner' ||
        request.recipientPrincipalId !== recipients[key] || request.sinkOwnerPrincipalId !== recipients[key] ||
        request.ownerPrincipalId !== (request.role === 'source' ? 'source-owner' : recipients[key]) ||
        !(request.role === 'source' ? sourceConsent : sinkConsent).has(key)) return;
    return { request, grant: { expiresAt: now() + 10000, maxHz: 10, maxAgeMs: 1000 } };
  }
  const media = createBrowserApplicationMedia({ applicationId: 'application-media-example', sessionId: 'local-session', clockDomain: 'application-clock', now,
    authorizeSource: approve, authorizeSink: approve });
  const source = media.registerSource({ sourceId: 'media:application', ownerPrincipalId: 'source-owner', canvas: sourceCanvas, maxHz: 10 });
  return Object.freeze({
    media,
    setConsent(output: 'first' | 'second', role: 'source' | 'sink', allowed: boolean) {
      const choices = role === 'source' ? sourceConsent : sinkConsent;
      if (!closed && allowed) choices.add(output); else choices.delete(output);
      if (!allowed) media.revokeOutput(`media:${output}`);
    },
    start(output: 'first' | 'second'): BrowserApplicationMediaBinding | undefined {
      if (closed || !source) return;
      bindings.get(output)?.stop();
      const binding = media.bind({ source, outputId: `media:${output}`, ownerPrincipalId: recipients[output], container: containers[output], label: `${output === 'first' ? 'First' : 'Second'} application display` });
      bindings.set(output, binding); return binding;
    },
    state() { return Object.freeze({ closed, controller: media.status(), bindings: Object.freeze(Object.fromEntries([...bindings].map(([key, binding]) => [key, binding.status()]))) }); },
    stop() { if (closed) return; closed = true; sourceConsent.clear(); sinkConsent.clear(); media.close(); },
  });
}
