import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createDisposableLoopbackSshHost, ownedSshHostPort } from '../../../examples/terminal-resources/disposable-host.mjs';
import { createScopedLoopbackSshConnector } from '../../../examples/terminal-resources/ssh-connector.mjs';

const scope = { principalId: 'ssh-owner', applicationId: 'local-terminal-client', sessionId: 'fixture' };
const makeContext = (signal = new AbortController().signal, isCurrent = () => true) => ({ signal, routeId: 'owned-route', generation: 1, operationId: '1', isCurrent });
const approve = (request: { expiresAt: number }) => ({ request, expiresAt: request.expiresAt, signal: new AbortController().signal });
async function fixture(run: (host: Awaited<ReturnType<typeof createDisposableLoopbackSshHost>>) => Promise<void>) {
  const host = await createDisposableLoopbackSshHost();
  try { await run(host); } finally { await host.stop(); assert.equal(host.status().removedOwnedRoot, true); assert.equal(host.status().nativePending, 0); }
}
const options = (host: Awaited<ReturnType<typeof createDisposableLoopbackSshHost>>) => ({ host, credential: host.credential, hostKey: host.identity.hostKey, scope, authorize: approve });

test('selected SSH connector supplies current owner approval before a native metadata operation', async () => {
  const path = '../../../examples/terminal-resources/ssh-connector.mjs';
  const selected = await import(path).catch(() => ({}));
  assert.equal(typeof selected.createScopedLoopbackSshConnector, 'function', 'Missing selected scoped native SSH connector');
});

test('owner denial prevents genuine native dispatch; sensitive metadata needs an independent result grant', async () => fixture(async host => {
  const denied = createScopedLoopbackSshConnector({ ...options(host), authorize: () => undefined });
  assert.equal((await denied.readMetadata(makeContext())).reason, 'denied'); assert.equal(host.status().attempts, 0); await denied.close();
  let resultAllowed = false;
  const connector = createScopedLoopbackSshConnector({ ...options(host), authorize(request: { phase: string; expiresAt: number }) { return request.phase === 'operation' || resultAllowed ? approve(request) : undefined; } });
  try {
    const work = await connector.readMetadata(makeContext()); assert.equal(work.ok, true); assert.equal(work.value, undefined);
    const deniedRead = connector.readResult(work.handle, makeContext()); assert.equal(deniedRead.ok, false); if (!deniedRead.ok) assert.equal(deniedRead.reason, 'denied');
    resultAllowed = true; const output = connector.readResult(work.handle, makeContext()); assert.equal(output.ok, true);
    assert.equal(output.value.platform, 'darwin'); assert.equal(output.value.arch, 'arm64'); assert.ok(output.value.clockId.startsWith(host.identity.clockId + ':'));
    assert.equal(connector.readResult(work.handle, makeContext()).ok, false); assert.equal(connector.status().retainedResults, 0);
  } finally { await connector.close(); }
}));

test('finite admission and audit quota is retained without issuing any denied native operation', async () => fixture(async host => {
  const connector = createScopedLoopbackSshConnector({ ...options(host), authorize: () => undefined });
  try { for (let index = 0; index < 64; index++) assert.equal((await connector.readMetadata(makeContext())).reason, 'denied');
    assert.equal((await connector.readMetadata(makeContext())).reason, 'quota'); assert.equal(connector.status().attempts, 64);
    assert.equal(connector.status().audit.length, 64); assert.equal(host.status().attempts, 0); }
  finally { await connector.close(); }
}));

test('each actual native metadata process has its own monotonic source clock identity', async () => fixture(async host => {
  const connector = createScopedLoopbackSshConnector(options(host));
  try {
    const first = await connector.readMetadata(makeContext()); assert.equal(first.ok, true); const one = connector.readResult(first.handle, makeContext()); assert.equal(one.ok, true);
    const second = await connector.readMetadata(makeContext()); assert.equal(second.ok, true); const two = connector.readResult(second.handle, makeContext()); assert.equal(two.ok, true);
    assert.notEqual(one.value.clockId, two.value.clockId, 'Distinct native Node lifetimes must not reuse one performance clock identity');
  } finally { await connector.close(); }
}));

