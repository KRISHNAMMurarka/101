const PROFILE_ID = 'app:bounded-linear-axis-mm-software/1';
const LINE_BYTES = 1024;
const OUTPUT_BYTES = 16384;
const DEADMAN_MS = 250;
const STEP_MS = 20;
const role = process.argv[2];
const mode = process.argv[3] ?? 'normal';
if (role !== 'actuator' && role !== 'feedback') process.exit(2);

let inputBytes = 0;
let outputBytes = 0;
let session;
let lastSession;
let positionMm = 0;
let feedbackSequence = 0;
let operationVersion = 0;
let deadman;
let releasing = false;
let releasePromise = Promise.resolve();
const operationIds = new Set();

function send(value) {
  const line = `${JSON.stringify(value)}\n`;
  outputBytes += Buffer.byteLength(line);
  if (Buffer.byteLength(line) > LINE_BYTES || outputBytes > OUTPUT_BYTES) process.exit(3);
  process.stdout.write(line);
}
function clearDeadman() { if (deadman) clearTimeout(deadman); deadman = undefined; }
const wait = delay => new Promise(resolve => setTimeout(resolve, delay));
function validSession(value) { return session && value.generation === session.generation && value.token === session.token; }
function closedShape(value, keys) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function parseClosed(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
  const keys = new Set();
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    if (!/^\s*:/.test(raw.slice(match.index + match[0].length))) continue;
    const key = JSON.parse(match[0]);
    if (keys.has(key)) throw new Error('duplicate key');
    keys.add(key);
  }
  return value;
}
function reject(value) { send({type: 'rejected', ...(session ?? lastSession), operationId: typeof value.operationId === 'string' ? value.operationId : undefined}); }
function boundedOperation(value) {
  return typeof value.operationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.operationId) &&
    !operationIds.has(value.operationId) && operationIds.size < (role === 'actuator' ? 16 : 32) &&
    Number.isSafeInteger(value.remainingMs) && value.remainingMs >= 1 && value.remainingMs <= 500;
}
async function returnToPark(version, held) {
  while (positionMm !== 0 && operationVersion === version) {
    await wait(STEP_MS);
    if (operationVersion !== version) return;
    positionMm += positionMm > 0 ? -1 : 1;
    send({ type: 'position-step', ...held, positionMm, policyReturn: true });
  }
}
function armDeadman(version, held) {
  clearDeadman();
  deadman = setTimeout(async () => {
    deadman = undefined;
    if (session !== held || operationVersion !== version) return;
    send({ type: 'invalidated', ...held, reason: 'deadman' });
    operationVersion++;
    releasing = true;
    releasePromise = returnToPark(operationVersion, held).finally(() => { releasing = false; });
    await releasePromise;
  }, DEADMAN_MS);
}
async function message(value) {
  const identity = ['type', 'generation', 'token'];
  if (value.type === 'open') {
    if (!closedShape(value, [...identity, 'remainingMs']) || session ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      typeof value.token !== 'string' || !/^[a-f0-9]{32}$/.test(value.token) ||
      !Number.isSafeInteger(value.remainingMs) || value.remainingMs < 1 || value.remainingMs > 500) { reject(value); return; }
    clearDeadman(); operationVersion++; operationIds.clear(); positionMm = 0; feedbackSequence = 0;
    session = Object.freeze({ generation: value.generation, token: value.token }); lastSession = session;
    if (mode === 'invalid-utf8-output') { process.stdout.write(Buffer.from([255])); return; }
    if (mode === 'unknown-output') { send({type: 'ready', ...session, positionMm, interlockOpen: false, unknown: true}); return; }
    if (mode === 'duplicate-key-output') { process.stdout.write(`{"type":"ready","generation":${session.generation},"token":"${session.token}","token":"${session.token}","positionMm":0,"interlockOpen":false}\n`); return; }
    if (mode === 'oversize-line') { process.stdout.write('x'.repeat(LINE_BYTES + 1)); return; }
    if (mode === 'oversize-total') { process.stdout.write('x\n'.repeat(OUTPUT_BYTES)); return; }
    send({ type: 'ready', ...session, ...(role === 'actuator' ? { positionMm, interlockOpen: mode === 'interlock-open' } : {}) });
    return;
  }
  if (value.type === 'close') {
    if (!closedShape(value, identity) || !lastSession || value.generation !== lastSession.generation || value.token !== lastSession.token) { reject(value); return; }
    clearDeadman(); operationVersion++;
    await releasePromise; session = undefined;
    send({ type: 'closed', role, ...lastSession }); process.exit(0);
  }
  if (!validSession(value)) { reject(value); return; }
  const held = session;
  if (value.type === 'set-position' && role === 'actuator') {
    if (!closedShape(value, [...identity, 'operationId', 'targetMm', 'remainingMs']) || !boundedOperation(value) ||
      !Number.isInteger(value.targetMm) || value.targetMm < 0 || value.targetMm > 10) { reject(value); return; }
    operationIds.add(value.operationId);
    const reply = { ...held, operationId: value.operationId };
    if (mode === 'interlock-open' && value.targetMm !== 0) { send({ type: 'interlock-open', ...reply, positionMm }); return; }
    const version = ++operationVersion; armDeadman(version, held);
    const startedAt = performance.now();
    while (positionMm !== value.targetMm && operationVersion === version) {
      await wait(mode === 'slow' ? 60 : STEP_MS);
      if (performance.now() - startedAt >= value.remainingMs || operationVersion !== version) { send({ type: 'cancelled', ...reply, positionMm }); return; }
      positionMm += positionMm < value.targetMm ? 1 : -1;
      send({ type: 'position-step', ...reply, positionMm });
      if (mode === 'fault-after-step') process.exit(7);
      if (mode === 'interlock-trip' && positionMm > 0) {
        send({ type: 'invalidated', ...held, reason: 'interlock-trip' }); clearDeadman(); operationVersion++;
        releasing = true; releasePromise = returnToPark(operationVersion, held).finally(() => { releasing = false; });
        await releasePromise; send({ type: 'cancelled', ...reply, positionMm }); return;
      }
    }
    if (operationVersion === version) {
      const completed = { type: 'completed', ...reply, positionMm };
      send(mode === 'stale-session' ? {...completed, token: '0'.repeat(32)} : completed);
      if (mode === 'duplicate-output') send(completed);
    }
    return;
  }
  if (value.type === 'observe' && role === 'feedback') {
    if (!closedShape(value, [...identity, 'operationId', 'remainingMs']) || !boundedOperation(value)) { reject(value); return; }
    operationIds.add(value.operationId); const version = operationVersion;
    if (mode === 'slow') {
      await wait(value.remainingMs + 10);
      if (session === held && version === operationVersion) send({type: 'cancelled', ...held, operationId: value.operationId, positionMm: 3});
      return;
    }
    if (session !== held || version !== operationVersion) return;
    if (mode === 'fault') process.exit(7);
    feedbackSequence++;
    const sample = { type: 'sample', ...held, operationId: value.operationId,
      positionMm: mode === 'match-script' || mode === 'normal-match-script' ? 4 : mode === 'out-of-range' ? 11 : 3,
      lowerLimitSafe: true, upperLimitSafe: true,
      sequence: mode === 'duplicate-sequence' ? 1 : mode === 'stale-sequence' ? 0 : feedbackSequence,
      sourceClockId: 'software-feedback-child-monotonic', sourceMonotonicNs: process.hrtime.bigint().toString() };
    send(mode === 'stale-session' ? {...sample, token: '0'.repeat(32)} : sample); return;
  }
  if (value.type === 'release' && role === 'actuator' && closedShape(value, identity)) {
    clearDeadman();
    if (!releasing) { operationVersion++; releasing = true; releasePromise = returnToPark(operationVersion, held).finally(() => { releasing = false; }); }
    await releasePromise; send({ type: 'released', ...held, positionMm }); return;
  }
  if (value.type === 'stop' && closedShape(value, identity)) {
    clearDeadman(); if (!releasing) operationVersion++; await releasePromise;
    send({ type: 'stopped', ...held }); if (session === held) session = undefined; return;
  }
  reject(value);
}
send({ type: 'hello', role, profileId: PROFILE_ID, softwareOnly: true, physical: false,
  lineBytes: LINE_BYTES, outputBytes: OUTPUT_BYTES, deadmanMs: role === 'actuator' ? DEADMAN_MS : undefined,
  stepMm: role === 'actuator' ? 1 : undefined, nominalStepMs: role === 'actuator' ? STEP_MS : undefined });
const decoder = new TextDecoder('utf-8', {fatal: true});
let raw = '';
let lineBytes = 0;
process.stdin.on('data', chunk => {
  try {
    inputBytes += chunk.length;
    if (inputBytes > OUTPUT_BYTES) throw new Error('input total');
    let start = 0;
    for (let i = 0; i <= chunk.length; i++) {
      if (i < chunk.length && chunk[i] !== 10) continue;
      const part = chunk.subarray(start, i);
      lineBytes += part.length;
      if (lineBytes >= LINE_BYTES) throw new Error('input line');
      raw += decoder.decode(part, {stream: true});
      if (i < chunk.length) {
        raw += decoder.decode();
        const value = parseClosed(raw); raw = ''; lineBytes = 0;
        void message(value).catch(() => process.exit(7));
      }
      start = i + 1;
    }
  } catch { process.exit(4); }
});
process.stdin.on('end', () => { try { decoder.decode(); if (raw || lineBytes) throw new Error('trailing input'); } catch { process.exit(4); } });
