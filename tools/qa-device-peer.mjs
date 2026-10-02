import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import ts from 'typescript';

const name = process.argv[2] ?? 'chromium';
const browserType = { chromium, firefox, webkit }[name];
if (!browserType) throw new Error('Expected chromium, firefox or webkit');
const source = readFileSync(new URL('../packages/transport-webrtc/src/peer.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
} }).outputText;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><title>Local peer qualification</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await browserType.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async code => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const { PeerDataTransport } = await import(url);
    URL.revokeObjectURL(url);
    const host = new PeerDataTransport({ initiator: true });
    const phone = new PeerDataTransport({ initiator: false });
    const received = [];
    host.onData((lane, data) => received.push({ receiver: 'host', lane, data: typeof data === 'string' ? data : [...new Uint8Array(data)] }));
    phone.onData((lane, data) => received.push({ receiver: 'phone', lane, data: typeof data === 'string' ? data : [...new Uint8Array(data)] }));
    const waitFor = async condition => {
      const started = performance.now();
      while (!condition()) {
        if (performance.now() - started > 10000) {
          const diagnostics = [];
          for (const peer of [host, phone]) {
            const entries = [];
            (await peer.stats())?.forEach(record => {
              if (['transport', 'candidate-pair', 'local-candidate', 'remote-candidate'].includes(record.type))
                entries.push({ type: record.type, state: record.state, dtlsState: record.dtlsState,
                  candidateType: record.candidateType, protocol: record.protocol, nominated: record.nominated });
            });
            diagnostics.push({ state: peer.state, reliable: peer.isOpen('reliable'), disposable: peer.isOpen('disposable'), entries });
          }
          throw new Error(`Peer loopback timed out: ${JSON.stringify(diagnostics)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    try {
      await phone.acceptOffer(await host.createOffer()).then(answer => host.acceptAnswer(answer));
      await waitFor(() => [host, phone].every(peer => peer.state === 'connected' && peer.isOpen('reliable') && peer.isOpen('disposable')));
      const started = performance.now();
      const accepted = [host.send('reliable', 'descriptor-v1'), phone.send('reliable', 'grant-v1'),
        host.send('disposable', new Uint8Array([0, 32, 255])), phone.send('disposable', '{"x":0.2,"y":0.8}')];
      await waitFor(() => received.length === 4);
      const elapsed = performance.now() - started;
      const stats = await host.stats();
      const paths = [];
      stats?.forEach(record => {
        if (record.type === 'candidate-pair' && record.state === 'succeeded') paths.push({ type: record.type, state: record.state });
      });
      await host.disconnect(); await phone.disconnect();
      return { accepted, received, elapsedMs: elapsed, paths, states: [host.state, phone.state],
        afterStopAccepted: host.send('reliable', 'stale'), userAgent: navigator.userAgent };
    } finally { await host.disconnect(); await phone.disconnect(); }
  }, javascript);
  assert.deepEqual(result.accepted, [true, true, true, true]);
  assert.deepEqual(result.states, ['disconnected', 'disconnected']);
  assert.equal(result.afterStopAccepted, false);
  for (const expected of [
    { receiver: 'phone', lane: 'reliable', data: 'descriptor-v1' },
    { receiver: 'host', lane: 'reliable', data: 'grant-v1' },
    { receiver: 'phone', lane: 'disposable', data: [0, 32, 255] },
    { receiver: 'host', lane: 'disposable', data: '{"x":0.2,"y":0.8}' },
  ]) assert.ok(result.received.some(received => JSON.stringify(received) === JSON.stringify(expected)));
  console.log(JSON.stringify({ scope: 'single-machine real browser two-peer WebRTC loopback; no physical phone or authenticated resource route',
    browser: name, version: browser.version(), sourceSha256: createHash('sha256').update(source).digest('hex'), result }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