test('native OpenSSH rejects wrong host pin and unrelated scoped credential', async () => fixture(async host => fixture(async other => {
  for (const overrides of [{ hostKey: other.identity.hostKey }, { credential: other.credential }]) {
    const connector = createScopedLoopbackSshConnector({ ...options(host), ...overrides });
    try { const result = await connector.readMetadata(makeContext()); assert.equal(result.reason, 'native-failed'); assert.equal(connector.status().retainedResults, 0); }
    finally { await connector.close(); }
  }
  assert.equal(host.status().attempts, 2);
})));

test('the real forced native producer refuses the one fixed unsupported fixture literal', async () => fixture(async host => {
  const child = ownedSshHostPort(host, host.credential).spawn(host.identity.hostKey, 'unsupported-fixture');
  let bytes = 0; child.stdout.on('data', chunk => { bytes += chunk.byteLength; }); child.stderr.on('data', () => {});
  const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 64); assert.equal(bytes, 0);
}));

test('closed scope, copied fixture and accessors cannot select native input or acquire authority', async () => fixture(async host => {
  assert.throws(() => createScopedLoopbackSshConnector({ ...options(host), host: { ...host } }));
  assert.throws(() => createScopedLoopbackSshConnector({ ...options(host), scope: { ...scope, command: 'arbitrary' } }));
  let getterReads = 0;
  const connector = createScopedLoopbackSshConnector({ ...options(host), authorize(request: { expiresAt: number }) {
    return { request, expiresAt: request.expiresAt, get isCurrent() { getterReads++; return () => true; } };
  } });
  assert.equal((await connector.readMetadata(makeContext())).reason, 'denied'); assert.equal(getterReads, 0); assert.equal(host.status().attempts, 0);
  assert.throws(() => ownedSshHostPort(host, host.credential).spawn(host.identity.hostKey, 'uname -a'));
  await connector.close();
}));

test('reserve before reentrant consent and retain shared actual child through cancellation and replacement', async () => fixture(async host => {
  let nested: Promise<unknown> | undefined, connector: ReturnType<typeof createScopedLoopbackSshConnector>;
  connector = createScopedLoopbackSshConnector({ ...options(host), authorize() { nested = connector.readMetadata(makeContext()); return undefined; } });
  assert.equal((await connector.readMetadata(makeContext())).reason, 'denied'); assert.equal((await nested as { reason: string }).reason, 'busy'); await connector.close();
  const cancellation = new AbortController(); let replacement: ReturnType<typeof createScopedLoopbackSshConnector> | undefined, replacementWork: Promise<unknown> | undefined;
  connector = createScopedLoopbackSshConnector({ ...options(host), onNative(event: { stage: string }) {
    if (event.stage !== 'spawned') return;
    cancellation.abort(); assert.equal(connector.status().rawPending, 1); assert.equal(host.status().nativePending, 1);
    replacement = createScopedLoopbackSshConnector(options(host)); replacementWork = replacement.readMetadata(makeContext());
  } });
  assert.equal((await connector.readMetadata(makeContext(cancellation.signal))).reason, 'cancelled');
  assert.equal((await replacementWork as { reason: string }).reason, 'native-unavailable');
  await connector.drain(); assert.equal(host.status().nativePending, 0); assert.equal(connector.status().issued, connector.status().settled);
  await connector.close(); await replacement?.close();
  const fresh = createScopedLoopbackSshConnector(options(host)); try { assert.equal((await fresh.readMetadata(makeContext())).ok, true); } finally { await fresh.close(); }
}));

test('actual child expiry, host disconnect and fresh identity fence late results', async () => {
  let firstId: string | undefined;
  await fixture(async host => {
    firstId = host.identity.id;
    const connector = createScopedLoopbackSshConnector({ ...options(host), authorize(request: { expiresAt: number }) { return { request, expiresAt: performance.now() + 25, signal: new AbortController().signal }; } });
    assert.equal((await connector.readMetadata(makeContext())).ok, false); await connector.drain(); assert.equal(connector.status().retainedResults, 0); await connector.close();
    const disconnected = createScopedLoopbackSshConnector({ ...options(host), onNative(event: { stage: string }) { if (event.stage === 'spawned') host.stop(); } });
    assert.equal((await disconnected.readMetadata(makeContext())).ok, false); await disconnected.close();
  });
  await fixture(async host => { assert.notEqual(host.identity.id, firstId); const connector = createScopedLoopbackSshConnector({ ...options(host), authorize: () => undefined });
    assert.equal((await connector.readMetadata(makeContext())).reason, 'denied'); assert.equal(host.status().attempts, 0); await connector.close(); });
});

