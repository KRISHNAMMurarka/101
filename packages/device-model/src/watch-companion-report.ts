import { DeviceValidationError, parseDeviceDescriptor } from './descriptor.ts';
import type { DeviceDescriptor, ValueSchema } from './descriptor.ts';

export const WATCH_COMPANION_REPORT_PROFILE = 'watch-companion-report/1';
export const WATCH_COMPANION_REPORT_LIMITS = Object.freeze({ packetBytes: 53, base64Characters: 72, maxHz: 30,
  inactivityMs: 250, ownerMs: 30000, leaseMs: 1000, lifetimeStarts: 64, enrollments: 2, pendingNativeOperations: 1 });
/** Report validity says the grammar is valid. V1 carries no physical sensor validity or capture timestamp. */
export interface WatchCompanionReport {
 readonly sequence: number; readonly relayEmissionMs: number;
 readonly orientationReported: readonly number[]; readonly accelerationG: readonly number[];
 readonly rotationDegPerSecond: readonly number[]; readonly crownReported: number; readonly tap: boolean;
 readonly physicalValidity: 'unspecified';
}
const intrinsicLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!;
function fail(): never { throw new DeviceValidationError('watch-companion-report'); }
export function decodeWatchCompanionReport(input: unknown): Readonly<WatchCompanionReport> {
 if(!(input instanceof Uint8Array)||intrinsicLength.call(input)!==53) fail();
 const bytes=new Uint8Array(53);Uint8Array.prototype.set.call(bytes,input);
 if(bytes[0]!==0x31||bytes[1]!==1||(bytes[52]!==0&&bytes[52]!==1)) fail();
 const view=new DataView(bytes.buffer);
 function floats(offset:number,count:number):readonly number[] {
  const values=Array.from({length:count},(_,index)=>view.getFloat32(offset+4*index,true));
  if(values.some(value=>!Number.isFinite(value))) fail();return Object.freeze(values);
 }
 const crownReported=view.getFloat32(48,true);if(!Number.isFinite(crownReported)) fail();
 return Object.freeze({sequence:view.getUint16(2,true),relayEmissionMs:view.getUint32(4,true),orientationReported:floats(8,4),
  accelerationG:floats(24,3),rotationDegPerSecond:floats(36,3),crownReported,tap:bytes[52]===1,physicalValidity:'unspecified'});
}
export function watchCompanionReportDevice(id:string,platform:'watchos'|'wearos'):Readonly<DeviceDescriptor> {
 if(platform!=='watchos'&&platform!=='wearos') fail();
 const scalar=(unit:string,min:number,max:number):ValueSchema=>({type:'scalar',unit,min,max});
 const array=(unit:string,count:number):ValueSchema=>({type:'array',minItems:count,maxItems:count,items:scalar(unit,-3.5e38,3.5e38)});
 return parseDeviceDescriptor({schemaVersion:1,id,label:'Watch companion reports',revision:1,
  adapter:{id:'watch:companion-report',version:'1.0.0'},runtime:{platform},
  capabilities:[{id:'report',semantic:'watch:companion-report',schemaVersion:1,kind:'sample',
   permissions:['subscribe'],delivery:{mode:'latest',maxHz:30,maxAgeMs:250},value:{type:'record',fields:{
    sequence:scalar('1',0,65535),relayEmissionMs:scalar('ms',0,4294967295),orientationReported:array('1',4),
    accelerationG:array('g',3),rotationDegPerSecond:array('deg/s',3),crownReported:scalar('1',-3.5e38,3.5e38),
    tap:{type:'boolean'},physicalValidity:{type:'enum',values:['unspecified']}}}}],
  metadata:{profile:WATCH_COMPANION_REPORT_PROFILE,captureTimeKnown:false,physicalValidity:'unspecified',
   timestampMeaning:'Phone receipt of report; relayEmissionMs is watch emission time, not capture time.',
   crownUnitQualified:false,tapDelivery:'Latest report bit; no reliable tap event guarantee.'}});
}
