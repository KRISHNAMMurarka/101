import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Nec32IrReceiveProvider } from './nec32-ir-receive-gateway.ts';
import type { Nec32IrEmitterProvider } from './nec32-ir-emitter-gateway.ts';

const rxProfile = 'app:nec-inverse-byte-demodulated-nominal/1' as const;
const txProfile = 'app:nec-inverse-byte-command-one-shot/1' as const;
const scope = { principalId: 'owner', applicationId: 'learning-tests', sessionId: 'one' };
function packets(address = 0x12, command = 0x7e) {
  const out = [0x01000000 | 9000, 4500];
  for (const byte of [address, address ^ 255, command, command ^ 255]) {
    for (let bit = 0; bit < 8; bit++) out.push(0x01000000 | 560, (byte >>> bit) & 1 ? 1690 : 565);
  }
  return [...out, 0x01000000 | 560, 0x03000000 | 20000];
}
function providers() {
  const counts = { rxOpen: 0, capture: 0, txOpen: 0, transmit: 0, review: 0 };
  const envelopes: Uint8Array[] = [];
  const rx: Nec32IrReceiveProvider = { supported: true, mode: 'LIRC_MODE_MODE2', resolutionMicros: 1,
    open() { counts.rxOpen++; return 'ready'; }, capture() { counts.capture++; return packets(); },
    stop() {}, close() {}, whenSettled() { return Promise.resolve(); } };
  const tx: Nec32IrEmitterProvider = { supported: true, carrierRanges: [{ minHz: 38000, maxHz: 38000 }],
    open() { counts.txOpen++; return 'ready'; }, transmit(envelope) { counts.transmit++; envelopes.push(envelope.slice()); return 'completed'; },
    stop() {}, close() {}, whenSettled() { return Promise.resolve(); } };
  return { rx, tx, counts, envelopes };
}

import { createNec32IrLearningSession } from './nec32-ir-learning.ts';
import type { LearningOptions } from './nec32-ir-learning.ts';

function setup(change: Partial<LearningOptions> = {}) {
  const p = providers(), owner = new AbortController(), control = new AbortController(), captureGrant = new AbortController();
  const reviewGrant = new AbortController(), activation = new AbortController(), emission = new AbortController();
  const options: LearningOptions = { mode: 'software-learning', ownerSignal: owner.signal, scope,
    selectedReceiver: { id: 'rx', profileId: rxProfile }, selectedEmitter: { id: 'tx', profileId: txProfile },
    receiveProvider: p.rx, emitterProvider: p.tx,
    authorizeReceiver: request => ({ request, signal: control.signal, expiresAt: request.deadline }),
    authorizeCapture: request => ({ request, signal: captureGrant.signal, expiresAt: request.deadline }),
    authorizeReview: request => { p.counts.review++; return { request, signal: reviewGrant.signal, expiresAt: request.deadline }; },
    authorizeEmitter: request => ({ request, signal: activation.signal, expiresAt: request.deadline }),
    authorizeEmission: request => ({ request, signal: emission.signal, expiresAt: request.deadline }),
    authorizePublic: () => ({ expiresAt: performance.now() + 500, maxAgeMs: 500 }), ...change };
  return { ...p, owner, control, captureGrant, reviewGrant, activation, emission, options };
}
const captureRequest = (retainMs = 60000) => ({ operationId: 'capture', purpose: 'capture for review',
  signal: new AbortController().signal, deadline: performance.now() + 450, retainMs });
const reviewRequest = () => ({ purpose: 'owner review', signal: new AbortController().signal, deadline: performance.now() + 400 });
const emitRequest = () => ({ operationId: '1', purpose: 'independent emission', signal: new AbortController().signal, deadline: performance.now() + 450 });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function held<T>() { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; }

