import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { prepareOperatorIdentityLifecycle, createCoordinatorFetcher } from '@101/hub-server';
import type { OperatorConfiguration, OperatorIdentityController } from '@101/hub-server';
import { createAssetReference, processorExtensionManifestSha256, processorExtensionSigningBytes, createProcessorInstallation,
  createOwnerBackupController, createOwnerDataController, createSettingsStore, createTelemetryHistory, verifyProcessorExtensionRelease } from '@101/connect';
import type { ProcessorInstallationStorage, ProcessorInstallationWriteGuard, ProcessorInstallationResult, ProcessorExtensionRelease,
  OwnerDataStorage, OwnerDataResult, OwnerBackupResult } from '@101/connect';
import { createCoordinatorFixtures } from '../../tools/qa-https-coordinator.mjs';
import { createExtensionFilesystemStorage } from '../extension-installation/filesystem-storage.mjs';
import { runExtensionInstallationExample } from '../extension-installation/consumer.mjs';
import { createOwnerDataFilesystemStorage } from '../owner-data/filesystem-storage.mjs';

export const OPERATOR_DRILLS_PROFILE = 'local-operator-recovery-drills/1';
export const OPERATOR_DRILLS_LIMITS = Object.freeze({ concurrentRuns: 1, nativeLifetimeMs: 20000, nativeOwners: 6, clientInstances: 12,
  liveClients: 4, socketAttempts: 128, pendingOperations: 8, operationGrants: 64, checks: 32, events: 12, receiptBytes: 16384, retentionMs: 2000 });