test('clock or result approval reentrancy cannot dispatch or return private metadata after close', async () => fixture(async host => {
  let connector: ReturnType<typeof createScopedLoopbackSshConnector>;
  connector = createScopedLoopbackSshConnector({ ...options(host), now() { connector.close(); return performance.now(); } });
  assert.equal((await connector.readMetadata(makeContext())).ok, false); assert.equal(host.status().attempts, 0); assert.equal(connector.status().timerArmed, false); await connector.close();
  let closeOnResult = false;
  connector = createScopedLoopbackSshConnector({ ...options(host), authorize(request: { phase: string; expiresAt: number }) {
    if (closeOnResult && request.phase === 'result') connector.close(); return approve(request);
  } });
  const work = await connector.readMetadata(makeContext()); assert.equal(work.ok, true); closeOnResult = true;
  assert.equal(connector.readResult(work.handle, makeContext()).ok, false); assert.equal(connector.status().retainedResults, 0); await connector.close();
}));

test('result approval remains current at the final clock boundary before private metadata return', async () => fixture(async host => {
  let resultPhase = false, reads = 0;
  const connector = createScopedLoopbackSshConnector({ ...options(host), now() { return resultPhase ? ++reads <= 2 ? 5 : reads === 3 ? 9 : 11 : 0; },
    authorize(request: { phase: string; expiresAt: number }) { if (request.phase === 'result') { resultPhase = true; return { request, expiresAt: 10, signal: new AbortController().signal }; } return approve(request); } });
  try { const work = await connector.readMetadata(makeContext()); assert.equal(work.ok, true);
    assert.equal(connector.readResult(work.handle, makeContext()).ok, false, 'Expired result grant must never expose metadata'); }
  finally { await connector.close(); }
}));

test('clock cancellation while calculating expiry cannot arm a timer after logical close', async () => fixture(async host => {
  let ticks = 0, connector: ReturnType<typeof createScopedLoopbackSshConnector>;
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout, held = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { const timer = nativeSet(...args); if (args[1] && args[1] <= 2500) held.add(timer); return timer; }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => { held.delete(timer as ReturnType<typeof setTimeout>); nativeClear(timer); }) as typeof clearTimeout;
  try {
    connector = createScopedLoopbackSshConnector({ ...options(host), now() { if (++ticks === 8) connector.close(); return 0; } });
    assert.equal((await connector.readMetadata(makeContext())).ok, false); await connector.close(); assert.equal(host.status().attempts, 0);
    assert.equal(held.size, 0, 'No live owned timer may remain after clock cancellation');
  } finally { globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear; for (const timer of held) nativeClear(timer); }
}));

for (const revoked of ['result-owner', 'result-context', 'command-owner', 'command-context']) {
  test(`final clock aborting only ${revoked} refuses actual private native metadata`, async () => fixture(async host => {
    let resultPhase = false, clockReads = 0;
    const owners = { 'result-owner': new AbortController(), 'command-owner': new AbortController() };
    const contexts = { 'result-context': new AbortController(), 'command-context': new AbortController() };
    const connector = createScopedLoopbackSshConnector({ ...options(host), now() {
      if (resultPhase && ++clockReads === 5) {
        (revoked === 'result-owner' || revoked === 'command-owner' ? owners[revoked] : contexts[revoked as keyof typeof contexts]).abort();
      }
      return 0;
    }, authorize(request: { phase: string; expiresAt: number }) {
      if (request.phase === 'result') resultPhase = true;
      return { request, expiresAt: request.expiresAt, signal: owners[request.phase === 'result' ? 'result-owner' : 'command-owner'].signal };
    } });
    try {
      const work = await connector.readMetadata(makeContext(contexts['command-context'].signal)); assert.equal(work.ok, true); assert.equal(connector.status().issued, 1);
      const result = connector.readResult(work.handle, makeContext(contexts['result-context'].signal));
      assert.equal(clockReads, 5, 'Actual final result clock boundary was reached');
      assert.equal(result.ok, false); assert.equal('value' in result, false);
    } finally { await connector.close(); }
  }));
}

