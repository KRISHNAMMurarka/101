import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createAssetReference } from '../../device-model/src/resource.ts';
import { processorExtensionManifestSha256, processorExtensionSigningBytes } from '../../device-model/src/extension-release.ts';
import type { ProcessorExtensionRelease } from '../../device-model/src/extension-release.ts';

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === '@101/device-model' ? new URL('../../device-model/src/index.ts', import.meta.url).href : specifier, context);
} });
test.after(() => hooks.deregister());
const api = await import('./processor-node.ts').catch(() => undefined);
const source = new Uint8Array(readFileSync(new URL('../../../examples/external-processor/processor.mjs', import.meta.url)));
const base = JSON.parse(readFileSync(new URL('../../../examples/external-processor/manifest.json', import.meta.url), 'utf8'));
const configuration = { onAt: 30, offAt: 28 };
async function signed(bytes = source, memory = 65536, compute = 5) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const reference = await createAssetReference('example:processor-source', 'blob', bytes);
  const manifest = { ...base, codeSha256: reference.sha256, budgets: { maxComputeMs: compute, maxMemoryBytes: memory, privacy: 'local-only' } };
  const unsigned = { schemaVersion: 1, profile: 'reviewed-processor-extension/1', publisherId: 'example:publisher',
    packageId: manifest.id, version: manifest.version, sequence: 1, abi: '101:processor/1', runtimeVersion: '0.1.0',
    manifest, manifestSha256: await processorExtensionManifestSha256(manifest), source: reference,
    privileges: ['compute-local'], dependencies: [] } as const;
  return { release: { ...unsigned, signature: Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey, processorExtensionSigningBytes(unsigned))).toString('hex') } as ProcessorExtensionRelease, source: bytes, publisherKey: keys.publicKey,
    minimumSequence: 1, entrypoint: 'createTemperatureBand', configuration,
    approval: { expiresAt: Date.now() + 60_000, isCurrent: () => true } };
}
const script = (process: string, prefix = 'let state;') => new TextEncoder().encode(`export function createTemperatureBand(configuration) {
  const { onAt, offAt } = configuration; ${prefix} return { process(inputs) { ${process} }, reset() { state = undefined; } }; }`);
function executorApi() { assert.ok(api, 'explicit bounded Node processor API must be implemented'); return api; }

test('signed actual threshold source executes with bounded guest memory and state/reset semantics', async () => {
  const executor = await executorApi().createNodeProcessorExecutor(await signed());
  try {
    assert.deepEqual(await executor.process({ temperature: 30 }), { ok: true, frame: { switch: true } });
    assert.deepEqual(await executor.process({ temperature: 29 }), { ok: true });
    assert.deepEqual(await executor.process({ temperature: 28 }), { ok: true, frame: { switch: false } });
    assert.deepEqual(await executor.reset(), { ok: true });
    assert.deepEqual(await executor.process({ temperature: 31 }), { ok: true, frame: { switch: true } });
    assert.equal(executor.status().guestMemoryBytes, 65536);
    assert.equal(executor.status().rawExecutors, 1);
  } finally { await executor.close(); }
  assert.equal(executor.status().rawExecutors, 0);
});

test('a genuine nonreturning guest loop leaves parent control responsive and releases only after actual exit', async () => {
  const executor = await executorApi().createNodeProcessorExecutor(await signed(script('while (true) {}'), 65536, 100));
  const pending = executor.process({ temperature: 31 });
  let responsive = false;
  await new Promise<void>(resolve => setTimeout(() => { responsive = true; resolve(); }, 10));
  assert.equal(responsive, true);
  const exit = executor.close();
  assert.equal(executor.status().active, false);
  assert.equal(executor.status().rawExecutors, 1, 'logical Stop retains the raw worker reservation');
  assert.deepEqual(await pending, { ok: false, reason: 'inactive' });
  await exit;
  assert.equal(executor.status().rawExecutors, 0);
  assert.deepEqual(await executor.process({ temperature: 31 }), { ok: false, reason: 'inactive' });
});

test('approval timers preserve the original expiry beyond a one-minute polling interval', async context => {
  const options = await signed();
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const executor = await executorApi().createNodeProcessorExecutor({ ...options,
    approval: { expiresAt: Date.now() + 120_000, isCurrent: () => true } });
  try {
    context.mock.timers.tick(60_000);
    assert.equal(executor.status().active, true, 'a current approval must survive the first polling interval');
    assert.deepEqual(await executor.process({ temperature: 31 }), { ok: true, frame: { switch: true } });
    context.mock.timers.tick(59_999);
    assert.equal(executor.status().active, true);
    context.mock.timers.tick(1);
    assert.equal(executor.status().active, false, 'the original expiry still retires authority');
  } finally { await executor.close(); }
  assert.equal(executor.status().rawExecutors, 0);
});

