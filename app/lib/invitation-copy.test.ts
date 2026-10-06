import assert from 'node:assert/strict';
import test from 'node:test';
import { copyInvitationLink } from './invitation-copy.ts';

function heldWrite() {
  let settle!: () => void;
  const promise = new Promise<void>(resolve => { settle = resolve; });
  return { promise, settle };
}

test('an unavailable native clipboard offers manual copy instead of false success', async () => {
  assert.equal(await copyInvitationLink({url:'http://localhost/controller?session=TEST101',writeText:()=>undefined,isCurrent:()=>true}), 'manual');
});
test('native write rejection offers manual copy without exposing its raw error', async () => {
  assert.equal(await copyInvitationLink({url:'owned-invitation',writeText:()=>Promise.reject(new DOMException('Private native detail', 'NotAllowedError')),isCurrent:()=>true}), 'manual');
});
test('synchronous native access failure also offers manual copy', async () => {
  assert.equal(await copyInvitationLink({url:'owned-invitation',writeText:()=>{throw new Error('Native getter detail');},isCurrent:()=>true}), 'manual');
});
test('successful copying waits for the actual native write to settle', async () => {
  const held=heldWrite();let finished=false;
  const result=copyInvitationLink({url:'owned-invitation',writeText:()=>held.promise,isCurrent:()=>true}).then(value=>{finished=true;return value;});
  await Promise.resolve();assert.equal(finished,false);held.settle();assert.equal(await result,'copied');
});
test('an expired or replaced invitation starts no native write', async () => {
  let writes=0;
  const result=await copyInvitationLink({url:'owned-invitation',writeText:()=>{writes++;return Promise.resolve();},isCurrent:()=>false});
  assert.equal(result,'stopped');assert.equal(writes,0);
});
test('empty invitation starts no native write', async () => {
  let writes=0;
  assert.equal(await copyInvitationLink({url:'',writeText:()=>{writes++;return Promise.resolve();},isCurrent:()=>true}),'stopped');assert.equal(writes,0);
});
test('late actual success after replacement, expiry or unmount cannot restore Copied', async () => {
  const held=heldWrite();let current=true;
  const result=copyInvitationLink({url:'old-invitation',writeText:()=>held.promise,isCurrent:()=>current});
  current=false;held.settle();assert.equal(await result,'stopped');
});
test('late native rejection after withdrawal cannot restore a manual-copy prompt', async () => {
  let reject!: (reason:Error)=>void;let current=true;
  const held=new Promise<void>((_resolve,fail)=>{reject=fail;});
  const result=copyInvitationLink({url:'old-invitation',writeText:()=>held,isCurrent:()=>current});
  current=false;reject(new Error('Native late rejection'));assert.equal(await result,'stopped');
});
test('an unavailable currentness check fails closed before native access', async () => {
  let writes=0;
  assert.equal(await copyInvitationLink({url:'owned-invitation',writeText:()=>{writes++;return Promise.resolve();},isCurrent:()=>{throw Error('Owner clock unavailable');}}),'stopped');assert.equal(writes,0);
});