test('late result-context observer advancing its deadline cannot expose native metadata', async () => fixture(async host => {
  let at = 0, checks = 0;
  const connector = createScopedLoopbackSshConnector({ ...options(host), now: () => at,
    authorize(request: { phase: string; expiresAt: number }) {
      return request.phase === 'result' ? { request, expiresAt: 10, signal: new AbortController().signal } : approve(request);
    } });
  try {
    const work = await connector.readMetadata(makeContext());
    assert.equal(work.ok, true, work.ok ? undefined : JSON.stringify({ phase: 'metadata-prerequisite', outcome: work, connector: connector.status(), host: host.status() }));
    const result = connector.readResult(work.handle, makeContext(new AbortController().signal, () => { if (++checks === 2) at = 11; return true; }));
    assert.equal(at, 11); assert.equal(result.ok, false); assert.equal('value' in result, false);
  } finally { await connector.close(); }
}));

test('late result-context observer closing the owner prevents private value return', async () => fixture(async host => {
  let checks = 0;
  const connector = createScopedLoopbackSshConnector(options(host));
  try {
    const work = await connector.readMetadata(makeContext());
    assert.equal(work.ok, true, work.ok ? undefined : JSON.stringify({ phase: 'metadata-prerequisite', outcome: work, connector: connector.status(), host: host.status() }));
    assert.equal(connector.readResult(work.handle, makeContext(new AbortController().signal, () => { if (++checks === 2) connector.close(); return true; })).ok, false);
    assert.equal(connector.status().retainedResults, 0);
  } finally { await connector.close(); }
}));

for (const revoked of ['command-owner', 'command-context']) {
  test(`final pre-dispatch clock aborting ${revoked} does not issue native SSH`, async () => fixture(async host => {
    let clockReads = 0;
    const owner = new AbortController(), route = new AbortController();
    const connector = createScopedLoopbackSshConnector({ ...options(host), now() {
      if (++clockReads === 10) (revoked === 'command-owner' ? owner : route).abort();
      return 0;
    }, authorize(request: { expiresAt: number }) { return { request, expiresAt: request.expiresAt, signal: owner.signal }; } });
    try {
      const result = await connector.readMetadata(makeContext(route.signal));
      assert.equal(clockReads, 10); assert.equal(result.ok, false); assert.equal(connector.status().issued, 0);
    } finally { await connector.close(); }
  }));
}

for (const revoked of ['command-owner', 'result-owner']) {
  test(`final result-context observer aborting ${revoked} refuses actual private metadata`, async () => fixture(async host => {
    let checks = 0;
    const commandOwner = new AbortController(), resultOwner = new AbortController();
    const connector = createScopedLoopbackSshConnector({ ...options(host), authorize(request: { phase: string; expiresAt: number }) {
      return { request, expiresAt: request.expiresAt, signal: (request.phase === 'result' ? resultOwner : commandOwner).signal };
    } });
    try {
      const work = await connector.readMetadata(makeContext());
      assert.equal(work.ok, true, work.ok ? undefined : JSON.stringify({ phase: 'metadata-prerequisite', outcome: work, connector: connector.status(), host: host.status() }));
      const result = connector.readResult(work.handle, makeContext(new AbortController().signal, () => {
        if (++checks === 2) (revoked === 'command-owner' ? commandOwner : resultOwner).abort();
        return true;
      }));
      assert.equal(checks, 2); assert.equal(result.ok, false); assert.equal('value' in result, false);
    } finally { await connector.close(); }
  }));
}

test('final command-context observer aborting owner prevents actual native dispatch', async () => fixture(async host => {
  let checks = 0;
  const owner = new AbortController();
  const connector = createScopedLoopbackSshConnector({ ...options(host), authorize(request: { expiresAt: number }) {
    return { request, expiresAt: request.expiresAt, signal: owner.signal };
  } });
  try {
    const result = await connector.readMetadata(makeContext(new AbortController().signal, () => { if (++checks === 4) owner.abort(); return true; }));
    assert.equal(checks, 4); assert.equal(result.ok, false); assert.equal(connector.status().issued, 0);
  } finally { await connector.close(); }
}));

test('missing, callback-only, forged and accessor owner signals never authorize native work', async () => fixture(async host => {
  let getterReads = 0;
  for (const malformed of [
    (request: { expiresAt: number }) => ({ request, expiresAt: request.expiresAt }),
    (request: { expiresAt: number }) => ({ request, expiresAt: request.expiresAt, isCurrent: () => true }),
    (request: { expiresAt: number }) => ({ ...approve(request), isCurrent: () => true }),
    (request: { expiresAt: number }) => ({ request, expiresAt: request.expiresAt, signal: { aborted: false } }),
    (request: { expiresAt: number }) => ({ request, expiresAt: request.expiresAt, signal: Object.create(AbortSignal.prototype) }),
    (request: { expiresAt: number }) => ({ request, expiresAt: request.expiresAt, get signal() { getterReads++; return new AbortController().signal; } }),
  ]) {
    const connector = createScopedLoopbackSshConnector({ ...options(host), authorize: malformed });
    try { assert.equal((await connector.readMetadata(makeContext())).reason, 'denied'); assert.equal(connector.status().issued, 0); }
    finally { await connector.close(); }
  }
  assert.equal(getterReads, 0); assert.equal(host.status().attempts, 0);
}));

