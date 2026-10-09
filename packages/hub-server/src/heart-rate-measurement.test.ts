import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHeartRateMeasurement } from './heart-rate-measurement.ts';

test('selected official producer Flags/optional energy and ignored collector RFU',()=>{
 const decode=(bytes:number[])=>decodeHeartRateMeasurement(Uint8Array.from(bytes));
 assert.deepEqual(decode([14,90,0,0]),{kind:'measurement',heartRateBpm:90,heartRateFormat:'uint8',contactSupported:true,contact:'detected',energyCount:0,rrIntervalTicks:[]});
 assert.deepEqual(decode([14,100,10,0]),{kind:'measurement',heartRateBpm:100,heartRateFormat:'uint8',contactSupported:true,contact:'detected',energyCount:10,rrIntervalTicks:[]});
 assert.deepEqual(decode([0xe6,91]),decode([6,91]));
});
test('complete lengths, uint16 LE, encoded zero/max, RR ticks and immutable view copy',()=>{
 assert.equal(decodeHeartRateMeasurement(Uint8Array.of(0,0)).kind,'measurement');
 const r=decodeHeartRateMeasurement(Uint8Array.of(0x11,0x34,0x12,0,4));
 assert.deepEqual(r,{kind:'measurement',heartRateBpm:4660,heartRateFormat:'uint16',contactSupported:false,contact:'unsupported',energyCount:null,rrIntervalTicks:[1024]});
 assert.ok(Object.isFrozen(r));if(r.kind==='measurement')assert.ok(Object.isFrozen(r.rrIntervalTicks));
 assert.equal(decodeHeartRateMeasurement(Uint8Array.of(1,255,255)).kind,'measurement');
 const bytes=Uint8Array.of(99,0,90,99);assert.equal(decodeHeartRateMeasurement(bytes.subarray(1,3)).kind,'measurement');
 for(const value of [[],[1,0],[8,90,0],[16,90],[16,90,0],[0,90,0],[1,90,0,0],Array(21).fill(0)])assert.equal(decodeHeartRateMeasurement(Uint8Array.from(value)).kind,'invalid');
 for(const value of [[],{},'90',new DataView(new ArrayBuffer(2)),null])assert.equal(decodeHeartRateMeasurement(value).kind,'invalid');
 for(const [flags,length]of [[16,20],[24,20],[17,19],[25,19]])assert.equal(decodeHeartRateMeasurement(new Uint8Array(length).fill(0).map((v,i)=>i===0?flags:v)).kind,'measurement');
 assert.equal(decodeHeartRateMeasurement(Uint8Array.of(2,90)).kind,'measurement');
 assert.equal(decodeHeartRateMeasurement(Uint8Array.of(4,90)).kind,'measurement');
});
