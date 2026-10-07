import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { runRouteSettlementCaller } from '../examples/runtime-lifecycle/settlement.ts';

test('public caller waits for genuine issued Worker return when cleanup callback throws after posting', { timeout: 5000 }, async () => {
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');let pending=false;
parentPort.on('message',m=>{if(m.kind==='apply'){pending=true;parentPort.postMessage({kind:'held'});}
else if(m.kind==='release')parentPort.postMessage({kind:'release-requested'});
else if(m.kind==='settle'){if(pending)parentPort.postMessage({kind:'returned'});parentPort.close();}});`, { eval: true });
  let resolveRaw!: () => void, rejectHeld!: (error: Error) => void, releaseNotice!: () => void;
  const released = new Promise<void>(resolve => { releaseNotice = resolve; });
  const held = new Promise<void>((_resolve, reject) => { rejectHeld = reject; });
  void held.catch(() => {});
  let rawReturned = false, callerReturned = false, releases = 0;
  const exited = new Promise<number>(resolve => worker.once('exit', resolve));
  worker.on('message', message => {
    if (message.kind === 'held') rejectHeld(new Error('Host held callback failed'));
    if (message.kind === 'release-requested') releaseNotice();
    if (message.kind === 'returned') { rawReturned = true; resolveRaw(); }
  });
  const operation = runRouteSettlementCaller({
    apply(id, value) { const work = new Promise<void>(resolve => { resolveRaw = resolve; }); worker.postMessage({ kind: 'apply', id, value }); return work; },
    held() { return held; },
    release(id, fail) { releases++; worker.postMessage({ kind: 'release', id, fail }); throw new Error('Host release callback failed after posting'); },
  });
  void operation.then(() => { callerReturned = true; }, () => { callerReturned = true; });
  try {
    await released; for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    assert.equal(rawReturned, false, 'Actual Worker return remains held');
    assert.equal(callerReturned, false, 'Caller returned before genuine issued work settled');
    assert.equal(releases, 1);
    worker.postMessage({ kind: 'settle' });
    await assert.rejects(operation, /Host (?:held|release) callback failed/);
    assert.equal(rawReturned, true); assert.equal(await exited, 0);
  } finally {
    worker.postMessage({ kind: 'settle' });
    await operation.catch(() => {});
    await worker.terminate(); await exited; worker.removeAllListeners();
  }
});
