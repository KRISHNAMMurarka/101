import { createHash } from 'node:crypto';
import readline from 'node:readline';

const profileId = 'app:nec-inverse-byte-command-one-shot/1';
let session, active;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function validateEnvelope(text, claimed) {
  if (typeof text !== 'string' || text.length > 400 || typeof claimed !== 'string') throw new Error('bad envelope');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== 282 || bytes.subarray(0, 4).toString('ascii') !== 'IRN1' || bytes.readUInt32BE(4) !== 38000 ||
    bytes.readUInt16BE(12) !== 67 || createHash('sha256').update(bytes).digest('hex') !== claimed) throw new Error('bad envelope');
  if ((bytes[8] ^ bytes[9]) !== 0xff || (bytes[10] ^ bytes[11]) !== 0xff) throw new Error('bad complement');
  const timings = Array.from({ length: 67 }, (_, index) => bytes.readUInt32BE(14 + index * 4));
  if (timings[0] !== 9000 || timings[1] !== 4500 || timings[66] !== 560 ||
    timings.reduce((sum, value) => sum + value, 0) !== 68060) throw new Error('bad timing');
  for (let index = 2; index < 66; index += 2)
    if (timings[index] !== 560 || ![565, 1690].includes(timings[index + 1])) throw new Error('bad timing');
  return bytes;
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  try {
    if (line.length > 1024) throw new Error('line too large'); const message = JSON.parse(line);
    if (exact(message, ['type', 'generation', 'token', 'deadline']) && message.type === 'open' && !session &&
      Number.isSafeInteger(message.generation) && typeof message.token === 'string' && /^[a-f0-9]{32}$/.test(message.token) &&
      Number.isFinite(message.deadline) && message.deadline > performance.now()) {
      session = { generation: message.generation, token: message.token };
      send({ type: 'ready', generation: message.generation, token: message.token }); return;
    }
    if (message?.type === 'emit' && (!exact(message, ['type', 'generation', 'token', 'operationId', 'deadline', 'envelope', 'sha256']) ||
      !session || message.generation !== session.generation || message.token !== session.token || active ||
      typeof message.operationId !== 'string' || !Number.isFinite(message.deadline) || message.deadline <= performance.now())) {
      send({ type: 'rejected', operationId: typeof message?.operationId === 'string' ? message.operationId : '' }); return;
    }
    if (message?.type === 'emit') {
      validateEnvelope(message.envelope, message.sha256); const operationId = message.operationId;
      const timer = setTimeout(() => { active = undefined; send({ type: 'completed', operationId, sha256: message.sha256,
        providerEvidence: 'software-pattern-completed' }); }, 69);
      active = { operationId, timer }; return;
    }
    if (message?.type === 'stop' && (!exact(message, ['type', 'generation', 'token']) || !session ||
      message.generation !== session.generation || message.token !== session.token)) { send({ type: 'rejected-stop' }); return; }
    if (message?.type === 'stop') {
      if (active) { clearTimeout(active.timer); send({ type: 'cancelled', operationId: active.operationId }); active = undefined; }
      const stopped = session; session = undefined; send({ type: 'stopped', generation: stopped.generation, token: stopped.token }); return;
    }
    if (exact(message, ['type']) && message.type === 'close') { if (active) clearTimeout(active.timer); send({ type: 'closed' }); process.exit(0); }
    throw new Error('unsupported');
  } catch { send({ type: 'error' }); }
});
send({ type: 'hello', revision: 1, profileId, carrierRanges: [{ minHz: 38000, maxHz: 38000 }] });