test('software mode rejects before touching a provider accessor', () => {
  const x = setup(); let reads = 0;
  const invalid = { ...x.options, mode: 'native-ir' };
  Object.defineProperty(invalid, 'receiveProvider', { enumerable: true, get() { reads++; throw Error('provider touched'); } });
  assert.throws(() => createNec32IrLearningSession(invalid as unknown as LearningOptions), /software-learning/);
  assert.equal(reads, 0); assert.equal(x.counts.rxOpen, 0);
});
test('unreviewed genuine alternate-pair draft cannot enter emission configuration', async () => {
  const x = setup(), session = createNec32IrLearningSession(x.options);
  try {
    const captured = await session.captureForReview(captureRequest()); assert.ok(captured.ok, JSON.stringify(captured)); if (!captured.ok) return;
    assert.deepEqual({ address: captured.value.receipt.address, command: captured.value.receipt.command }, { address: 0x12, command: 0x7e });
    assert.deepEqual(Object.keys(captured.value.draft), []);
    assert.equal(captured.value.receipt.canonicalRepresentation, 'reconstructed-selected-nominal');
    assert.equal(captured.value.receipt.receivedCarrier, 'unknown');
    assert.equal((await session.emitOnce(captured.value.draft as unknown as import('./nec32-ir-learning.ts').ReviewHandle, emitRequest())).ok, false);
    assert.equal(session.status().emitterConfigurations, 0); assert.equal(x.counts.txOpen, 0); assert.equal(x.counts.transmit, 0);
  } finally { await session.close(); }
});
test('fresh original-request review learns alternate pair and independent public/private emission dispatches once', async () => {
  const x = setup(), session = createNec32IrLearningSession(x.options);
  try {
    const c = await session.captureForReview(captureRequest()); assert.ok(c.ok); if (!c.ok) return;
    const r = await session.review(c.value.draft, reviewRequest()); assert.ok(r.ok, JSON.stringify(r)); if (!r.ok) return;
    assert.deepEqual(r.value.receipt.codebook, [{ codeId: 'learned-capture', address: 0x12, command: 0x7e }]);
    assert.equal(x.counts.txOpen, 0); assert.equal(x.counts.transmit, 0);
    const e = await session.emitOnce(r.value.review, emitRequest()); assert.ok(e.ok, JSON.stringify({e,status:session.status()}));
    assert.deepEqual(Array.from(x.envelopes[0].subarray(8, 12)), [0x12, 0xed, 0x7e, 0x81]);
    assert.equal(x.counts.transmit, 1); assert.notEqual(c.value.receipt.demodulatedSha256, r.value.receipt.envelopeSha256);
    assert.equal((await session.emitOnce(r.value.review, emitRequest())).ok, false); assert.equal(x.counts.transmit, 1);
    assert.equal(session.status().emissionAttempts, 1); assert.equal(session.status().rawPending, 0);
  } finally { await session.close(); }
});
test('review rejects copied original requests and burns its one attempt', async () => {
  const x = setup(); x.options.authorizeReview = request => ({ request: { ...request }, signal: x.reviewGrant.signal, expiresAt: request.deadline });
  const session = createNec32IrLearningSession(x.options);
  try { const c = await session.captureForReview(captureRequest()); assert.ok(c.ok); if (!c.ok) return;
    assert.equal((await session.review(c.value.draft, reviewRequest())).ok, false);
    assert.equal((await session.review(c.value.draft, reviewRequest())).ok, false);
    assert.equal(session.status().reviewAttempts, 1); assert.equal(session.status().emitterConfigurations, 0); assert.equal(x.counts.transmit, 0);
  } finally { await session.close(); }
});
for (const deny of ['review', 'activation', 'emission', 'invoke'] as const) {
  test('independent ' + deny + ' denial prevents transmit', async () => {
    const x = setup();
    if (deny === 'review') x.options.authorizeReview = () => undefined;
    if (deny === 'activation') x.options.authorizeEmitter = () => undefined;
    if (deny === 'emission') x.options.authorizeEmission = () => undefined;
    if (deny === 'invoke') x.options.authorizePublic = request => request.sinkOperation === 'invoke' ? undefined : { expiresAt: performance.now() + 500, maxAgeMs: 500 };
    const session = createNec32IrLearningSession(x.options);
    try { const c = await session.captureForReview(captureRequest()); assert.ok(c.ok); if (!c.ok) return;
      const r = await session.review(c.value.draft, reviewRequest());
      if (deny === 'review') assert.equal(r.ok, false);
      else { assert.ok(r.ok); if (r.ok) assert.equal((await session.emitOnce(r.value.review, emitRequest())).ok, false); }
      assert.equal(x.counts.transmit, 0);
    } finally { await session.close(); }
  });
}
test('inert draft survives original capture withdrawal but requested retention expires without renewing capture', async () => {
  const x = setup(), session = createNec32IrLearningSession(x.options);
  try { const c = await session.captureForReview(captureRequest(30)); assert.ok(c.ok); if (!c.ok) return;
    x.captureGrant.abort(); assert.equal(session.status().drafts, 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal((await session.review(c.value.draft, reviewRequest())).ok, false); assert.equal(x.counts.review, 0);
    assert.equal(x.counts.capture, 1); assert.equal(session.status().drafts, 0);
  } finally { await session.close(); }
});
test('foreign and copied handles cannot be reviewed', async () => {
  const x = setup(), y = setup(), a = createNec32IrLearningSession(x.options), b = createNec32IrLearningSession(y.options);
  try { const c = await a.captureForReview(captureRequest()); assert.ok(c.ok); if (!c.ok) return;
    assert.equal((await b.review(c.value.draft, reviewRequest())).ok, false);
    assert.equal((await a.review({ ...c.value.draft }, reviewRequest())).ok, false);
    assert.equal(x.counts.review, 0); assert.equal(y.counts.review, 0);
  } finally { await Promise.all([a.close(), b.close()]); }
});
test('held actual receiver settlement retains genuine apply and shared close through stop reentry', async () => {
  const x = setup(), raw = held<void>(); let nested: Promise<void> | undefined; let draftsAtStop = -1;
  x.rx.close = () => raw.promise; x.rx.whenSettled = () => raw.promise; x.rx.stop = () => { if (draftsAtStop === -1) draftsAtStop = session.status().drafts; nested = session.close(); };
  const session = createNec32IrLearningSession(x.options);
  const capture = session.captureForReview(captureRequest());
  for (let i = 0; i < 30 && !nested; i++) await turn();
  assert.equal(draftsAtStop, 1); assert.equal(session.status().drafts, 0);
  const closing = session.close(); assert.equal(session.close(), closing); let done = false; void closing.then(() => { done = true; });
  await turn(); assert.equal(done, false); assert.ok(session.status().rawPending > 0);
  raw.release(); await Promise.all([capture, closing, nested]); assert.equal(session.status().rawPending, 0);
});
test('held transmit and provider settlement stay owned after owner retirement until actual release', async () => {
  const x = setup(), transmit = held<'completed'>(), raw = held<void>();
  x.tx.transmit = envelope => { x.counts.transmit++; x.envelopes.push(envelope.slice()); return transmit.promise; };
  x.tx.close = () => raw.promise; x.tx.whenSettled = () => raw.promise;
  const session = createNec32IrLearningSession(x.options);
  const c = await session.captureForReview(captureRequest()); assert.ok(c.ok); if (!c.ok) return;
  const r = await session.review(c.value.draft, reviewRequest()); assert.ok(r.ok); if (!r.ok) return;
  const operation = session.emitOnce(r.value.review, emitRequest());
  for (let i = 0; i < 30 && x.counts.transmit === 0; i++) await turn(); assert.equal(x.counts.transmit, 1);
  x.owner.abort(); const closing = session.close(); let done = false; void closing.then(() => { done = true; });
  await turn(); assert.equal(done, false); assert.ok(session.status().rawPending > 0);
  transmit.release('completed'); await turn(); assert.equal(done, false); raw.release();
  assert.equal((await operation).ok, false); await closing; assert.equal(session.status().rawPending, 0);
});

for (const deny of ['receiver', 'capture', 'read'] as const) {
  test('independent ' + deny + ' denial burns capture without minting a draft', async () => {
    const x = setup();
    if (deny === 'receiver') x.options.authorizeReceiver = () => undefined;
    if (deny === 'capture') x.options.authorizeCapture = () => undefined;
    if (deny === 'read') x.options.authorizePublic = () => undefined;
    const session = createNec32IrLearningSession(x.options);
    try { assert.equal((await session.captureForReview(captureRequest())).ok, false);
      assert.equal((await session.captureForReview(captureRequest())).ok, false);
      assert.equal(session.status().captureAttempts, 1); assert.equal(session.status().draftAttempts, 1);
      assert.equal(session.status().drafts, 0); assert.equal(x.counts.review, 0); assert.equal(x.counts.transmit, 0);
      if (deny === 'receiver') assert.equal(x.counts.rxOpen, 0);
      if (deny === 'capture') assert.equal(x.counts.capture, 0);
    } finally { await session.close(); }
  });
}
for (const badGrant of ['alias-owner', 'alias-caller', 'expired', 'extended', 'accessor', 'extra', 'throw', 'reentrant-close'] as const) {
  test('fresh review rejects ' + badGrant + ' before configuration', async () => {
    const x = setup(); let caller: AbortSignal; const reviewError = Error('review denial throw');
    x.options.authorizeReview = request => {
      x.counts.review++;
      if (badGrant === 'throw') throw reviewError;
      if (badGrant === 'reentrant-close') void session.close();
      const g = { request, signal: badGrant === 'alias-owner' ? x.owner.signal : badGrant === 'alias-caller' ? caller : x.reviewGrant.signal,
        expiresAt: badGrant === 'expired' ? performance.now() - 1 : badGrant === 'extended' ? request.deadline + 1 : request.deadline };
      if (badGrant === 'accessor') Object.defineProperty(g, 'request', { enumerable: true, get() { throw Error('getter must stay inert'); } });
      return badGrant === 'extra' ? { ...g, arbitrary: true } : g;
    };
    const session = createNec32IrLearningSession(x.options);
    try { const c = await session.captureForReview(captureRequest()); assert.ok(c.ok); if (!c.ok) return;
      const request = reviewRequest(); caller = request.signal;
      assert.equal((await session.review(c.value.draft, request)).ok, false);
      assert.equal(session.status().emitterConfigurations, 0); assert.equal(x.counts.txOpen, 0); assert.equal(x.counts.transmit, 0);
      assert.equal((await session.review(c.value.draft, reviewRequest())).ok, false); assert.equal(x.counts.review, 1);
    } finally { if (badGrant === 'throw') await assert.rejects(session.close(), error => error instanceof AggregateError && error.errors.includes(reviewError)); else await session.close(); }
  });
}
for (const revoke of ['caller', 'grant', 'owner'] as const) {
  test('review ' + revoke + ' withdrawal removes emission admission', async () => {
    const x = setup(), caller = new AbortController(), session = createNec32IrLearningSession(x.options);
    try { const c = await session.captureForReview(captureRequest()); assert.ok(c.ok); if (!c.ok) return;
      const r = await session.review(c.value.draft, { ...reviewRequest(), signal: caller.signal }); assert.ok(r.ok); if (!r.ok) return;
      (revoke === 'caller' ? caller : revoke === 'grant' ? x.reviewGrant : x.owner).abort();
      assert.equal((await session.emitOnce(r.value.review, emitRequest())).ok, false);
      assert.equal(x.counts.txOpen, 0); assert.equal(x.counts.transmit, 0); assert.equal(session.status().reviews, 0);
    } finally { await session.close(); }
  });
}
for (const malformed of ['deadline', 'signal', 'retention', 'extra', 'accessor'] as const) {
  test('invalid capture ' + malformed + ' burns quota before provider callout', async () => {
    const x = setup(), session = createNec32IrLearningSession(x.options), request = captureRequest();
    if (malformed === 'deadline') request.deadline = performance.now() + 501;
    if (malformed === 'signal') request.signal = x.owner.signal;
    if (malformed === 'retention') request.retainMs = 1.5;
    if (malformed === 'extra') Object.assign(request, { arbitrary: true });
    if (malformed === 'accessor') Object.defineProperty(request, 'purpose', { enumerable: true, get() { throw Error('request getter'); } });
    try { assert.equal((await session.captureForReview(request)).ok, false); assert.equal(x.counts.rxOpen, 0);
      assert.equal((await session.captureForReview(captureRequest())).ok, false); assert.equal(session.status().captureAttempts, 1);
    } finally { await session.close(); }
  });
}
test('capture withdrawal inside public authorization prevents sealing', async () => {
  const x = setup(); x.options.authorizePublic = () => { x.captureGrant.abort(); return { expiresAt: performance.now() + 400, maxAgeMs: 400 }; };
  const session = createNec32IrLearningSession(x.options);
  try { assert.equal((await session.captureForReview(captureRequest())).ok, false); assert.equal(session.status().drafts, 0); assert.equal(x.counts.review, 0); }
  finally { await session.close(); }
});
test('deadline crossing in receiver authorization cannot issue provider open', async () => {
  const x = setup(); x.options.authorizeReceiver = request => { while (performance.now() < request.deadline + 1) { /* Deliberate bounded fixture crossing. */ }
    return { request, signal: x.control.signal, expiresAt: request.deadline }; };
  const session = createNec32IrLearningSession(x.options);
  try { assert.equal((await session.captureForReview({ ...captureRequest(), deadline: performance.now() + 5 })).ok, false); assert.equal(x.counts.rxOpen, 0); }
  finally { await session.close(); }
});
for (const classification of ['repeat', 'extended', 'inverse', 'overflow', 'partial'] as const) {
  test('faithful ' + classification + ' capture cannot mint a draft', async () => {
    const x = setup(); x.rx.capture = () => {
      if (classification === 'repeat') return [0x01000000 | 9000, 2250, 0x01000000 | 560, 0x03000000 | 20000];
      if (classification === 'overflow') return [0x04000001];
      if (classification === 'partial') return packets().slice(0, 20);
      const data = packets(); const space = classification === 'extended' ? 19 : 51;
      data[space] = data[space] === 565 ? 1690 : 565; return data;
    };
    const session = createNec32IrLearningSession(x.options);
    try { assert.equal((await session.captureForReview(captureRequest())).ok, false); assert.equal(session.status().drafts, 0); assert.equal(x.counts.review, 0); }
    finally { await session.close(); }
  });
}
test('issued transmit error remains uncertain and cannot be retried', async () => {
  const x = setup(); x.tx.transmit = () => { x.counts.transmit++; throw Error('issued native-like provider failure'); };
  const session = createNec32IrLearningSession(x.options);
  try { const c = await session.captureForReview(captureRequest()); assert.ok(c.ok); if (!c.ok) return;
    const r = await session.review(c.value.draft, reviewRequest()); assert.ok(r.ok); if (!r.ok) return;
    const emitted = await session.emitOnce(r.value.review, emitRequest()); assert.equal(emitted.ok, false);
    if (!emitted.ok) { assert.equal(emitted.issued, true); assert.equal(emitted.emission, 'uncertain'); }
    assert.equal((await session.emitOnce(r.value.review, emitRequest())).ok, false); assert.equal(x.counts.transmit, 1);
  } finally { await session.close(); }
});
test('throwing provider cleanup retains faults while held actual settlement stays owned', async () => {
  const x = setup(), raw = held<void>(); x.rx.stop = () => { throw Error('stop failure'); }; x.rx.close = () => { throw Error('close failure'); }; x.rx.whenSettled = () => raw.promise;
  const session = createNec32IrLearningSession(x.options), capturing = session.captureForReview(captureRequest());
  for (let i = 0; i < 30 && session.status().drafts === 0; i++) await turn();
  assert.equal(session.status().drafts, 1); const closing = session.close(); let done = false; void closing.then(() => { done = true; }, () => { done = true; });
  await turn(); assert.equal(done, false); assert.ok(session.status().rawPending > 0); raw.release();
  const joins = await Promise.allSettled([capturing, closing]); assert.equal(joins[1].status, 'rejected');
  if (joins[1].status === 'rejected') assert.ok(joins[1].reason instanceof AggregateError); assert.equal(session.status().rawPending, 0);
  assert.ok(session.status().failures.some(f => f.message === 'stop failure')); assert.ok(session.status().failures.some(f => f.message === 'close failure'));
});

test('passive observer retains exact actual apply and shared Connection Promise identities', async () => {
  const x = setup(), routes: { kind: string; connection: import('@101/connect').Connection; actual: Promise<void> }[] = [], applies: Promise<void>[] = [];
  const privateReturns: Promise<unknown>[] = [];
  const session = createNec32IrLearningSession(x.options, {
    onOwnedRoute(connection, kind, actual) { assert.equal(connection.status().state, 'idle'); assert.equal(connection.whenSettled!(), actual); routes.push({ kind, connection, actual }); },
    onOwnedApply(actual, connection, kind) { assert.equal(routes.find(r => r.kind === kind)?.connection, connection); applies.push(actual); },
    onOwnedPrivate(actual) { privateReturns.push(actual); },
  });
  try { const c = await session.captureForReview(captureRequest()); assert.ok(c.ok); if (!c.ok) return;
    const r = await session.review(c.value.draft, reviewRequest()); assert.ok(r.ok); if (!r.ok) return;
    assert.ok((await session.emitOnce(r.value.review, emitRequest())).ok);
    assert.equal(applies.length, 2); assert.equal(routes.length, 2);
    await Promise.all([...applies, ...routes.map(r => r.actual), ...privateReturns]);
    assert.ok(session.status().publicRoutes.every(r => r.actualApplyJoined && r.actualApplySettled && r.actualConnectionSettled && r.sameConnectionSettlement));
  } finally { await session.close(); }
});
for (const callout of ['route-throw', 'route-close', 'apply-throw', 'apply-close', 'private-throw', 'private-close'] as const) {
  test('ownership ' + callout + ' cannot mint a draft and preserves issued joins', async () => {
    const x = setup();
    const actuals: Promise<unknown>[] = [];
    const observerError = Error('observer deliberate throw');
    const action = () => { if (callout.endsWith('throw')) throw observerError; void session.close(); };
    const session = createNec32IrLearningSession(x.options, {
      onOwnedRoute(connection, kind, actual) { actuals.push(actual); if (kind === 'read' && callout.startsWith('route')) action(); assert.equal(connection.whenSettled!(), actual); },
      onOwnedApply(actual) { actuals.push(actual); if (callout.startsWith('apply')) action(); },
      onOwnedPrivate(actual, stage) { actuals.push(actual); if (stage === 'receiver-start' && callout.startsWith('private')) action(); },
    });
    try { assert.equal((await session.captureForReview(captureRequest())).ok, false); assert.equal(session.status().drafts, 0); assert.equal(x.counts.transmit, 0); }
    finally { const [joinedClose] = await Promise.allSettled([session.close()]); await Promise.allSettled(actuals);
      if (callout.endsWith('throw') || callout === 'apply-close') {
        assert.equal(joinedClose.status, 'rejected'); if (joinedClose.status === 'rejected') { assert.ok(joinedClose.reason instanceof AggregateError);
          if (callout.endsWith('throw')) assert.ok(joinedClose.reason.errors.includes(observerError));
          else assert.ok(joinedClose.reason.errors.some((error: Error) => error.message === 'Observer retired session')); }
      } else assert.equal(joinedClose.status, 'fulfilled');
      assert.equal(session.status().rawPending, 0); }
  });
}
test('observer accessor is rejected before receiver authorization or provider effects', () => {
  const x = setup(); const observer = { onOwnedRoute() {}, onOwnedApply() {}, onOwnedPrivate() {} };
  Object.defineProperty(observer, 'onOwnedRoute', { enumerable: true, get() { throw Error('inert observer getter'); } });
  assert.throws(() => createNec32IrLearningSession(x.options, observer), /Invalid ownership observer/); assert.equal(x.counts.rxOpen, 0);
});

test('loss of actual shared Connection settlement capability blocks private receiver start', async () => {
  const x = setup(), actuals: Promise<void>[] = [];
  const session = createNec32IrLearningSession(x.options, {
    onOwnedRoute(connection, kind, actual) { actuals.push(actual); if (kind === 'read') Object.defineProperty(connection, 'whenSettled', { value: undefined, configurable: true }); },
    onOwnedApply() {}, onOwnedPrivate() {},
  });
  try { assert.equal((await session.captureForReview(captureRequest())).ok, false); assert.equal(x.counts.rxOpen, 0); assert.equal(x.counts.capture, 0); }
  finally { await assert.rejects(session.close(), error => error instanceof AggregateError && error.errors.some(reason => reason instanceof TypeError)); await Promise.all(actuals); }
});


test('F1 rejects a seal after original authority expiry on the genuine read path', async () => {
  const x = setup(), source = readFileSync(fileURLToPath(new URL('./nec32-ir-learning.ts', import.meta.url)), 'utf8');
  const sealLine = source.slice(0, source.indexOf('const now = performance.now();')).split('\n').length;
  const originalNow = Object.getOwnPropertyDescriptor(performance, 'now');
  const nativeNow = performance.now;
  const trace: { index: number; armed: boolean; stage: string; time: number }[] = [];
  let clock = 1000, armed = false, crossing = false, originalApply: Promise<void> | undefined, connectionSettlement: Promise<void> | undefined;
  let originalConnection: import('@101/connect').Connection | undefined;
  let receiverRequest: import('./nec32-ir-receive-gateway.ts').ReceiveApprovalRequest | undefined, captureApprovalRequest: typeof receiverRequest;
  let receiverGrant: import('./nec32-ir-receive-gateway.ts').ReceiveGrant | undefined, originalCaptureGrant: typeof receiverGrant;
  let readAuthorization: import('@101/connect').AuthorizationRequest | undefined, originalReadGrant: import('@101/connect').RouteGrant | undefined;
  const privateActuals: Promise<unknown>[] = [];
  let applyOutcome: string | undefined, connectionOutcome: string | undefined, actualCapture: Awaited<ReturnType<ReturnType<typeof createNec32IrLearningSession>['captureForReview']>> | undefined;
  let effectiveExpiry = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value() {
    const stack = new Error().stack ?? '';
    const at = stack.split('\n').find(line => line.includes('nec32-ir-learning.ts:') || line.includes('nec32-ir-receive-gateway.ts:') || line.includes('/device-runtime/src/runtime.ts:'))?.trim() ?? 'test-owned-clock';
    if (armed && at.includes('nec32-ir-learning.ts:' + sealLine + ':')) { assert.equal(crossing, false); crossing = true; clock = effectiveExpiry; }
    trace.push({ index: trace.length, armed, stage: at, time: clock }); return clock;
  } });
  x.options.authorizeReceiver = request => { receiverRequest = request; receiverGrant = Object.freeze({ request, signal: x.control.signal, expiresAt: request.deadline }); return receiverGrant; };
  x.options.authorizeCapture = request => { captureApprovalRequest = request; originalCaptureGrant = Object.freeze({ request, signal: x.captureGrant.signal, expiresAt: request.deadline }); return originalCaptureGrant; };
  x.options.authorizePublic = request => { readAuthorization = request; originalReadGrant = { expiresAt: performance.now() + 500, maxAgeMs: 500 }; return originalReadGrant; };
  const session = createNec32IrLearningSession(x.options, {
    onOwnedRoute(connection, kind, actual) { if (kind === 'read') { originalConnection = connection; connectionSettlement = actual; void actual.then(() => { connectionOutcome = 'fulfilled'; }, () => { connectionOutcome = 'rejected'; }); } },
    onOwnedApply(actual, connection, kind) {
      assert.equal(kind, 'read'); assert.equal(connection, originalConnection); originalApply = actual;
      void actual.then(() => { applyOutcome = 'fulfilled'; }, () => { applyOutcome = 'rejected'; });
      assert.ok(receiverRequest && captureApprovalRequest && receiverGrant && originalCaptureGrant && readAuthorization && originalReadGrant);
      assert.equal(receiverGrant.request, receiverRequest); assert.equal(originalCaptureGrant.request, captureApprovalRequest);
      effectiveExpiry = Math.min(receiverGrant.expiresAt, originalCaptureGrant.expiresAt, caller.deadline, connection.limits()!.expiresAt);
      assert.equal(effectiveExpiry, 1450); armed = true;
    },
    onOwnedPrivate(actual) { privateActuals.push(actual); },
  });
  const caller = captureRequest(); let closing: Promise<void> | undefined;
  try { actualCapture = await session.captureForReview(caller); }
  finally {
    closing = session.close(); await Promise.allSettled([closing, ...(originalApply ? [originalApply] : []), ...(connectionSettlement ? [connectionSettlement] : []), ...privateActuals]);
    if (originalNow) Object.defineProperty(performance, 'now', originalNow); else { Reflect.deleteProperty(performance, 'now'); assert.equal(performance.now, nativeNow); }
  }
  const armedTrace = trace.filter(t => t.armed), firstSeal = armedTrace.findIndex(t => t.stage.includes('nec32-ir-learning.ts:' + sealLine + ':'));
  assert.ok(firstSeal > 0, 'Clock setup must reach real seal sample after initial genuine apply validation');
  const authorityLine = source.slice(0, source.indexOf('const authorityCurrent =')).split('\n').length;
  const applyCheckLine = source.slice(0, source.indexOf('if (!c || !value || !captureCall')).split('\n').length;
  const sourceUrl = new URL('./nec32-ir-learning.ts', import.meta.url).href;
  const sdkClockUrl = new URL('./runtime.ts', import.meta.resolve('@101/device-runtime')).href;
  const sdkClockSource = readFileSync(fileURLToPath(sdkClockUrl), 'utf8');
  const sdkClockMarker = 'this.now = options.now ?? (() => performance.now());';
  const sdkClockAt = sdkClockSource.indexOf(sdkClockMarker);
  assert.ok(sdkClockAt >= 0 && sdkClockSource.indexOf(sdkClockMarker, sdkClockAt + 1) === -1, 'Exactly one runtime default-clock source is required');
  const sdkClockLine = sdkClockSource.slice(0, sdkClockAt).split('\n').length;
  assert.deepEqual(armedTrace.slice(0, firstSeal).map(t => t.stage), [
    'at authorityCurrent (' + sourceUrl + ':' + authorityLine + ':99)', 'at authorityCurrent (' + sourceUrl + ':' + authorityLine + ':99)',
    'at ' + sourceUrl + ':' + applyCheckLine + ':173', 'at EmbeddedRuntime.now (' + sdkClockUrl + ':' + sdkClockLine + ':50)',
  ], 'Clock trace drift is setup failure, never semantic RED credit');
  assert.ok(armedTrace.slice(0, firstSeal).every(t => t.time === 1000)); assert.ok(trace.every((t, i) => i === 0 || t.time >= trace[i - 1].time));
  assert.equal(crossing, true); assert.equal(originalConnection!.whenSettled!(), connectionSettlement); assert.equal(connectionOutcome, 'fulfilled');
  assert.ok(originalApply && actualCapture); assert.equal(session.status().rawPending, 0);
  const evidence = { scenario: 'F1 genuine old-seal authority boundary', sourceSha256: createHash('sha256').update(source).digest('hex'), sealLine,
    originalReceiverRequest: receiverRequest, originalCaptureRequest: captureApprovalRequest, originalPublicAuthorization: readAuthorization,
    originalGrantIdentity: { receiver: receiverGrant!.request === receiverRequest, capture: originalCaptureGrant!.request === captureApprovalRequest },
    originalExpiry: { receiver: receiverGrant!.expiresAt, capture: originalCaptureGrant!.expiresAt, caller: caller.deadline, public: effectiveExpiry },
    actualCapture, trace, arming: { effectiveExpiry, firstSealArmedTraceIndex: firstSeal, initialArmedCalls: armedTrace.slice(0, firstSeal).map(t => t.stage) },
    joins: { applyOutcome, connectionOutcome, actualApplyReturned: !!originalApply, sameConnectionSettlement: originalConnection!.whenSettled!() === connectionSettlement, sharedCloseIdentity: session.close() === closing,
      privateActualReturns: privateActuals.length, allKnownJoined: true, rawPending: session.status().rawPending }, counters: x.counts,
    limits: { actualIRChildren: 0, sourceSDKAndGatewayPath: true, fakeApply: false, fakeSnapshot: false, waveformChange: false, productionClockSeam: false } };
  if (process.env.IR_LEARNING_REGRESSION_RECEIPT) writeFileSync(process.env.IR_LEARNING_REGRESSION_RECEIPT, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  assert.equal(actualCapture.ok, false, 'IR-LEARNING-F1-RED: expired original authority cannot seal a draft');
  assert.equal(x.counts.review, 0); assert.equal(x.counts.txOpen, 0); assert.equal(x.counts.transmit, 0);
});

