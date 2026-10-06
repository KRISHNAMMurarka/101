import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserApplicationVideoCodec } from './application-video-codec.ts';
import type { BrowserApplicationVideoCodecOptions } from './application-video-codec.ts';

function options(ownerSignal = new AbortController().signal): BrowserApplicationVideoCodecOptions {
  return { ownerSignal, applicationId: 'owned-video', sessionId: 'session', clockDomain: 'host-performance', now: () => 10,
    authorizeSource: () => undefined, authorizeSink: () => undefined };
}

test('a genuine controller owner signal is required without reading a spoofed getter', () => {
  let reads = 0;
  const spoof = { get aborted() { reads++; return false; } } as unknown as AbortSignal;
  assert.throws(() => createBrowserApplicationVideoCodec(options(spoof)), TypeError);
  assert.equal(reads, 0);
});

test('construction and invalid source admission do not invoke owner approvals or acquire codecs', async () => {
  let approvals = 0;
  const controller = createBrowserApplicationVideoCodec({ ...options(), authorizeSource() { approvals++; return undefined; }, authorizeSink() { approvals++; return undefined; } });
  const binding = controller.bind({ source: {}, outputId: 'video:output', ownerPrincipalId: 'recipient',
    container: {} as HTMLElement, label: 'Owned output', codecs: ['video/vp8'], ownerSignal: new AbortController().signal });
  assert.equal(await binding.ready, false);
  assert.equal(binding.status().reason, 'invalid');
  assert.equal(approvals, 0);
  assert.equal(controller.status().pendingNative, 0);
  await controller.close();
});

test('shadowing aborted cannot resurrect controller ownership', async () => {
  const owner = new AbortController(); owner.abort();
  Object.defineProperty(owner.signal, 'aborted', { value: false });
  const controller = createBrowserApplicationVideoCodec(options(owner.signal));
  assert.equal(controller.status().closed, true);
  assert.equal(controller.capture({}), false);
  await controller.close();
  assert.equal(controller.status().pendingNative, 0);
});

test('clock reentry closes the real controller before source acquisition', async () => {
  const controller: ReturnType<typeof createBrowserApplicationVideoCodec> = createBrowserApplicationVideoCodec({ ...options(), now() { void controller.close(); return 10; } });
  assert.equal(controller.registerSource({ sourceId: 'video:source', ownerPrincipalId: 'owner', canvas: {} as HTMLCanvasElement }), undefined);
  assert.equal(controller.status().closed, true);
  await controller.close();
});

test('closed options reject accessors without running them', () => {
  let reads = 0;
  const input = options(); Object.defineProperty(input, 'applicationId', { enumerable: true, get() { reads++; return 'owned-video'; } });
  assert.throws(() => createBrowserApplicationVideoCodec(input), TypeError);
  assert.equal(reads, 0);
});
