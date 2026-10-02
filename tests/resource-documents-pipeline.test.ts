import assert from 'node:assert/strict';
import test from 'node:test';
import { runResourceDocumentExample } from '../examples/device-pipelines/resource-documents.ts';

test('public document example verifies two bounded resources and rejects denied or changed content', async () => {
  const result = await runResourceDocumentExample();
  assert.deepEqual(result, {
    kind: 'embedded-simulated-resource',
    text: 'Hello from a bounded resource.',
    documentTitle: '101 resource example',
    denied: true,
    corrupted: true,
    cancelled: true,
  });
});
