import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// Native Metro compression regressions moved with the agent to Connect.
const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require('source-map-js') as {
  SourceMapConsumer: new (map: object) => { originalPositionFor: (position: object) => object };
};

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