test('intrinsic owner signal rejects shadowed and subclass aborted properties without calling them', async () => fixture(async host => {
  let getterReads = 0;
  class HidingAbortSignal extends AbortSignal { get aborted() { getterReads++; return false; } }
  for (const disguise of ['own', 'subclass']) {
    const owner = new AbortController();
    if (disguise === 'own') Object.defineProperty(owner.signal, 'aborted', { get() { getterReads++; return false; } });
    else Object.setPrototypeOf(owner.signal, HidingAbortSignal.prototype);
    owner.abort();
    const connector = createScopedLoopbackSshConnector({ ...options(host), authorize(request: { expiresAt: number }) {
      return { request, expiresAt: request.expiresAt, signal: owner.signal };
    } });
    try { assert.equal((await connector.readMetadata(makeContext())).reason, 'denied'); assert.equal(connector.status().issued, 0); }
    finally { await connector.close(); }
  }
  assert.equal(getterReads, 0); assert.equal(host.status().attempts, 0);
}));

test('intrinsic delivery signal rejects shadowed abort and forged signal before native dispatch', async () => fixture(async host => {
  let getterReads = 0;
  const route = new AbortController(); Object.defineProperty(route.signal, 'aborted', { get() { getterReads++; return false; } }); route.abort();
  const connector = createScopedLoopbackSshConnector(options(host));
  try {
    assert.equal((await connector.readMetadata(makeContext(route.signal))).ok, false);
    assert.equal((await connector.readMetadata(makeContext(Object.create(AbortSignal.prototype)))).reason, 'invalid');
    assert.equal(connector.status().issued, 0); assert.equal(getterReads, 0);
  } finally { await connector.close(); }
}));

test('owner abort retains an issued raw reservation until actual close and fresh consent can retry', async () => fixture(async host => {
  let owner = new AbortController();
  const connector = createScopedLoopbackSshConnector({ ...options(host), authorize(request: { expiresAt: number }) {
    return { request, expiresAt: request.expiresAt, signal: owner.signal };
  }, onNative(event: { stage: string }) { if (event.stage === 'spawned' && !owner.signal.aborted) { owner.abort(); assert.equal(connector.status().rawPending, 1); } } });
  try {
    assert.equal((await connector.readMetadata(makeContext())).reason, 'revoked'); await connector.drain(); assert.equal(host.status().nativePending, 0);
    assert.equal((await connector.readMetadata(makeContext())).reason, 'denied');
  } finally { await connector.close(); }
  owner = new AbortController();
  const fresh = createScopedLoopbackSshConnector({ ...options(host), authorize(request: { expiresAt: number }) {
    return { request, expiresAt: request.expiresAt, signal: owner.signal };
  } });
  try { const work = await fresh.readMetadata(makeContext()); assert.equal(work.ok, true); assert.equal(fresh.readResult(work.handle, makeContext()).ok, true); }
  finally { await fresh.close(); }
}));

const summaryFixture = '101 reviewed fixture\nA declared SSH job counts only this document.\n';