export type OperatorDrillStage = 'owned-state-created' | 'upgrade-complete' | 'rollback-complete' | 'native-started' | 'incident-complete' | 'removed';
export interface OperatorDrillOptions { readonly signal: AbortSignal; readonly onStage?: (stage: OperatorDrillStage) => void | Promise<void> }
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const wall = Date.now.bind(Date), now = performance.now.bind(performance), origin = 'https://operator-drills.example';
let reserved = false;
function active(signal: unknown): signal is AbortSignal { try { return nativeAborted.call(signal) === false; } catch { return false; } }
function need<T>(result: ProcessorInstallationResult<T> | OwnerDataResult<T> | OwnerBackupResult<T>): T {
  if (!result.ok) throw Error('Operator drill approved producer operation failed.'); return result.value;
}
function hash(bytes: string | Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
function optionsSnapshot(input: OperatorDrillOptions): OperatorDrillOptions {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw Error('Operator drill options invalid.');
  const fields = Reflect.ownKeys(input); if (fields.length > 2 || !fields.includes('signal')) throw Error('Operator drill options invalid.');
  const copy: Record<string, unknown> = Object.create(null);
  for (const field of fields) { const property = Object.getOwnPropertyDescriptor(input, field);
    if (typeof field !== 'string' || !['signal','onStage'].includes(field) || !property?.enumerable || !('value' in property)) throw Error('Operator drill options invalid.'); copy[field] = property.value; }
  if (!active(copy.signal) || copy.onStage !== undefined && typeof copy.onStage !== 'function') throw Error('Operator drill options invalid.');
  return Object.freeze(copy) as unknown as OperatorDrillOptions;
}
function configuration(fixture: ReturnType<typeof createCoordinatorFixtures>, removed?: string): OperatorConfiguration {
  return { schemaVersion: 1, profile: 'operator-loopback-startup/1', identity: { serverCertificatePem: fixture.server.certificatePem,
    serverPrivateKeyPem: fixture.server.privateKeyPem, clientCaCertificatePem: fixture.ca,
    enrollments: fixture.clients.slice(0,3).filter(value => value.principalId !== removed).map(({principalId,deviceId,certificatePem}) => ({principalId,deviceId,certificatePem})) },
    origins: [origin], listener: { host: '127.0.0.1', port: 0 }, directory: { resources: [] }, storage: { mode: 'ephemeral', acknowledgeLossOnStop: true },
    relay: { mode: 'disabled' }, quotas: { profile: 'fixed-coordinator-directory/1' } };
}

/** Fixed disposable software runbook. A compatible code rollback never restores
 * stored authority, revoked releases or a deletion floor. All supplied paths,
 * keys, endpoints and factory selectors are rejected by the closed options.
 * Staged/fsynced native bytes are not an accepted installation. The current
 * recovery checkpoint is captured from live deletion, outside archive data.
 * Logical cancellation does not release real pending native/observer work. */
export async function runOperatorDrills(input: OperatorDrillOptions) {
  if (reserved) throw Error('Operator drill already active.'); reserved = true;
  let options: OperatorDrillOptions | undefined, directory: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupPromise: Promise<void> | undefined, cleanupDone = false, nativeDeadline = Infinity, events = 0, issuedSockets = 0, cancelled = false;
  const owner = new AbortController(), scopes = new AsyncLocalStorage<object>(), token = Object.freeze({}), clientsChannel = channel('net.client.socket');
  const sockets = new Map<Socket,Promise<void>>(), pending = new Set<Promise<unknown>>(), fixtures: ReturnType<typeof createCoordinatorFixtures>[] = [];
  const controllers: OperatorIdentityController[] = [], callers: ReturnType<typeof createCoordinatorFetcher>[] = [], retirement = new Set<() => void>();
  const endpoints: string[] = [], checks: string[] = [], operationOwners = new Set<AbortController>();
  const native = <T,>(work: () => T) => scopes.run(token,work);
  function current() { if (!active(owner.signal) || !active(options?.signal) || now() >= nativeDeadline) { cancel(); throw Error('Operator drill retired.'); } }
  const observe = (message: unknown) => {
    if (scopes.getStore() !== token) return;
    const socket = (message as {socket:Socket}).socket;
    const closed = new Promise<void>(resolve => socket.once('close',() => { sockets.delete(socket); resolve(); })); sockets.set(socket,closed);
    if (++issuedSockets > 128 || !active(owner.signal)) { cancel(); socket.destroy(); }
  };
  async function call<T>(work: () => T | Promise<T>): Promise<T> {
    current(); if (pending.size >= 8) throw Error('Operator drill pending capacity.');
    const issued = Promise.resolve().then(() => { current(); return native(work); }); pending.add(issued);
    try { const value = await issued; current(); return value; } finally { pending.delete(issued); }
  }
  function check(condition: unknown, label: string) { current(); if (!condition || checks.length >= 32) throw Error('Operator drill check failed.'); checks.push(label); }
  async function stage(value: OperatorDrillStage, removed = false) {
    if (!removed) current(); if (++events > 12) throw Error('Operator drill event quota.');
    try { await options?.onStage?.(value); } catch { throw Error('Operator drill observer failed.'); } if (!removed) current();
  }
  function freshApproval() { current(); if (operationOwners.size >= 64) throw Error('Operator drill grant capacity.'); const grant = new AbortController(); operationOwners.add(grant); return grant; }
  function cancel() { cancelled = true; owner.abort(); retirement.forEach(close => close()); operationOwners.forEach(value => value.abort()); callers.forEach(value => value.close());
    controllers.forEach(value => { void value.stop().catch(() => {}); }); void cleanup().catch(() => {}); }
  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise; owner.abort(); clearTimeout(timer); retirement.forEach(close => close()); operationOwners.forEach(value => value.abort()); callers.forEach(value => value.close());
    cleanupPromise = (async () => {
      const stopped = await Promise.allSettled(controllers.map(value => value.stop())); await Promise.allSettled([...pending]);
      for (const socket of sockets.keys()) socket.destroy(); await Promise.all([...sockets.values()]);
      if (stopped.some(value => value.status === 'rejected') || sockets.size || pending.size || controllers.some(value => value.snapshot().phase !== 'stopped')) throw Error('Operator drill native cleanup incomplete.');
      clientsChannel.unsubscribe(observe); scopes.disable(); fixtures.forEach(value => value.close());
      if (fixtures.some(value => existsSync(value.directory))) throw Error('Operator drill credential cleanup incomplete.');
      if (directory) { rmSync(directory,{recursive:true}); if (existsSync(directory)) throw Error('Operator drill state cleanup incomplete.'); }
      cleanupDone = true;
    })(); void cleanupPromise.catch(() => {}); return cleanupPromise;
  }
  let upgrade: unknown, rollback: unknown, incident: unknown;
  try {
    options = optionsSnapshot(input); clientsChannel.subscribe(observe); addEvent.call(options.signal,'abort',cancel,{once:true}); current();
    directory = realpathSync(mkdtempSync(join(tmpdir(),'101-operator-drills-state-'))); chmodSync(directory,0o700);
    // Existing fixed synchronous provisioning is separately bounded per OpenSSL
    // operation. No native service ownership begins until it has completed.
    for (let index=0;index<2;index++) {
      current(); const fixture = createCoordinatorFixtures(); fixtures.push(fixture);
      for (const name of ['ca','server','wrong-host','expired-server','host-a','host-b','peer-a','peer-b','other','unknown','expired-client']) {
        const file=join(fixture.directory,name+'.key');chmodSync(file,0o600);const stat=lstatSync(file);
        assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o777)===0o600);
      }
      current();
    }
    nativeDeadline = now()+20000; timer = setTimeout(cancel,20000);
    check(fixtures.length===2,'newly owned fixture private keys are verified native 0600 before any bind');await stage('owned-state-created');
    upgrade = await upgradeDrill(); await stage('upgrade-complete'); rollback = await ownerRecoveryDrill(); await stage('rollback-complete');
    incident = await incidentDrill(); await stage('incident-complete');
  } catch { if (!cancelled) throw Error(options?'Operator drill failed.':'Operator drill options invalid.'); }
  finally {
    if (options) removeEvent.call(options.signal,'abort',cancel); await cleanup();
    try { await stage('removed',true); } finally { if (cleanupDone) reserved=false; }
  }
  const receipt = { profile:OPERATOR_DRILLS_PROFILE,result:cancelled?'cancelled':'pass',checks,upgrade,rollback,incident,
    cleanup:{nativeContexts:0,pendingOperations:0,privateStateRemoved:true,privateCredentialsRemoved:true,ownedTimer:false},
    softwareFailureInjection:true,installedHubClaim:false,physicalQualification:false,productionRolloutQualification:false };
  if (Buffer.byteLength(JSON.stringify(receipt))>16384) throw Error('Operator drill receipt quota.'); return Object.freeze(receipt);

  async function upgradeDrill() {
    const path = join(directory!,'extension'); mkdirSync(path,{mode:0o700});
    const pair = await call(() => crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']));
    const base = JSON.parse(readFileSync(new URL('../external-processor/manifest.json',import.meta.url),'utf8'));
    const sources = ['../external-processor/processor.mjs','../extension-installation/temperature-band-v2.mjs'].map(value => new Uint8Array(readFileSync(new URL(value,import.meta.url))));
    const releases: ProcessorExtensionRelease[] = [];
    for (let index=0;index<2;index++) {
      const source = sources[index]!,reference = await call(() => createAssetReference('example:reviewed-source','blob',source));
      const manifest = {...base,version:index?'2.0.0':'1.0.0',codeSha256:reference.sha256};
      if (!index) check(reference.sha256===base.codeSha256,'actual fixed reviewed v1 source matches its public manifest');
      const unsigned = {schemaVersion:1,profile:'reviewed-processor-extension/1',publisherId:'example:local-publisher',packageId:manifest.id,version:manifest.version,sequence:index+1,
        abi:'101:processor/1',runtimeVersion:'0.1.0',manifest,manifestSha256:await call(()=>processorExtensionManifestSha256(manifest)),source:reference,privileges:['compute-local'],dependencies:[]} as const;
      const signature = Buffer.from(await call(()=>crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,processorExtensionSigningBytes(unsigned)))).toString('hex');
      releases.push({...unsigned,signature});
    }
    writeFileSync(join(path,'provision.json'),JSON.stringify({publisherKey:await call(()=>crypto.subtle.exportKey('jwk',pair.publicKey)),releases}),{mode:0o600});
    const raw = createExtensionFilesystemStorage(join(path,'drill-store')) as ProcessorInstallationStorage & {close():void}; retirement.add(()=>raw.close());
    let partial = false, staged = false, partialOwner: AbortController | undefined, minimumSequence = 1;
    const storage: ProcessorInstallationStorage = {read:key=>raw.read(key),isCurrent:(key,expected)=>raw.isCurrent(key,expected),
      compareAndSwap(key,expected,value,guard) {
        const guarded: ProcessorInstallationWriteGuard = {signal:guard.signal,isCurrent(){
          const allowed=guard.isCurrent(); const files=readdirSync(join(path,'drill-store')).filter(name=>name.endsWith('.pending'));
          if (partial&&files.length) { assert.equal(files.length,1); const bytes=readFileSync(join(path,'drill-store',files[0]!)); assert.ok(bytes.byteLength>0);assert.equal(hash(bytes),hash(value));staged=true;partialOwner!.abort(); }
          const stillApproved=guard.isCurrent();
          return allowed&&stillApproved&&(!partial||active(partialOwner?.signal))&&active(owner.signal)&&active(options!.signal); }};
        return raw.compareAndSwap(key,expected,value,guarded);
      }};
    const store = createProcessorInstallation({ownerId:'local-owner',storage,now:wall,publisherTrust:id=>id==='example:local-publisher'?{key:pair.publicKey,minimumSequence}:undefined,
      authorize(scope){const approval=freshApproval();if(partial&&scope.action==='install')partialOwner=approval;
        return {expiresAt:wall()+60000,signal:approval.signal,isCurrent:()=>active(approval.signal)&&active(owner.signal)&&active(options!.signal)};}}); retirement.add(()=>store.close());
    const first=releases[0]!,second=releases[1]!;need(await call(()=>store.install(first,sources[0]!)));
    assert.ok(await call(()=>verifyProcessorExtensionRelease(second,sources[1]!,pair.publicKey)));
    const firstFactory=(await call(()=>import(`data:text/javascript;base64,${Buffer.from(sources[0]!).toString('base64')}`))).createTemperatureBand;
    const secondFactory=(await call(()=>import(`data:text/javascript;base64,${Buffer.from(sources[1]!).toString('base64')}`))).createTemperatureBand;
    const configuration={onAt:30,offAt:28},fixture=(strict:boolean)=>({configuration,invalidConfiguration:{onAt:'bad',offAt:28},invalidInputs:{temperature:'bad'},
      cases:[{inputs:{temperature:30},...(strict?{}:{outputs:{switch:true}})},{inputs:{temperature:31},...(strict?{outputs:{switch:true}}:{})},{inputs:{temperature:28},outputs:{switch:false}}]});
    let retired=0;
    const activate=(release:ProcessorExtensionRelease,source:Uint8Array,factory:typeof firstFactory,strict:boolean)=>({packageId:release.packageId,version:release.version,codeSha256:release.source.sha256,
      trusted:{manifest:release.manifest,source,factory},fixture:fixture(strict),configuration,retireOwned(){retired++;}});
    const old=need(await call(()=>store.activateReviewed(activate(first,sources[0]!,firstFactory,false))));
    const original=await call(()=>raw.read(store.key));
    // The producer signs only the supported closed profile. Altering its runtime
    // field is an incompatible input, not a newly valid signed release.
    const incompatible={...second,runtimeVersion:'99.0.0'};
    check(!(await call(()=>store.install(incompatible,sources[1]!))).ok&&old.isCurrent()&&await call(()=>raw.read(store.key))===original,
      'tampered producer runtime envelope is rejected without a valid-signature claim and preserves incumbent accepted bytes');
    partial=true;const rejected=await call(()=>store.install(second,sources[1]!));partial=false;
    check(!rejected.ok&&staged&&old.isCurrent()&&await call(()=>raw.read(store.key))===original&&!readdirSync(join(path,'drill-store')).some(name=>name.endsWith('.pending')),
      'actual fsynced candidate is cancelled before atomic acceptance and cleaned');
    need(await call(()=>store.install(second,sources[1]!)));const updated=need(await call(()=>store.activateReviewed(activate(second,sources[1]!,secondFactory,true))));
    check(!old.isCurrent()&&updated.isCurrent(),'compatible update retires the prior reviewed activation');
    const accepted=need(await call(()=>store.rollbackReviewed(activate(first,sources[0]!,firstFactory,false))));
    const selected=need(await call(()=>store.inspect()));
    check(!updated.isCurrent()&&accepted.isCurrent()&&selected.packages[0]!.highestSequence===2&&selected.packages[0]!.selectedVersion==='1.0.0','reviewed code rollback retains highest accepted sequence');
    need(await call(()=>store.revokeRelease(first.packageId,first.version)));
    check(!accepted.isCurrent()&&!(await call(()=>store.rollbackReviewed(activate(first,sources[0]!,firstFactory,false)))).ok,'rollback cannot resurrect a revoked version');
    minimumSequence=2;need(await call(()=>store.revokePublisher(first.publisherId)));
    check(!(await call(()=>store.activateReviewed(activate(second,sources[1]!,secondFactory,true)))).ok&&need(await call(()=>store.inspect())).revokedPublishers.includes(first.publisherId),
      'current publisher revocation and external sequence floor survive rollback');
    store.close();raw.close();
    const restartedRaw=createExtensionFilesystemStorage(join(path,'drill-store')) as ProcessorInstallationStorage & {close():void};
    retirement.add(()=>restartedRaw.close());
    const restarted=createProcessorInstallation({ownerId:'local-owner',storage:restartedRaw,now:wall,
      publisherTrust:id=>id===first.publisherId?{key:pair.publicKey,minimumSequence}:undefined,
      authorize(){const approval=freshApproval();return {expiresAt:wall()+60000,signal:approval.signal,isCurrent:()=>active(approval.signal)&&active(owner.signal)&&active(options!.signal)};}});
    retirement.add(()=>restarted.close());
    const durable=need(await call(()=>restarted.inspect()));
    check(durable.revokedPublishers.includes(first.publisherId)&&durable.packages[0]!.highestSequence===2&&!durable.packages[0]!.active&&
      !(await call(()=>restarted.activateReviewed(activate(second,sources[1]!,secondFactory,true)))).ok,
      'fresh controller retains durable revocation without restored activation authority');
    restarted.close();restartedRaw.close();
    // Existing reviewed caller proves real route-backed effects and queued
    // command retirement. This separate store is a declared software fixture.
    await call(()=>runExtensionInstallationExample(path,'install'));const effects=await call(()=>runExtensionInstallationExample(path,'lifecycle'));
    assert.ok(effects.observedEffects);const observedEffects=effects.observedEffects;
    check(effects.explicitRollback&&effects.revokeAndRemoveFenced&&effects.oldQueuedEffectsCancelled&&observedEffects.length===3,
      'actual existing public route caller blocks revoked queued effects and requires fresh route grants');
    return {tamperedRuntimeEnvelopeRejected:true,unsupportedRuntimeSignatureClaim:false,stagedNativeBytesObserved:staged,stagedUpdateAccepted:false,explicitCompatibleRollback:true,
      highestAcceptedSequence:2,revocationRetained:true,currentExternalFloor:minimumSequence,actualReviewedRouteEffects:observedEffects.length,retiredActivations:retired};
  }

  async function ownerRecoveryDrill() {
    const path=join(directory!,'owner-data');mkdirSync(path,{mode:0o700});
    const storage=createOwnerDataFilesystemStorage(path) as OwnerDataStorage & {close():void};retirement.add(()=>storage.close());
    const ownerId='operator-drill-owner', request={backupId:'post-deletion',purpose:'operator-reviewed-recovery',destinationId:'local-recovery' as const};
    let ownerGrant=freshApproval(),backupGrant=freshApproval();
    let checkpoint:Readonly<{ownerId:string;epoch:number;dataRevision:number}>=Object.freeze({ownerId,epoch:0,dataRevision:0});
    const allowedFloor=(scope:{ownerId:string;epoch:number;dataRevision:number})=>scope.ownerId===checkpoint.ownerId&&scope.epoch>=checkpoint.epoch&&scope.dataRevision>=checkpoint.dataRevision;
    const backup=createOwnerBackupController({ownerId,storage,trustedNow:wall,availableDevices:()=>[],authorize(scope){
      const captured=backupGrant;return active(captured.signal)&&allowedFloor(scope)&&active(owner.signal)&&active(options!.signal)
        ?{scope,expiresAt:scope.deadline,signal:captured.signal,isCurrent:()=>active(captured.signal)&&allowedFloor(scope)&&active(owner.signal)&&active(options!.signal)}:undefined;}});
    retirement.add(()=>backup.close());
    const data=createOwnerDataController({ownerId,storage:backup.managedStorage,trustedNow:wall,availableDevices:()=>[],authorize(scope){
      const captured=ownerGrant;return active(captured.signal)&&scope.ownerId===ownerId&&active(owner.signal)&&active(options!.signal)
        ?{scope,expiresAt:scope.deadline,signal:captured.signal,isCurrent:()=>active(captured.signal)&&active(owner.signal)&&active(options!.signal)}:undefined;}});
    retirement.add(()=>data.close());
    const ownedHistory:{value?:ReturnType<typeof createTelemetryHistory>}={};
    const ports=need(await call(()=>data.openStores({retireOwned(){ownedHistory.value?.close();}})));retirement.add(()=>ports.close());
    const settings=createSettingsStore({ownerId,storage:ports.settings,availableDevices:()=>[]});
    const choices={preferences:{theme:'dark' as const,handedness:'left' as const,motion:'reduce' as const},profiles:[]};
    check((await call(()=>settings.save(0,choices))).ok,'actual settings producer writes only reviewed preferences');
    const history=createTelemetryHistory({ownerId,storage:ports.telemetry,trustedNow:wall,limits:{retentionMs:2000},authorize:scope=>
      active(ownerGrant.signal)&&active(owner.signal)&&active(options!.signal)?{scope,expiresAt:scope.expiresAt}:undefined});ownedHistory.value=history;retirement.add(()=>history.close());
    const measured=process.memoryUsage().rss,sourceTime={clockId:'owned-node-rss-monotonic',at:now()};
    const capture=await call(()=>history!.requestCapture({resourceId:'owned:rss',schemaVersion:1,fields:['rss'],provenanceFields:[],destinationId:'local-history',purpose:'operator-software-diagnostics',
      expiresAt:wall()+10000,schema:{type:'record',fields:{rss:{type:'scalar',unit:'By',min:0,max:Number.MAX_SAFE_INTEGER}}}}));
    assert.ok(capture.ok);check(history.enqueue(capture.handle,{sourceTime,quality:'observed',values:{rss:measured}}).ok,'actual local RSS producer preserves its own source clock and quality');
    const flushed=await call(()=>history!.flush());check(flushed.ok&&flushed.committed===1,'actual history commits one approved producer record');
    const old=need(await call(()=>backup.backup({...request,backupId:'pre-deletion'})));
    const deletion=need(await call(()=>data.beginDeletion({kinds:['settings'],purpose:'operator-owner-deletion'})));
    const deleted=need(await call(()=>data.resumeDeletionReviewed(deletion.operationId)));check(deleted.state==='completed','owner deletion completes before recovery selection');
    const selected=need(await call(()=>backup.backup(request))),live=need(await call(()=>backup.inspect({purpose:'capture-current-checkpoint',destinationId:'local-recovery'})));
    // Current owner checkpoint is provisioned from this completed live deletion,
    // not decoded from selected archive bytes and never lowered by recovery.
    checkpoint=Object.freeze({ownerId,epoch:live.epoch,dataRevision:live.dataRevision});
    const original=await call(()=>storage.transact(ownerId,current=>({state:current,result:structuredClone(current)})));
    const outer=original as {ownerId:string;epoch:number;dataRevision:number;audit:unknown[];deletion:unknown;managed:{records:{telemetry:unknown;settings?:string}}};
    const audit=JSON.stringify(outer.audit),retainedDeletion=JSON.stringify(outer.deletion);
    check(outer.ownerId===checkpoint.ownerId&&outer.epoch===checkpoint.epoch&&outer.dataRevision===checkpoint.dataRevision&&outer.managed.records.settings===undefined,
      'independent current recovery guard captures owner epoch and post-deletion floor');
    backupGrant.abort();ownerGrant.abort();check(!(await call(()=>backup.readBackup(request))).ok,'revoked backup approval is not restored from durable bytes');
    await call(()=>storage.transact(ownerId,current=>{
      const next=structuredClone(current) as typeof outer;next.managed.records.telemetry={invalidInnerProducer:true};return {state:next,result:undefined};}));
    backupGrant=freshApproval();ownerGrant=freshApproval();
    let priorArchiveRetirements=0;
    const priorArchive=await call(()=>backup.restoreReviewed({...request,backupId:'pre-deletion',expectedSha256:old.reference.sha256,retireOwned(){priorArchiveRetirements++;}}));
    check(!priorArchive.ok&&priorArchive.reason==='not-found'&&priorArchiveRetirements===0&&live.archives.every(value=>value.backupId!=='pre-deletion'),
      'authoritative deletion retires prior archive before damaged-only recovery can select it');
    const recovered=need(await call(()=>backup.restoreReviewed({...request,expectedSha256:selected.reference.sha256,retireOwned(){ports.close();history?.close();}})));
    check(recovered.epoch>checkpoint.epoch,'approved damaged-only recovery advances the actual owner epoch');
    const restored=await call(()=>storage.transact(ownerId,current=>({state:current,result:structuredClone(current)}))) as typeof outer;
    check(restored.ownerId===ownerId&&JSON.stringify(restored.audit)===audit&&JSON.stringify(restored.deletion)===retainedDeletion&&restored.managed.records.settings===undefined,
      'damaged-only restore retains authoritative current audit deletion and owner');
    check(!(await call(()=>settings.save(1,choices))).ok,'old owner port cannot write after revocation and recovery');
    const fresh=need(await call(()=>data.openStores({retireOwned(){history?.close();}})));retirement.add(()=>fresh.close());
    const reader=createTelemetryHistory({ownerId,storage:fresh.telemetry,trustedNow:wall,authorize:()=>undefined});retirement.add(()=>reader.close());
    const page=await call(()=>reader.exportPage());assert.ok(page.ok);const row=page.records[0];assert.ok(row);
    check(row.quality==='observed'&&JSON.stringify(row.sourceTime)===JSON.stringify(sourceTime)&&row.values.rss===measured&&row.expiresAt===selected.expiresAt&&reader.status().captureHandles===0&&reader.status().uploadHandles===0,
      'recovered actual producer preserves source quality and retention without recording authority');
    const recoveredArchive=need(await call(()=>backup.backup(request)));
    check(recoveredArchive.expiresAt===row.expiresAt,'fresh post-recovery archive retains the original producer expiry');
    const remaining=Math.max(0,row.expiresAt-wall()+5);current();await new Promise<void>(resolve=>{
      const wake=()=>{clearTimeout(waitTimer);removeEvent.call(owner.signal,'abort',wake);resolve();};const waitTimer=setTimeout(wake,remaining);
      addEvent.call(owner.signal,'abort',wake,{once:true});if(!active(owner.signal))wake();
    });current();
    const swept=need(await call(()=>backup.sweep({purpose:'operator-original-retention',destinationId:'local-recovery'})));
    const expired=await call(()=>reader.exportPage());assert.ok(expired.ok);
    check(expired.records.length===0&&swept.removed>=1,'original retention expires instead of being extended by rollback');
    return {damagedInnerOnly:true,checkpointFromCurrentOwner:true,checkpointEpoch:checkpoint.epoch,checkpointDataRevision:checkpoint.dataRevision,
      ownerRetained:true,deletionRetained:true,auditRetained:true,staleOwnerPortBlocked:true,sourceClockPreserved:true,qualityPreserved:true,
      retentionUnextended:true,actualExpiryObserved:true,restoredRecordingOrRouteAuthority:false};
  }

  async function incidentDrill() {
    const first=fixtures[0]!,next=fixtures[1]!,initial=configuration(first),narrowed=configuration(first,first.clients[1]!.principalId),replacement=configuration(next);
    const prepared=prepareOperatorIdentityLifecycle(initial);assert.ok(prepared.ok);const lifecycle=prepared.controller;controllers.push(lifecycle);
    const client=(endpoint:string,fixture:typeof first,credentials:typeof first.clients[number])=>{
      current();if(callers.length>=12)throw Error('Operator drill caller capacity.');
      const value=createCoordinatorFetcher({endpoint,origin,caCertificatePem:fixture.ca,certificatePem:credentials.certificatePem,privateKeyPem:credentials.privateKeyPem});callers.push(value);return value;};
    const create=async(value:ReturnType<typeof createCoordinatorFetcher>,endpoint:string,sessionId='OWNED-INCIDENT')=>{
      const response=await call(()=>value.fetch(endpoint+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId})}));
      const body=await call(()=>response.json()) as {hostToken?:string};return {status:response.status,token:body.hostToken};};
    const inspect=(value:ReturnType<typeof createCoordinatorFetcher>,endpoint:string,bearer:string)=>call(()=>value.fetch(endpoint+'/v1/sessions/OWNED-INCIDENT/host/peers',{headers:{Authorization:'Bearer '+bearer}}));
    const a=await call(()=>lifecycle.start());assert.ok(a.ok);endpoints.push(a.endpoint);await stage('native-started');
    const original=client(a.endpoint,first,first.clients[0]!),old=await create(original,a.endpoint);assert.equal(old.status,201);assert.ok(old.token);
    const incompatible=await call(()=>lifecycle.rotate({...narrowed,schemaVersion:99}));
    check(!incompatible.ok&&(await inspect(original,a.endpoint,old.token)).status===200,'incompatible operator candidate preserves actual incumbent session');
    const collision=await call(()=>lifecycle.rotate({...narrowed,listener:{host:'127.0.0.1',port:Number(new URL(a.endpoint).port)}}));
    check(!collision.ok&&(await inspect(original,a.endpoint,old.token)).status===200,'failed actual native candidate bind preserves incumbent authority');
    const b=await call(()=>lifecycle.rotate(narrowed));assert.ok(b.ok);endpoints.push(b.endpoint);original.close();
    const currentClient=client(b.endpoint,first,first.clients[0]!),removed=client(b.endpoint,first,first.clients[1]!);
    check((await inspect(currentClient,b.endpoint,old.token)).status===404,'successful replacement never copies the old bearer');
    const denied=await create(removed,b.endpoint,'DENIED-CREATE'),unaffected=await create(currentClient,b.endpoint,'DENIED-CREATE');removed.close();
    check(denied.status===401&&unaffected.status===201,'removed enrollment cannot mutate the new actual session store');
    const second=await create(currentClient,b.endpoint);assert.equal(second.status,201);assert.ok(second.token);assert.notEqual(second.token,old.token);
    const c=await call(()=>lifecycle.rotate(replacement));assert.ok(c.ok);endpoints.push(c.endpoint);currentClient.close();
    const fresh=client(c.endpoint,next,next.clients[0]!);
    const retiredCode=await call(()=>new Promise<string>((resolveResult,reject)=>{
      const issued=request(c.endpoint+'/v1/health',{agent:false,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',ca:next.ca,cert:first.clients[0]!.certificatePem,
        key:first.clients[0]!.privateKeyPem,headers:{Origin:origin}},response=>{response.resume();reject(Error('Retired client unexpectedly admitted.'));});
      issued.once('error',error=>resolveResult((error as NodeJS.ErrnoException).code??'unavailable'));issued.setTimeout(1500,()=>issued.destroy(Error('Owned retired TLS probe deadline.')));issued.end();}));
    check(retiredCode==='ECONNRESET'||/^ERR_SSL_.*ALERT/.test(retiredCode),'actual new CA rejects retired TLS identity before HTTP authority');
    check((await inspect(fresh,c.endpoint,second.token)).status===404,'CA replacement rejects old session bearer');
    const third=await create(fresh,c.endpoint);assert.equal(third.status,201);assert.ok(third.token);assert.notEqual(third.token,second.token);
    await call(()=>lifecycle.stop());fresh.close();
    check(!(await call(()=>lifecycle.start())).ok&&!(await call(()=>lifecycle.rotate(replacement))).ok,'terminal revocation cannot restart or implicitly recover authority');
    const recovery=prepareOperatorIdentityLifecycle(replacement);assert.ok(recovery.ok);controllers.push(recovery.controller);
    const d=await call(()=>recovery.controller.start());assert.ok(d.ok);endpoints.push(d.endpoint);
    const recovered=client(d.endpoint,next,next.clients[0]!);check((await inspect(recovered,d.endpoint,third.token)).status===404,'explicit fresh owner cannot revive the retired bearer');
    const fourth=await create(recovered,d.endpoint);assert.equal(fourth.status,201);assert.ok(fourth.token);assert.notEqual(fourth.token,third.token);
    await call(()=>recovery.controller.stop());recovered.close();
    for(const endpoint of endpoints)await call(()=>new Promise<void>((resolveResult,reject)=>{
      const socket=connect({host:'127.0.0.1',port:Number(new URL(endpoint).port)});let refused=false;
      socket.once('connect',()=>{socket.destroy();reject(Error('Owned operator listener still active.'));});
      socket.once('error',(error:NodeJS.ErrnoException)=>{refused=error.code==='ECONNREFUSED';if(!refused)reject(Error('Owned listener refusal unavailable.'));});
      socket.once('close',()=>{if(refused)resolveResult();});socket.setTimeout(1000,()=>socket.destroy(Error('Owned closure probe deadline.')));
    }));
    check(endpoints.length===4&&controllers.every(value=>value.snapshot().phase==='stopped'),'all four native listeners are independently refused after actual teardown');
    return {actualNativeOwners:4,incompatibleCandidatePreservedIncumbent:true,partialNativeBindPreservedIncumbent:true,removedEnrollmentStatus:401,
      newSessionAfterDeniedMutation:201,oldBearerStatuses:[404,404,404],retiredNativeTlsRejected:true,terminalRevocation:true,freshRecovery:true,
      oldAuthorityCopied:false,closedListenerProbes:4};
  }
}
