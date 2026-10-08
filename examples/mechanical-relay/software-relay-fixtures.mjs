import { randomBytes } from 'node:crypto';
import readline from 'node:readline';

const role = process.argv[2];
const mode = process.argv[3] ?? 'normal-match';
if (!['actuator', 'feedback'].includes(role)) process.exit(64);

const WATCHDOG_MS = 250;
const LINE_BYTES = 1024;
const OUTPUT_BYTES = 16384;

let session;
let active;
let state = 'off';
let sequence = 0;
let watchdog;
let interlockTimer;
let outputBytes = 0;
const sourceClockId = `software-feedback-${randomBytes(8).toString('hex')}`;
const send = value => {
  const line = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(line);
  outputBytes += bytes;
  if (bytes > LINE_BYTES || outputBytes > OUTPUT_BYTES) process.exit(70);
  process.stdout.write(line);
};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validSession = message => session && message.generation === session.generation && message.token === session.token;

function clearWatchdog() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = undefined;
}

function clearInterlockTimer() {
  if (interlockTimer) clearTimeout(interlockTimer);
  interlockTimer = undefined;
}

function release(reason) {
  clearWatchdog();
  clearInterlockTimer();
  state = 'off';
  send({ type: 'released', reason, generation: session?.generation ?? -1, token: session?.token ?? '' });
}

function finishActive(type) {
  if (!active) return;
  clearTimeout(active.timer);
  send({ type, operationId: active.operationId });
  active = undefined;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  try {
    if (Buffer.byteLength(line) > LINE_BYTES) throw new Error('oversize');
    const message = JSON.parse(line);
    if (exact(message, ['type', 'generation', 'token', 'deadline']) && message.type === 'open' && !session &&
      Number.isSafeInteger(message.generation) && /^[a-f0-9]{32}$/.test(message.token) &&
      Number.isFinite(message.deadline) && message.deadline > performance.now()) {
      session = { generation: message.generation, token: message.token };
      send({ type: 'ready', ...session });
      return;
    }
    if (message?.type === 'set') {
      if (role !== 'actuator' || !exact(message, ['type', 'generation', 'token', 'operationId', 'state', 'deadline']) ||
        !validSession(message) || active || !['off', 'on'].includes(message.state) || message.deadline <= performance.now()) {
        send({ type: 'rejected', operationId: message?.operationId ?? '' });
        return;
      }
      const operationId = message.operationId;
      if (mode === 'interlock-open' && message.state === 'on') {
        send({ type: 'interlock-open', operationId, logicalRegister: state });
        return;
      }
      active = { operationId, timer: setTimeout(() => {
        active = undefined;
        state = message.state;
        if (state === 'on') {
          clearWatchdog();
          watchdog = setTimeout(() => release('watchdog'), WATCHDOG_MS);
          if (mode === 'interlock-trip') {
            clearInterlockTimer();
            interlockTimer = setTimeout(() => release('interlock-trip'), 50);
          }
        } else {
          clearWatchdog();
        }
        send({ type: 'completed', operationId, state });
      }, 5) };
      return;
    }
    if (message?.type === 'read') {
      if (role !== 'feedback' || !exact(message, ['type', 'generation', 'token', 'operationId', 'deadline']) ||
        !validSession(message) || active || message.deadline <= performance.now()) {
        send({ type: 'rejected', operationId: message?.operationId ?? '' });
        return;
      }
      const operationId = message.operationId;
      if (mode === 'silent') {
        active = { operationId, timer: setTimeout(() => {}, 60_000) };
        return;
      }
      active = { operationId, timer: setTimeout(() => {
        active = undefined;
        if (mode !== 'duplicate' || sequence === 0) sequence++;
        const sampleState = mode === 'mismatch' ? 'off' : 'on';
        send({ type: 'sample', operationId, state: sampleState, limitSafe: true, sequence,
          sourceClockId, sourceMonotonicNs: process.hrtime.bigint().toString() });
      }, 5) };
      return;
    }
    if (message?.type === 'release' && exact(message, ['type', 'generation', 'token']) && validSession(message) && role === 'actuator') {
      finishActive('cancelled');
      release('gateway-release');
      return;
    }
    if (message?.type === 'stop' && exact(message, ['type', 'generation', 'token']) && validSession(message)) {
      finishActive('cancelled');
      if (role === 'actuator') release('stop');
      const stopped = session;
      session = undefined;
      send({ type: 'stopped', ...stopped });
      return;
    }
    if (exact(message, ['type']) && message.type === 'close') {
      finishActive('cancelled');
      clearWatchdog();
      clearInterlockTimer();
      state = 'off';
      send({ type: 'closed', role, waiters: 0, timers: 0 });
      process.exit(0);
    }
    send({ type: 'rejected', operationId: message?.operationId ?? '' });
  } catch {
    send({ type: 'error', nonce: randomBytes(4).toString('hex') });
  }
});

send({ type: 'hello', revision: 1, role, profileId: 'app:single-relay-software-interlocked/1',
  softwareOnly: true, physical: false, watchdogMs: role === 'actuator' ? WATCHDOG_MS : null,
  lineBytes: LINE_BYTES, outputBytes: OUTPUT_BYTES });
