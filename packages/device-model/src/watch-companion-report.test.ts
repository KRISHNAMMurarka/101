import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeWatchCompanionReport, watchCompanionReportDevice } from './watch-companion-report.ts';
// Exact output of the unchanged Swift/Kotlin WatchPayload producers, verified by qa-watch-companion.
const HEX = '3101e11087d61200cdcccc3dcdcc4cbe9a99993edf4f6d3f0000003f0000a0bf0000003e0000f142000035c20000004100002a4201';
function packet() { return Uint8Array.from(Buffer.from(HEX, 'hex')); }
test('genuine watch report preserves units and emission time without physical quality claims', () => {
 const report=decodeWatchCompanionReport(packet());
 assert.equal(report.sequence,4321); assert.equal(report.relayEmissionMs,1234567); assert.equal(report.tap,true);
 assert.equal(report.physicalValidity,'unspecified'); assert.deepEqual(report.accelerationG,[0.5,-1.25,0.125]);
 assert.deepEqual(report.rotationDegPerSecond,[120.5,-45.25,8]); assert.equal(report.crownReported,42.5);
 assert.ok(Object.isFrozen(report.orientationReported));
 const descriptor=watchCompanionReportDevice('watch:software','watchos');
 assert.equal(descriptor.capabilities[0]?.semantic,'watch:companion-report');
 assert.deepEqual(descriptor.capabilities[0]?.permissions,['subscribe']);
 assert.equal(descriptor.metadata?.captureTimeKnown,false);
});
test('short, oversized, versioned, nonfinite and reserved-bit reports fail closed', () => {
 for(const size of [0,52,54,4096]) assert.throws(()=>decodeWatchCompanionReport(new Uint8Array(size)));
 for(const [offset,value] of [[0,0],[1,2],[52,2]]) { const bytes=packet(); bytes[offset!]=value!; assert.throws(()=>decodeWatchCompanionReport(bytes)); }
 const bytes=packet();new DataView(bytes.buffer).setFloat32(8,NaN,true);assert.throws(()=>decodeWatchCompanionReport(bytes));
});
test('intrinsic snapshots reject spoofed sizes and ignore shadowed storage/iterators', () => {
 const bytes=packet();Object.defineProperties(bytes,{byteLength:{value:1},length:{value:9999},buffer:{get(){throw Error('getter');}},byteOffset:{value:999}});
 bytes[Symbol.iterator]=()=>{throw Error('iterator');}; assert.equal(decodeWatchCompanionReport(bytes).sequence,4321);
 const oversized=new Uint8Array(54);Object.defineProperty(oversized,'byteLength',{value:53});assert.throws(()=>decodeWatchCompanionReport(oversized));
});