test('nonreturning computation is terminated by the real parent deadline', async () => {
  const executor = await executorApi().createNodeProcessorExecutor(await signed(script('while (true) {}'), 65536, 20));
  try { assert.deepEqual(await executor.process({ temperature: 31 }), { ok: false, reason: 'timeout' }); }
  finally { await executor.close(); }
  assert.equal(executor.status().rawExecutors, 0);
});

test('guest allocation cannot grow beyond the fixed arena and oversized output is refused', async () => {
  // Exercise memory/output refusal independently of the dedicated compute-deadline tests.
  const oversized = await executorApi().createNodeProcessorExecutor(await signed(script('const bytes = new Uint8Array(65537); return { switch: true };'), 65536, 100));
  try { assert.deepEqual(await oversized.process({ temperature: 31 }), { ok: false, reason: 'memory' }); }
  finally { await oversized.close(); }
  const invalid = await executorApi().createNodeProcessorExecutor(await signed(script('return { switch: { nested: true } };'), 65536, 100));
  try { assert.deepEqual(await invalid.process({ temperature: 31 }), { ok: false, reason: 'output' }); }
  finally { await invalid.close(); }
});

test('filesystem network native and code-generation names never acquire a host primitive', async () => {
  for (const operation of ['process.mainModule', 'fetch(inputs.temperature)', 'require(inputs.temperature)',
    'WebAssembly.compile(inputs.temperature)', 'Function(inputs.temperature)', 'configuration.constructor']) {
    await assert.rejects(executorApi().createNodeProcessorExecutor(await signed(script(`const value = ${operation}; return { switch: true };`))),
      error => error instanceof Error && error.message === 'processor-language');
  }
});

test('signature source pin rollback floor and fresh approval are required before worker acquisition', async () => {
  const options = await signed();
  await assert.rejects(executorApi().createNodeProcessorExecutor({ ...options, source: new TextEncoder().encode('changed') }));
  await assert.rejects(executorApi().createNodeProcessorExecutor({ ...options, minimumSequence: 2 }));
  await assert.rejects(executorApi().createNodeProcessorExecutor({ ...options, approval: { ...options.approval, isCurrent: () => false } }));
  await assert.rejects(executorApi().createNodeProcessorExecutor({ ...options, configuration: { onAt: 28, offAt: 30 } }));
});

test('revoked authority fences a computed output and input validation does not dispatch guest work', async () => {
  let current = true;
  const options = await signed();
  const executor = await executorApi().createNodeProcessorExecutor({ ...options,
    approval: { ...options.approval, isCurrent: () => current } });
  try {
    assert.deepEqual(await executor.process({ temperature: '31' }), { ok: false, reason: 'input' });
    const pending = executor.process({ temperature: 31 });
    current = false;
    assert.deepEqual(await pending, { ok: false, reason: 'inactive' });
    assert.equal(executor.status().active, false);
  } finally { await executor.close(); }
});

test('bounded output reconstruction refuses expansion through shared guest records before host transfer', async () => {
  const declarations = ['const a = { one: true, two: true };'];
  let previous = 'a';
  for (let index = 0; index < 10; index++) { const key = `a${index}`; declarations.push(`const ${key} = { one: ${previous}, two: ${previous} };`); previous = key; }
  const executor = await executorApi().createNodeProcessorExecutor(await signed(script(`${declarations.join(' ')} return { switch: ${previous} };`), 65536, 100));
  try { assert.deepEqual(await executor.process({ temperature: 31 }), { ok: false, reason: 'output' }); }
  finally { await executor.close(); }
});

test('construction and reset use the same finite computation budget', async () => {
  await assert.rejects(executorApi().createNodeProcessorExecutor(await signed(script('return { switch: true };', 'let state; while (true) {}'), 65536, 20)),
    error => error instanceof Error && error.message === 'processor-timeout');
  const bytes = new TextDecoder().decode(script('return { switch: true };')).replace('state = undefined;', 'while (true) {}');
  const executor = await executorApi().createNodeProcessorExecutor(await signed(new TextEncoder().encode(bytes), 65536, 20));
  try { assert.deepEqual(await executor.reset(), { ok: false, reason: 'timeout' }); }
  finally { await executor.close(); }
});

test('unsupported and overdeep source is refused before worker construction', async () => {
  for (const body of ['return { switch: inputs.temperature + "string" };', `return { switch: ${Array(100).fill('inputs.temperature').join(' + ')} };`,
    'return { switch: inputs.temperature / 0 };']) {
    const options = await signed(script(body));
    if (body.includes('/ 0')) {
      const executor = await executorApi().createNodeProcessorExecutor(options);
      try { assert.deepEqual(await executor.process({ temperature: 31 }), { ok: false, reason: 'compute' }); }
      finally { await executor.close(); }
    } else await assert.rejects(executorApi().createNodeProcessorExecutor(options), error => error instanceof Error && error.message === 'processor-language');
  }
});
