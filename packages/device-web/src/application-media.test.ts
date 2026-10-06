import assert from 'node:assert/strict';
import test from 'node:test';

test('application media never accepts a copied source handle or a metadata-only capture source', async () => {
  const { createBrowserApplicationMedia } = await import('./application-media.ts');
  let authorizations = 0;
  const media = createBrowserApplicationMedia({ applicationId: 'app', sessionId: 'session', clockDomain: 'local', now: () => 1000,
    authorizeSource() { authorizations++; return undefined; }, authorizeSink() { authorizations++; return undefined; } });
  const result = media.bind({ source: { id: 'media:pretend' }, outputId: 'media:output', ownerPrincipalId: 'owner',
    container: {} as HTMLElement, label: 'Output' });
  assert.equal(await result.ready, false); assert.equal(result.status().state, 'stopped');
  assert.equal(media.registerSource({ sourceId: 'media:pretend', ownerPrincipalId: 'owner', canvas: {} as HTMLCanvasElement, maxHz: 10 }), undefined);
  assert.equal(authorizations, 0); media.close();
});

test('invalid clock permanently closes application media without granting a late retry', async () => {
  const { createBrowserApplicationMedia } = await import('./application-media.ts');
  let at = 1000;
  const media = createBrowserApplicationMedia({ applicationId: 'app', sessionId: 'session', clockDomain: 'local', now: () => at,
    authorizeSource: () => undefined, authorizeSink: () => undefined });
  at = NaN;
  const result = media.bind({ source: { id: 'media:pretend' }, outputId: 'media:output', ownerPrincipalId: 'owner', container: {} as HTMLElement, label: 'Output' });
  assert.equal(await result.ready, false); assert.equal(media.status().closed, true);
  at = 1100; assert.equal(media.status().closed, true); media.close();
});