test('declared SSH fixture-summary job keeps operation and result grants separate and returns actual document counts', async () => fixture(async host => {
  const denied = createScopedLoopbackSshConnector({ ...options(host), authorize: () => undefined });
  assert.equal(typeof denied.readFixtureSummary, 'function', 'Missing declared allowed SSH operation');
  try { assert.equal((await denied.readFixtureSummary(makeContext())).reason, 'denied'); assert.equal(host.status().attempts, 0); }
  finally { await denied.close(); }
  const requests: Array<{ profile: string; operation: string; phase: string; resourceId: string; expiresAt: number }> = [];
  let resultAllowed = false;
  const connector = createScopedLoopbackSshConnector({ ...options(host), authorize(request: typeof requests[number]) {
    requests.push(request); return request.phase === 'operation' || resultAllowed ? approve(request) : undefined;
  } });
  try {
    const work = await connector.readFixtureSummary(makeContext()); assert.equal(work.ok, true); assert.equal(work.value, undefined);
    const refusedResult = connector.readResult(work.handle, makeContext());
    assert.equal(refusedResult.ok, false);
    if (!refusedResult.ok) assert.equal(refusedResult.reason, 'denied');
    resultAllowed = true; const result = connector.readResult(work.handle, makeContext()); assert.equal(result.ok, true);
    assert.equal(result.value.profile, 'loopback-openssh-fixture-summary/1');
    assert.equal(result.value.fixtureId, 'reviewed-document');
    assert.equal(result.value.bytes, Buffer.byteLength(summaryFixture));
    assert.equal(result.value.lines, summaryFixture.split('\n').length - 1);
    assert.equal(result.value.sha256, createHash('sha256').update(summaryFixture).digest('hex'));
    assert.ok(result.value.clockId.startsWith(host.identity.clockId + ':'));
    assert.ok(requests.every(request => request.profile === 'loopback-openssh-fixture-summary/1' && request.operation === 'fixture-summary'));
    assert.equal(requests[0].resourceId, 'fixture-summary-command'); assert.equal(requests.at(-1)?.resourceId, 'fixture-summary-result');
    assert.equal(connector.readResult(work.handle, makeContext()).ok, false);
    assert.equal(connector.status().audit.at(-1)?.operation, 'fixture-summary');
    assert.equal(connector.status().retainedResults, 0);
  } finally { await connector.close(); }
}));

test('declared summary refuses caller selectors and unrelated host identity or credential', async () => fixture(async host => fixture(async other => {
  const connector = createScopedLoopbackSshConnector(options(host));
  try {
    assert.equal((await connector.readFixtureSummary({ ...makeContext(), command: 'uname -a' })).reason, 'invalid');
    assert.equal((await connector.readFixtureSummary({ ...makeContext(), path: '/etc/passwd' })).reason, 'invalid');
    assert.equal(host.status().attempts, 0);
    assert.throws(() => ownedSshHostPort(host, host.credential).spawn(host.identity.hostKey, 'fixture-summary; uname -a'));
  } finally { await connector.close(); }
  for (const overrides of [{ hostKey: other.identity.hostKey }, { credential: other.credential }]) {
    const selected = createScopedLoopbackSshConnector({ ...options(host), ...overrides });
    try { assert.equal((await selected.readFixtureSummary(makeContext())).reason, 'native-failed'); assert.equal(selected.status().retainedResults, 0); }
    finally { await selected.close(); }
  }
})));

test('issued summary cancellation joins raw close and reconnect requires fresh identity and approval', async () => {
  let firstIdentity: string | undefined;
  await fixture(async host => {
    firstIdentity = host.identity.id; const owner = new AbortController();
    const connector = createScopedLoopbackSshConnector({ ...options(host), authorize(request: { expiresAt: number }) {
      return { request, expiresAt: request.expiresAt, signal: owner.signal };
    }, onNative(event: { stage: string }) {
      if (event.stage === 'spawned') { owner.abort(); assert.equal(host.status().nativePending, 1); assert.equal(connector.status().rawPending, 1); }
    } });
    try {
      assert.equal((await connector.readFixtureSummary(makeContext())).reason, 'revoked');
      await connector.drain(); assert.equal(host.status().nativePending, 0); assert.equal(connector.status().retainedResults, 0);
      assert.equal(connector.status().timerArmed, false); assert.equal(connector.status().issued, connector.status().settled);
      assert.equal(connector.status().audit.at(-1)?.operation, 'fixture-summary');
      assert.equal((await connector.readFixtureSummary(makeContext())).reason, 'denied');
    } finally { await connector.close(); }
  });
  await fixture(async host => {
    assert.notEqual(host.identity.id, firstIdentity);
    const denied = createScopedLoopbackSshConnector({ ...options(host), authorize: () => undefined });
    try { assert.equal((await denied.readFixtureSummary(makeContext())).reason, 'denied'); assert.equal(host.status().attempts, 0); }
    finally { await denied.close(); }
    const fresh = createScopedLoopbackSshConnector(options(host));
    try { const work = await fresh.readFixtureSummary(makeContext()); assert.equal(work.ok, true);
      const result = fresh.readResult(work.handle, makeContext()); assert.equal(result.ok, true); assert.equal(result.value.profile, 'loopback-openssh-fixture-summary/1'); }
    finally { await fresh.close(); }
  });
});
