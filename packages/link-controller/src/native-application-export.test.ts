import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayRecorder } from '../../sdk/src/replay.ts';
import { exportNativeRecording, exportNativeApplicationManifest } from './native-application-export.ts';
test('101 recording export preserves game policy only inside opaque application values', () => {
  const recorder = new ReplayRecorder('example-game', '1', 'fixed');
  recorder.recordFrame({ deviceId: 'keyboard-1', playerId: 'player-1', sequence: 1, timestamp: 2, source: 'keyboard', actions: { jump: true } });
  const original = recorder.snapshot(); const exported = exportNativeRecording(original);
  assert.equal(exported.schema, 2); assert.equal(exported.recordingId, original.seed);
  assert.equal(exported.frames[0]?.value.playerId, 'player-1');
  assert.equal('playerId' in exported.frames[0]!, false); assert.deepEqual(recorder.snapshot(), original);
});
test('native package export retains offline procedural game validation', () => {
  const game = { id:'example',name:'Example',version:'1',renderer:'2d',engine:'^1',players:{min:1,max:4},inputs:['keyboard'],offline:true,procedural:true };
  assert.deepEqual(exportNativeApplicationManifest(game), {id:'example',name:'Example',version:'1',entry:'index.html'});
  assert.throws(() => exportNativeApplicationManifest({...game,offline:false}));
  assert.throws(() => exportNativeApplicationManifest(game,'../outside'));
});