test('F2 shared close rejects retained original cleanup errors only after all actual joins', async () => {
  const stopCause = Error('F2 nested original stop reason'), closeCause = Error('F2 nested original close reason');
  const x = setup(), raw = held<void>(), stopError = Error('F2 original stop sentinel', { cause: stopCause }), closeError = Error('F2 original close sentinel', { cause: closeCause });
  let originalControlRequest: import('./nec32-ir-receive-gateway.ts').ReceiveApprovalRequest | undefined, originalCaptureRequest: typeof originalControlRequest;
  let originalControlGrant: import('./nec32-ir-receive-gateway.ts').ReceiveGrant | undefined, originalCaptureGrant: typeof originalControlGrant;
  let originalPublicRequest: import('@101/connect').AuthorizationRequest | undefined, originalPublicGrant: import('@101/connect').RouteGrant | undefined;
  x.options.authorizeReceiver = request => { originalControlRequest = request; originalControlGrant = { request, signal: x.control.signal, expiresAt: request.deadline }; return originalControlGrant; };
  x.options.authorizeCapture = request => { originalCaptureRequest = request; originalCaptureGrant = { request, signal: x.captureGrant.signal, expiresAt: request.deadline }; return originalCaptureGrant; };
  x.options.authorizePublic = request => { originalPublicRequest = request; originalPublicGrant = { expiresAt: performance.now() + 500, maxAgeMs: 500 }; return originalPublicGrant; };
  const attempts = { rxStop: 0, rxClose: 0, rxWhenSettled: 0, txStop: 0, txClose: 0, txWhenSettled: 0 };
  x.rx.stop = () => { attempts.rxStop++; throw stopError; };
  x.rx.close = () => { attempts.rxClose++; throw closeError; };
  x.rx.whenSettled = () => { attempts.rxWhenSettled++; return raw.promise; };
  x.tx.stop = () => { attempts.txStop++; }; x.tx.close = () => { attempts.txClose++; }; x.tx.whenSettled = () => { attempts.txWhenSettled++; return Promise.resolve(); };
  const originals: { kind: string; actual: Promise<unknown>; outcome?: string }[] = [];
  let actualApply: Promise<void> | undefined, actualConnection: import('@101/connect').Connection | undefined, actualConnectionReturn: Promise<void> | undefined;
  const observe = (kind: string, actual: Promise<unknown>) => { const record = { kind, actual, outcome: undefined as string | undefined }; originals.push(record);
    void actual.then(() => { record.outcome = 'fulfilled'; }, () => { record.outcome = 'rejected'; }); };
  const session = createNec32IrLearningSession(x.options, {
    onOwnedRoute(connection, kind, actual) { actualConnection = connection; actualConnectionReturn = actual; observe(kind + '-Connection', actual); },
    onOwnedApply(actual, connection) { actualApply = actual; assert.equal(connection, actualConnection); observe('actual-read-apply', actual); },
    onOwnedPrivate(actual, stage) { observe(stage, actual); },
  });
  const originalCallerRequest = captureRequest(), capturing = session.captureForReview(originalCallerRequest);
  for (let i = 0; i < 30 && session.status().drafts === 0; i++) await turn();
  assert.ok(actualApply && actualConnectionReturn && actualConnection); assert.equal(session.status().drafts, 1);
  const closing = session.close(); assert.equal(session.close(), closing);
  let closeOutcome: string | undefined, originalsJoinedAtClose = false;
  void closing.then(() => { closeOutcome = 'fulfilled'; originalsJoinedAtClose = originals.every(r => r.outcome !== undefined); },
    () => { closeOutcome = 'rejected'; originalsJoinedAtClose = originals.every(r => r.outcome !== undefined); });
  await turn(); assert.equal(closeOutcome, undefined); assert.ok(session.status().rawPending > 0);
  assert.equal(originals.find(r => r.kind === 'actual-read-apply')!.outcome, undefined);
  assert.equal(originals.find(r => r.kind === 'read-Connection')!.outcome, undefined);
  raw.release();
  const joins = await Promise.allSettled([capturing, closing, actualApply, actualConnectionReturn, ...originals.map(r => r.actual)]);
  const closeJoin = joins[1]; const error = closeJoin.status === 'rejected' ? closeJoin.reason as AggregateError & { failures: { stage: string; error: unknown }[] } : undefined;
  const evidence = { scenario: 'F2 joined retained cleanup result', sourceSha256: createHash('sha256').update(readFileSync(new URL('./nec32-ir-learning.ts', import.meta.url))).digest('hex'),
    originalRequests: { control: originalControlRequest, capture: originalCaptureRequest, public: originalPublicRequest, callerDeadline: originalCallerRequest.deadline },
    originalGrantIdentity: { control: originalControlGrant!.request === originalControlRequest, capture: originalCaptureGrant!.request === originalCaptureRequest },
    originalBounds: { controlExpiry: originalControlGrant!.expiresAt, captureExpiry: originalCaptureGrant!.expiresAt, publicExpiry: originalPublicGrant!.expiresAt },
    closeOutcome, sharedIdentity: session.close() === closing,
    allKnownOriginalsJoinedBeforeCloseOutcome: originalsJoinedAtClose, joins: joins.map((r, i) => ({ index: i, outcome: r.status,
      ...(r.status === 'rejected' ? { error: String(r.reason?.message ?? r.reason) } : {}) })), originalReturns: originals.map(({ kind, outcome }) => ({ kind, outcome })),
    actualApplyReturned: !!actualApply, sameConnectionSettlement: actualConnection.whenSettled!() === actualConnectionReturn,
    rawPending: session.status().rawPending, attempts, counts: x.counts,
    sentinelIdentity: { errorsContainsOriginalStop: error?.errors.includes(stopError) ?? false, errorsContainsOriginalClose: error?.errors.includes(closeError) ?? false,
      nestedOriginalStop: error?.errors.find(e => e === stopError)?.cause === stopCause, nestedOriginalClose: error?.errors.find(e => e === closeError)?.cause === closeCause,
      stagesContainOriginalStop: error?.failures.some(f => f.stage === 'receive:provider-stop' && f.error === stopError) ?? false,
      stagesContainOriginalClose: error?.failures.some(f => f.stage === 'receive:provider-close' && f.error === closeError) ?? false },
    retainedFailures: session.status().failures, actualIRChildren: 0 };
  if (process.env.IR_LEARNING_REGRESSION_RECEIPT) writeFileSync(process.env.IR_LEARNING_REGRESSION_RECEIPT, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  assert.equal(closeJoin.status, 'rejected', 'IR-LEARNING-F2-RED: shared close must reject retained failures after joins');
  assert.ok(error instanceof AggregateError); assert.ok(error.errors.includes(stopError)); assert.ok(error.errors.includes(closeError)); assert.equal(error.errors.find(e => e === stopError).cause, stopCause); assert.equal(error.errors.find(e => e === closeError).cause, closeCause);
  assert.ok(error.failures.some(f => f.stage === 'receive:provider-stop' && f.error === stopError));
  assert.ok(error.failures.some(f => f.stage === 'receive:provider-close' && f.error === closeError));
  assert.equal(originalsJoinedAtClose, true); assert.equal(session.status().rawPending, 0);
  assert.ok(attempts.rxStop >= 2 && attempts.rxClose >= 2 && attempts.rxWhenSettled >= 4); assert.ok(attempts.txStop >= 1 && attempts.txClose >= 1 && attempts.txWhenSettled >= 2);
});


test('F2 automatic owner retirement observes failure without losing rejected shared close', async () => {
  const x = setup(), originalStop = Error('F2 automatic retirement original stop'); x.rx.stop = () => { throw originalStop; };
  const session = createNec32IrLearningSession(x.options);
  const captured = await session.captureForReview(captureRequest()); assert.ok(captured.ok);
  x.owner.abort(); await turn(); await turn();
  const close = session.close(); assert.equal(session.close(), close);
  await assert.rejects(close, error => error instanceof AggregateError && error.errors.includes(originalStop));
  assert.equal(session.status().rawPending, 0);
});
