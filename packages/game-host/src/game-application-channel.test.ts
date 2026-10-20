import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeControlApplicationMessage, parseControlApplicationMessage, type ApplicationChannel, type ApplicationMessage, type ApplicationPeer, type ControlApplicationMessage } from '@uynis-connect/connect';
import { createGameApplicationLink } from './game-application-channel.ts';
import { SessionHost } from './game-session.ts';
import type { InputFrame } from '@101/input';
class Channel implements ApplicationChannel {
  receive?: (message: ApplicationMessage) => void;
  lost?: (peer: ApplicationPeer) => void;
  sent: ControlApplicationMessage[]=[];
  peer: ApplicationPeer={peerId:'verified-peer',deviceId:'verified-route',wireDeviceId:'phone',trust:'paired'};
  async connect() {} async close() {}
  send(payload:string|Uint8Array) { if(typeof payload!=='string')return false;this.sent.push(parseControlApplicationMessage(JSON.parse(payload)));return true; }
  subscribe(callback:(message:ApplicationMessage)=>void){this.receive=callback;return()=>{this.receive=undefined;};}
  onPeerLost(callback:(peer:ApplicationPeer)=>void){this.lost=callback;return()=>{this.lost=undefined;};}
  emit(value:ControlApplicationMessage,delivery:'reliable'|'disposable'='reliable'){this.receive?.({payload:encodeControlApplicationMessage(value),delivery,peer:this.peer});}
}
test('generic controller binding preserves trusted player assignment, reconfiguration and peer-loss release',async()=>{
 const channel=new Channel(), frames:InputFrame[]=[], resets:string[]=[];
 const session=new SessionHost({gameId:'first',roles:[{id:'pilot',label:'Pilot',playerId:'owned-player',layout:{layout:[{type:'button',action:'fire',label:'Fire'}]}}],
  transport:createGameApplicationLink(channel),onFrame:frame=>frames.push(frame),onDeviceReset:id=>resets.push(id)});
 try{
  await session.start();
  channel.emit({type:'controls.hello',deviceId:'forged',label:'Bad',capabilities:{touch:true},speakerAudio:'locked'});
  assert.equal(session.session.devices.size,0);
  channel.emit({type:'controls.hello',deviceId:'phone',label:'Phone',capabilities:{touch:true},speakerAudio:'ready'});
  const configured=channel.sent.find(value=>value.type==='controls.configure');assert.ok(configured?.type==='controls.configure');
  assert.equal(JSON.stringify(configured).includes('owned-player'),false);assert.equal(configured.applicationId,'101.game-controller');
  channel.emit({type:'input.snapshot',bindingId:configured.bindingId,source:'touch',sequence:1,timestamp:1,actions:{fire:true}},'disposable');
  assert.equal(frames[0].deviceId,'verified-route');assert.equal(frames[0].playerId,'owned-player');
  session.setGame('second',[{id:'pilot',label:'Pilot',playerId:'second-player',layout:{layout:[{type:'button',action:'fire',label:'Fire'}]}}]);
  const next=channel.sent.filter(value=>value.type==='controls.configure').at(-1);assert.ok(next?.type==='controls.configure');assert.notEqual(next.bindingId,configured.bindingId);
  channel.emit({type:'input.snapshot',bindingId:configured.bindingId,source:'touch',sequence:2,timestamp:2,actions:{fire:true}},'disposable');assert.equal(frames.length,1);
  channel.emit({type:'input.snapshot',bindingId:next.bindingId,source:'touch',sequence:1,timestamp:2,actions:{fire:true}},'disposable');assert.equal(frames[1].playerId,'second-player');
  channel.lost?.(channel.peer);assert.equal(session.session.devices.size,0);assert.ok(resets.includes('verified-route'));
  const stale=channel.receive;await session.stop();stale?.({payload:encodeControlApplicationMessage({type:'controls.hello',deviceId:'phone',label:'Late',capabilities:{touch:true},speakerAudio:'locked'}),delivery:'reliable',peer:channel.peer});
  assert.equal(session.session.devices.size,0);
 }finally{await session.stop();}
});

test('public SDK same-origin controller channel delivers approved generic bindings and clears held input on close', async () => {
  const { createBrowserApplicationChannel, createControllerApplicationChannel } = await import('@uynis-connect/connect');
  const { InputBus } = await import('@101/input');
  const sessionId=`test-${crypto.randomUUID()}`,applicationId='connect.controls.v1';
  const channel=await createBrowserApplicationChannel({sessionId,applicationId});
  const controller=await createControllerApplicationChannel({sessionId,applicationId,device:{deviceId:'phone',label:'Phone',capabilities:{touch:true}}});
  const bus=new InputBus();
  const host=new SessionHost({gameId:'fixture',roles:[{id:'pilot',label:'Pilot',playerId:'player-1',layout:{layout:[{type:'button',action:'fire',label:'Fire'}]}}],
    transport:createGameApplicationLink(channel),onFrame:frame=>bus.accept(frame),onDeviceReset:id=>bus.removeDevice(id)});
  let configuration:Extract<ControlApplicationMessage,{type:'controls.configure'}>|undefined;
  controller.subscribe(event=>{if(typeof event.payload==='string'){const message=parseControlApplicationMessage(event.payload);if(message.type==='controls.configure')configuration=message;}});
  async function until(check:()=>boolean){const end=Date.now()+1500;while(!check()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(check(),'expected bounded channel effect');}
  try{
    await host.start();await controller.connect();
    controller.send(encodeControlApplicationMessage({type:'controls.hello',deviceId:'phone',label:'Phone',capabilities:{touch:true},speakerAudio:'locked'}),{delivery:'reliable'});
    await until(()=>!!configuration);
    controller.send(encodeControlApplicationMessage({type:'input.snapshot',bindingId:configuration!.bindingId,source:'touch',sequence:1,timestamp:1,actions:{fire:true}}),{delivery:'disposable'});
    await until(()=>Boolean(bus.action('fire')));
    assert.equal(bus.action('fire','player-2'),false);
    await controller.close();await until(()=>!bus.action('fire'));
    assert.equal(host.session.devices.size,0);
  }finally{await controller.close();await host.stop();}
});
