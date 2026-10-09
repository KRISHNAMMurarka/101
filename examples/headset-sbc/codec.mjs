import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { tmpdir } from 'node:os';
import { resolve, normalize } from 'node:path';

export const ADMISSION_SHA256 = 'd3fc1220726f3c2b7dd6a353e2c365eac09e2a26f2ea4283c6207c02d009cbdf';
export const STDERR_BYTES_MAX = 262144;
export const PROFILE = 'headset-sbc-codec-resource/1';
export const ENCODE_ARGV = Object.freeze(['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','pipe','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:samples_per_frame=128','-map','0:a:0','-frames:a','16','-ac','1','-ar','44100','-c:a','sbc','-q:a','31','-threads','1','-filter_threads','1','-f','sbc','pipe:1']);
export const DECODE_ARGV = Object.freeze(['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','pipe','-threads','1','-f','sbc','-i','pipe:0','-map','0:a:0','-ac','1','-ar','44100','-c:a','pcm_s16le','-threads','1','-filter_threads','1','-f','s16le','pipe:1']);
export const CODEC_ENV = Object.freeze({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC',AV_LOG_FORCE_NOCOLOR:'1',DYLD_PRINT_LIBRARIES:'1'});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const error = code => new Error(code);
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const loadedEnrollments = new WeakSet();
const identityFields = ['dev','ino','size','mtimeNs','ctimeNs','mode'];
function matches(stat, enrolled) { return stat.isFile() && identityFields.every(key => String(stat[key]) === enrolled[key]); }

/** Approval is external root evidence; no caller-selected digest or locally recomputed approval. */
export async function readEnrollment(path) {
  const bytes = await fs.readFile(path);
  if (sha(bytes) !== ADMISSION_SHA256) throw error('external-admission-mismatch');
  const parsed = JSON.parse(bytes);
  if (parsed.profile !== PROFILE || parsed.enrolledNonOSFiles.length !== 20 || parsed.status !== 'root-approved-bounded-offline-software-source-implementation' || parsed.observerRevision !== 3 || parsed.limits.stderrBytesMax !== STDERR_BYTES_MAX) throw error('external-admission-invalid');
  freeze(parsed); loadedEnrollments.add(parsed); return parsed;
}

async function verifyEnrollment(enrollment, fence) {
  for (const [path, expected] of Object.entries(enrollment.stableAncestors)) {
    fence(); const stat = await fs.lstat(path, {bigint:true});
    if (!stat.isDirectory() || String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino || String(stat.mode) !== expected.mode || Number(stat.uid) !== expected.uid) throw error('ancestor-enrollment-mismatch');
    fence(); if (await fs.realpath(path) !== path) throw error('ancestor-enrollment-mismatch');
  }
  for (const item of enrollment.enrolledNonOSFiles) {
    fence();
    if (await fs.realpath(item.path) !== item.path) throw error('canonical-enrollment-mismatch');
    let handle;
    try {
      fence();
      handle = await fs.open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      fence();
      if (!matches(await handle.stat({bigint:true}), item)) throw error('file-enrollment-mismatch');
      fence(); if (sha(await handle.readFile()) !== item.sha256) throw error('file-enrollment-mismatch');
      fence(); if (!matches(await handle.stat({bigint:true}), item)) throw error('file-enrollment-mismatch');
    } finally { if (handle) await handle.close(); }
    fence();
  }
}

/** Strict dyld observation is post-load evidence, not a pre-load sandbox. */
async function verifyLoadedPaths(bytes, enrollment, fence, receipt) {
  const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
  const paths = [], records = receipt.loadedRecords;
  const prior = new Map();
  const lines = text.split('\n');
  let byteOffset = 0;
  for (let index=0; index<lines.length; index++) {
    const line = lines[index], offset = byteOffset;
    byteOffset += Buffer.byteLength(line, 'utf8') + 1;
    // Ordinary codec diagnostics are counted in stderr but are not loader origins.
    if (!/^[ \t]*dyld/.test(line)) continue;
    if (index===lines.length-1) throw error('loaded-record-unterminated');
    const location = {lineNumber:index+1, byteOffset:offset, rawLine:line+'\n'};
    // Exact UUID/path origin and one source-corroborated LF lifecycle production.
    // No trim, CRLF forgiveness, optional UUID or silently skipped dyld record.
    // eslint-disable-next-line no-control-regex -- loader paths must reject control characters.
    const origin = /^dyld\[([1-9]\d*)\]: <([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})> (\/[^\x00-\x1f\x7f]+)$/.exec(line);
    if (origin) {
      const [,pid,rawUuid,path] = origin, uuid = rawUuid.toUpperCase();
      const record = {kind:'origin',pid,uuid,path,...location};
      paths.push(path); records.push(record);
      let leaves = prior.get(pid); if (!leaves) prior.set(pid,leaves=new Map());
      const leaf = path.slice(path.lastIndexOf('/')+1);
      let identities = leaves.get(leaf); if (!identities) leaves.set(leaf,identities=new Map());
      const identity = JSON.stringify([uuid,path]);
      if (!identities.has(identity)) identities.set(identity,record);
      continue;
    }
    // eslint-disable-next-line no-control-regex -- loader leaves must reject control characters.
    const lifecycle = /^dyld\[([1-9]\d*)\]: move loaded to delayed: ([^/\x00-\x1f\x7f]+)$/.exec(line);
    if (!lifecycle) throw error('loaded-record-malformed');
    const [,pid,leaf] = lifecycle, identities = prior.get(pid)?.get(leaf);
    if (!identities?.size) throw error('loaded-lifecycle-origin-missing');
    if (identities.size !== 1) throw error('loaded-lifecycle-origin-ambiguous');
    const matched = identities.values().next().value;
    records.push({kind:'move-loaded-to-delayed',pid,leaf,...location,matchedOrigin:{lineNumber:matched.lineNumber,byteOffset:matched.byteOffset,uuid:matched.uuid,path:matched.path}});
  }
  if (!paths.length) throw error('loaded-closure-missing');
  const known = new Map(enrollment.enrolledNonOSFiles.map(item => [item.path, item]));
  const observed = [];
  for (const path of [...new Set(paths)]) {
    fence(); if (normalize(path) !== path) throw error('loaded-origin-invalid');
    if (enrollment.trustedOSPrefixes.some(prefix => path.startsWith(prefix))) { observed.push({path, trust:'ambient-host-OS'}); continue; }
    const canonical = await fs.realpath(path); const expected = known.get(canonical);
    if (!expected) throw error('unknown-nonOS-origin');
    let handle;
    try {
      fence();
      handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      fence(); if (!matches(await handle.stat({bigint:true}), expected)) throw error('loaded-origin-mismatch');
      fence(); if (sha(await handle.readFile()) !== expected.sha256) throw error('loaded-origin-mismatch');
      fence(); if (!matches(await handle.stat({bigint:true}), expected)) throw error('loaded-origin-mismatch');
    } finally { if (handle) await handle.close(); }
    observed.push({path, canonical, sha256:expected.sha256, trust:'root-enrolled-ambient-nonOS'});
  }
  if (!observed.some(item => item.canonical === enrollment.executablePath)) throw error('loaded-entrypoint-missing');
  return observed;
}

export function createFixedSbcPort(enrollment) {
  if (!loadedEnrollments.has(enrollment)) throw error('unapproved-enrollment-object');
  const pending = new Set(); const receipts = []; let closed = false;
  return Object.freeze({
    issue(request, input) {
      if (closed || pending.size) throw error('codec-port-busy');
      if (!request || types.isProxy(request) || !Object.isFrozen(request) || request.profile !== PROFILE || !['encode-selected-sbc','decode-verified-sbc'].includes(request.action) || request.executablePath !== enrollment.executablePath || request.executableSha256 !== enrollment.executableSha256 || request.encodedBytesMax !== 16384 || request.decodedBytesMax !== 65536 || request.frameCountMax !== 16 || !Number.isFinite(request.deadlineMonoMs) || request.deadlineMonoMs <= performance.now() || request.deadlineMonoMs - performance.now() > 5000) throw error('codec-request-invalid');
      const decode = request.action === 'decode-verified-sbc';
      if (decode ? !types.isUint8Array(input) || types.isProxy(input) || input.byteLength !== 1120 : input !== undefined) throw error('codec-input-invalid');
      const supplied = decode ? Buffer.from(input) : undefined;
      let accept, reject; const output = new Promise((yes,no) => { accept=yes; reject=no; }); output.catch(() => {});
      const state = {retired:false, reason:'', child:undefined, spawned:false, exit:false, close:false, spawnError:false};
      pending.add(state); // before any filesystem, process or callback work
      function terminate(reason) {
        if (!state.retired) { state.retired=true;state.reason=String(reason);reject(error(state.reason)); }
        const child=state.child;
        if (child && state.spawned && !state.exit && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      state.terminate=terminate;
      const fence = () => { if (state.retired || performance.now() >= request.deadlineMonoMs) { terminate(state.reason || 'codec-deadline'); throw error(state.reason); } };
      const timer = setTimeout(() => terminate('codec-deadline'), Math.max(0, request.deadlineMonoMs-performance.now()));
      const settled = (async () => {
        let cwd, cwdIdentity, fail;
        const receipt={profile:PROFILE,action:request.action,argv:decode?DECODE_ARGV:ENCODE_ARGV,environment:CODEC_ENV,executablePath:enrollment.executablePath,executableSha256:enrollment.executableSha256,spawned:false,knownNoProcess:false,exit:null,close:null,stdioClosed:false,loadedOrigins:[],loadedRecords:[],stdoutBytes:0,stderrBytes:0,status:'pending'};
        try {
          await verifyEnrollment(enrollment,fence); fence();
          cwd=await fs.mkdtemp(resolve(tmpdir(),'101-headset-sbc-codec-'));
          // Establish cleanup identity for the issued directory even if retirement occurs while creating it.
          cwdIdentity=await fs.stat(cwd,{bigint:true});
          cwd=await fs.realpath(cwd);
          fence(); await fs.chmod(cwd,0o700);
          fence();
          await verifyEnrollment(enrollment,fence); fence();
          const child=childProcess.spawn(enrollment.executablePath, decode?DECODE_ARGV:ENCODE_ARGV, {cwd,env:CODEC_ENV,shell:false,stdio:[decode?'pipe':'ignore','pipe','pipe']});
          state.child=child;
          // Node dispatches spawn/error/exit/close asynchronously. Attach before yielding.
          const pieces=[], diagnostics=[]; let bytes=0, stderrBytes=0, spawnFailure;
          let terminalResolve;const terminal=new Promise(yes=>{terminalResolve=yes;});
          const streamWaits=[]; const recordError = e => { fail ??= e; terminate('codec-process-error'); };
          for (const [stream,kind,ceiling] of [[child.stdout,'stdout',decode?65536:16384],[child.stderr,'stderr',STDERR_BYTES_MAX]]) {
            if (!stream) throw error('codec-pipe-missing');
            streamWaits.push(new Promise(yes => {
              stream.on('data', data => {
                const count=data.length;
                if(kind==='stdout'){bytes+=count;receipt.stdoutBytes=bytes;if(bytes<=ceiling&&!state.retired)pieces.push(Buffer.from(data));}
                else{const remaining=Math.max(0,ceiling-stderrBytes);stderrBytes+=count;receipt.stderrBytes=stderrBytes;if(remaining)diagnostics.push(Buffer.from(data.subarray(0,remaining)));}
                if ((kind==='stdout'?bytes:stderrBytes)>ceiling) { receipt.budgetStream=kind;terminate('codec-byte-budget'); }
              });
              stream.on('error', recordError);stream.once('close',yes);
            }));
          }
          let inputDone=Promise.resolve();
          if(decode){
            let endReturned;const endDone=new Promise(yes=>{endReturned=yes;});
            const inputClosed=new Promise(yes=>{child.stdin.once('close',yes);});
            child.stdin.on('error',recordError);
            // close and the actual end callback are separate owned returns.
            inputDone=Promise.all([inputClosed,endDone]);
            child.stdin.end(supplied,e=>{try{if(e)recordError(e);}finally{endReturned();}});
          }
          child.once('spawn',()=>{state.spawned=true;receipt.spawned=true;if(state.retired)terminate(state.reason);});
          child.on('error',e=>{spawnFailure=e;if(!state.spawned&&child.pid===undefined){state.spawnError=true;receipt.knownNoProcess=true;}recordError(e);});
          child.once('exit',(code,signal)=>{state.exit=true;receipt.exit={code,signal};});
          child.once('close',(code,signal)=>{state.close=true;receipt.close={code,signal};terminalResolve();});
          if(state.retired)terminate(state.reason);
          await Promise.all([terminal,inputDone,...streamWaits]);receipt.stdioClosed=true;
          const rawStderr=Buffer.concat(diagnostics);
          receipt.stderrPrefix=rawStderr.toString('utf8');receipt.stderrBase64=rawStderr.toString('base64');receipt.stderrSha256=sha(rawStderr);
          if (!state.spawned && state.spawnError && spawnFailure) throw error('confirmed-spawn-failure');
          if (!state.spawned || !state.exit || !state.close) throw error('uncertain-process-settlement');
          if (fail || receipt.exit?.code !== 0 || receipt.exit?.signal || receipt.close?.code !== 0 || receipt.close?.signal) throw error('codec-terminal-failed');
          fence(); receipt.loadedOrigins=await verifyLoadedPaths(rawStderr,enrollment,fence,receipt); fence();
          const result=Buffer.concat(pieces);const wanted=decode?4096:1120;
          if(result.length!==wanted)throw error('codec-selected-count-mismatch');
          receipt.stdoutSha256=sha(result);receipt.status='success';accept(Uint8Array.from(result));result.fill(0);
        } catch(e) { fail??=e;terminate(e instanceof Error?e.message:'codec-failed');receipt.status='failed';receipt.reason=state.reason; }
        finally {
          clearTimeout(timer);supplied?.fill(0);
          // eslint-disable-next-line no-unsafe-finally -- mismatched cleanup must keep raw ownership uncertain.
          if(cwd){const stat=await fs.stat(cwd,{bigint:true});if(!stat.isDirectory()||stat.dev!==cwdIdentity.dev||stat.ino!==cwdIdentity.ino||await fs.realpath(cwd)!==cwd)throw error('owned-cwd-identity-mismatch');await fs.rmdir(cwd);}
          receipt.rawSettled=true; receipts.push(Object.freeze(receipt));pending.delete(state);
        }
      })();
      // A failed cleanup keeps uncertainty visible rather than claiming closure.
      settled.catch(e=>{reject(e);});
      return Object.freeze({output,settled,terminate});
    },
    async close(reason='codec-port-closed') { closed=true;for(const state of pending)state.terminate(reason);if(pending.size)throw error('codec-close-requires-issued-settled-joins'); },
    receipts:()=>receipts.slice(),
    pending:()=>pending.size,
  });
}
