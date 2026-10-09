/** Selected MTU23 collector grammar; encoded values are not physiology accuracy claims. */
export type HeartRateDecodeResult = Readonly<{kind:'measurement';heartRateBpm:number;heartRateFormat:'uint8'|'uint16';contactSupported:boolean;contact:'unsupported'|'detected'|'not-detected';energyCount:number|null;rrIntervalTicks:readonly number[]}>|Readonly<{kind:'invalid';reason:'type'|'length'|'truncated'|'trailing'|'rr-layout'}>;
const lengthGet=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!;
const invalid=(reason:'type'|'length'|'truncated'|'trailing'|'rr-layout'):HeartRateDecodeResult=>Object.freeze({kind:'invalid',reason});
export function decodeHeartRateMeasurement(input:unknown):HeartRateDecodeResult{
 let bytes:Uint8Array;
 try{if(!(input instanceof Uint8Array))return invalid('type');const length=Reflect.apply(lengthGet,input,[]) as number;if(length<2||length>20)return invalid('length');bytes=new Uint8Array(length);Uint8Array.prototype.set.call(bytes,input);}catch{return invalid('type');}
 const flags=bytes[0]!,wide=(flags&1)!==0;let offset=wide?3:2;if(bytes.length<offset)return invalid('truncated');
 const heartRateBpm=wide?bytes[1]!|(bytes[2]!<<8):bytes[1]!;let energyCount:number|null=null;
 if(flags&8){if(bytes.length<offset+2)return invalid('truncated');energyCount=bytes[offset]!|(bytes[offset+1]!<<8);offset+=2;}
 const rrIntervalTicks:number[]=[];
 if(flags&16){if(bytes.length-offset<2||(bytes.length-offset)%2!==0)return invalid('rr-layout');for(;offset<bytes.length;offset+=2)rrIntervalTicks.push(bytes[offset]!|(bytes[offset+1]!<<8));}
 else if(offset!==bytes.length)return invalid('trailing');
 const contactSupported=(flags&4)!==0;
 return Object.freeze({kind:'measurement',heartRateBpm,heartRateFormat:wide?'uint16':'uint8',contactSupported,contact:!contactSupported?'unsupported':flags&2?'detected':'not-detected',energyCount,rrIntervalTicks:Object.freeze(rrIntervalTicks)});
}
