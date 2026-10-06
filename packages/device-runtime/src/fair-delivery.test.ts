import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from './index.ts';

function device(id: string, reliable: boolean, sink = false) {
  return { schemaVersion: 1, id, label: id, revision: 1,
    adapter: { id: 'example:fair-delivery', version: '1.0.0' },
    runtime: { platform: 'embedded-node' },
    capabilities: [{ id: 'signal', semantic: 'example:fair-delivery', schemaVersion: 1,
      kind: sink ? reliable ? 'command' : 'property' : reliable ? 'event' : 'sample',
      value: { type: 'boolean' },
      delivery: reliable ? { mode: 'reliable', maxAgeMs: 5000 }
        : { mode: 'latest', maxHz: 100, maxAgeMs: 1000 },
      permissions: sink ? [reliable ? 'invoke' : 'write'] : ['subscribe'],
      ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] };
}

for (const reliable of [false, true]) {
  test(`${reliable ? 'reliable commands' : 'latest samples'} serve every backlogged recipient under delivery-slot contention`, async () => {
    let now = 0;
    const completed: (() => void)[] = [], calls: number[] = [];
    const counts = Array<number>(6).fill(0);
    const runtime = createDeviceRuntime({ now: () => now, maxPendingDeliveries: 2,
      authorize: () => ({ expiresAt: 10000, maxAgeMs: 5000, maxHz: 100 }) });
    try {
      const source = runtime.registerSource({ device: device('source', reliable), capability: 'signal' });
      runtime.setReadiness(source, 'available');
      const routes = counts.map((_count, recipient) => {
        const sink = runtime.registerSink({ device: device(`sink-${recipient}`, reliable, true), capability: 'signal',
          apply(_observation, context) {
            assert.equal(context.isCurrent(), true);
            calls.push(recipient); counts[recipient]!++;
            return new Promise<void>(resolve => completed.push(resolve));
          }, release() {} });
        runtime.setReadiness(sink, 'available');
        const route = runtime.route({ from: source, to: sink,
          principalId: `owner-${recipient}`, applicationId: 'fair-delivery',
          sessionId: `session-${recipient}`, queueCapacity: 16 });
        assert.equal(route.start().ok, true);
        return route;
      });
      for (let round = 0; round < 12; round++) {
        now += 20;
        assert.equal(runtime.publish(source, true, reliable
          ? { operationId: String(round + 1), deadline: now + 5000 } : {}).ok, true);
        runtime.flush();
        assert.equal(completed.length, 2, 'Global pending-delivery limit remains effective');
        for (const finish of completed.splice(0)) finish();
        await new Promise<void>(resolve => setImmediate(resolve));
        if (round === 2) assert.equal(new Set(calls).size, 6,
          'Each continuously eligible recipient gets a slot within three rounds');
      }
      assert.equal(calls.length, 24);
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 1,
        'Registration order must not give a recipient a persistent delivery advantage');
      runtime.close();
      assert.ok(routes.every(route => route.status().state === 'closed' && route.status().pending === 0));
    } finally {
      runtime.close();
      for (const finish of completed.splice(0)) finish();
    }
  });
}
