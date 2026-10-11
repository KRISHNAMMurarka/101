import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { createServer, get, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import zlib from 'node:zlib';
import type { Transform } from 'node:stream';

const require = createRequire(import.meta.url);
const { compression } = require('../node_modules/expo/node_modules/@expo/cli/build/src/start/server/metro/dev-server/compression.js') as {
  compression: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
};
const { quote } = require('shell-quote') as { quote: (tokens: (string | { comment: string })[]) => string };
const { SourceMapConsumer } = require('source-map-js') as {
  SourceMapConsumer: new (map: object) => { originalPositionFor: (position: object) => object };
};

function observeStreams(t: TestContext, factory: 'createGzip' | 'createDeflate' | 'createBrotliCompress') {
  const streams: Transform[] = [];
  const create = zlib[factory];
  // Observe actual native streams; their lifecycle and outputs are not mocked.
  t.mock.method(zlib, factory, (options: zlib.ZlibOptions & zlib.BrotliOptions) => {
    const stream = create(options);
    streams.push(stream);
    return stream;
  });
  return streams;
}

for (const [encoding, factory] of [
  ['gzip', 'createGzip'], ['deflate', 'createDeflate'], ['br', 'createBrotliCompress'],
] as const) {
  test(`compression releases ${encoding} after an actual client disconnect`, { timeout: 5_000 }, async t => {
    const streams = observeStreams(t, factory);
    let closed!: () => void;
    const responseClosed = new Promise<void>(resolve => { closed = resolve; });
    const server = createServer((request, response) => compression(request, response, () => {
      response.once('close', closed);
      response.setHeader('Content-Type', 'text/plain');
      response.write('ordinary bundle text\n'.repeat(2_000));
      (response as ServerResponse & { flush: () => void }).flush();
    }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = get({ host: '127.0.0.1', port: address.port, path: '/index.bundle', headers: { 'Accept-Encoding': encoding } });
    try {
      const [response] = await once(client, 'response') as [IncomingMessage];
      assert.equal(response.headers['content-encoding'], encoding);
      await once(response, 'data');
      response.destroy();
      await responseClosed;
      await setImmediate();
      assert.equal(streams.length, 1);
      assert.equal(streams[0].destroyed, true, 'abandoned response must destroy its native compression stream');
      assert.equal(streams[0].closed, true);
    } finally {
      client.destroy();
      for (const stream of streams) stream.destroy();
      const joined = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await joined;
    }
  });

  test(`compression preserves an ordinary complete ${encoding} response`, { timeout: 5_000 }, async () => {
    const body = Buffer.from('ordinary bundle text\n'.repeat(2_000));
    const server = createServer((request, response) => compression(request, response, () => {
      response.setHeader('Content-Type', 'text/plain');
      response.end(body);
    }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = get({ host: '127.0.0.1', port: address.port, path: '/index.map?platform=ios', headers: { 'Accept-Encoding': encoding } });
    try {
      const [response] = await once(client, 'response') as [IncomingMessage];
      assert.equal(response.headers['content-encoding'], encoding);
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      const packed = Buffer.concat(chunks);
      const unpacked = encoding === 'gzip' ? zlib.gunzipSync(packed) : encoding === 'br' ? zlib.brotliDecompressSync(packed) : zlib.inflateSync(packed);
      assert.deepEqual(unpacked, body);
    } finally {
      client.destroy();
      const joined = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await joined;
    }
  });
}

test('compression releases a stream created after the response already closed', async t => {
  const streams = observeStreams(t, 'createGzip');
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.method = 'GET';
  request.url = '/index.bundle';
  request.headers['accept-encoding'] = 'gzip';
  const response = new ServerResponse(request);
  try {
    compression(request, response, () => {});
    response.setHeader('Content-Type', 'text/plain');
    // Model a close before the asynchronous bundler supplies its body. This
    // lifecycle case uses actual HTTP objects and an actual native zlib stream.
    response.emit('close');
    response.end('ordinary bundle text\n'.repeat(2_000));
    await setImmediate();
    assert.equal(streams.length, 1);
    assert.equal(streams[0].destroyed, true);
    assert.equal(streams[0].closed, true);
  } finally {
    for (const stream of streams) stream.destroy();
    request.destroy();
    response.destroy();
    socket.destroy();
  }
});

for (const control of [
  { name: 'non-bundle endpoint', path: '/status.json', method: 'GET', encoding: 'gzip', text: 'ordinary response\n'.repeat(2_000) },
  { name: 'identity negotiation', path: '/index.bundle', method: 'GET', encoding: 'identity', text: 'ordinary response\n'.repeat(2_000) },
  { name: 'small bundle', path: '/index.bundle', method: 'GET', encoding: 'gzip', text: 'small' },
  { name: 'HEAD request', path: '/index.bundle', method: 'HEAD', encoding: 'gzip', text: 'ordinary response\n'.repeat(2_000) },
]) {
  test(`Expo compression preserves ${control.name}`, { timeout: 5_000 }, async () => {
    const server = createServer((request, response) => compression(request, response, () => {
      response.setHeader('Content-Type', 'text/plain');
      response.end(control.text);
    }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = get({ host: '127.0.0.1', port: address.port, path: control.path, method: control.method, headers: { 'Accept-Encoding': control.encoding } });
    try {
      const [response] = await once(client, 'response') as [IncomingMessage];
      assert.equal(response.headers['content-encoding'], undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).toString(), control.method === 'HEAD' ? '' : control.text);
    } finally {
      client.destroy();
      const joined = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await joined;
    }
  });
}

test('shell quoting rejects line terminators after comments and preserves ordinary arguments', () => {
  for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => quote(['echo', { comment: 'context' }, `arg${terminator}next`]), TypeError);
  }
  assert.equal(quote(['echo', 'ordinary argument']), "echo 'ordinary argument'");
});

const basicMap = { version: 3, sources: ['input.css'], names: [], mappings: 'AAAA' };
const indexedMap = (line: unknown, column: unknown = 0, map: object = basicMap) => ({
  version: 3, sections: [{ offset: { line, column }, map }],
});

test('source maps reject excessive, invalid and accumulated nested offsets', () => {
  for (const offset of [10_000_001, Infinity, NaN, 0.5, '1']) {
    assert.throws(() => new SourceMapConsumer(indexedMap(offset)), Error);
  }
  assert.throws(() => new SourceMapConsumer(indexedMap(6_000_000, 0, indexedMap(6_000_000))), Error);
  assert.throws(() => new SourceMapConsumer(indexedMap(0, 0.5)), Error);
});

test('source maps preserve valid indexed mappings', () => {
  const consumer = new SourceMapConsumer(indexedMap(3));
  assert.deepEqual(consumer.originalPositionFor({ line: 4, column: 1 }), {
    source: 'input.css', line: 1, column: 0, name: null,
  });
});
