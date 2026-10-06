import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Fixed private software target. It owns a raster buffer and a contact state,
// not a screen, audio device, physical controller or general command executor.
const port = parentPort;
const own = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
if (!port || !own(workerData, ['version', 'recipient', 'capability', 'sourceSha256']) || workerData.version !== 1 ||
    !integer(workerData.recipient, 0, 1) || !/^[0-9a-f]{32}$/.test(workerData.capability) ||
    createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') !== workerData.sourceSha256) throw Error('Invalid owned target');
const recipient = workerData.recipient, capability = workerData.capability;
const clockId = 'owned-media-control-worker-' + recipient;
let closed = false, holding = false, pending, raster, contactHeld = false, controlSequence = 0, minimumEpoch = 1, messages = 0, frames = 0;
const reply = value => port.postMessage({ ...value, capability, clockId, emittedAt: performance.now() });
function frame(input) {
  if (!own(input, ['kind', 'capability', 'id', 'epoch', 'sequence', 'width', 'height', 'reference', 'chunks']) ||
      !integer(input.id, 1, 256) || !integer(input.epoch, 1, 4) || !integer(input.sequence, 1, 64) ||
      ![64, 128].includes(input.width) || input.height !== input.width || !Array.isArray(input.chunks) || input.chunks.length !== input.width * input.height * 4 / 4096) throw Error('frame');
  const reference = input.reference, length = input.width * input.height * 4;
  if (!own(reference, ['id', 'kind', 'mediaType', 'byteLength', 'sha256']) || reference.id !== 'frame:owned-' + input.sequence ||
      reference.kind !== 'blob' || reference.mediaType !== 'application/octet-stream' || reference.byteLength !== length || !/^[0-9a-f]{64}$/.test(reference.sha256)) throw Error('reference');
  const bytes = new Uint8Array(length);
  for (let index = 0; index < input.chunks.length; index++) {
    const item = input.chunks[index];
    if (!own(item, ['index', 'offset', 'bytes']) || item.index !== index || item.offset !== index * 4096 ||
        !(item.bytes instanceof Uint8Array) || item.bytes.byteLength !== 4096) throw Error('chunk');
    bytes.set(item.bytes, item.offset);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw Error('integrity');
  return { id: input.id, epoch: input.epoch, sequence: input.sequence, width: input.width, bytes, sha256: reference.sha256, cancelled: false };
}
function finish(value) {
  if (value.cancelled || value.epoch < minimumEpoch) { reply({ kind: 'cancelled', id: value.id }); return; }
  // This native application owns and replaces the actual verified raster bytes.
  raster = value;
  reply({ kind: 'media', id: raster.id, epoch: raster.epoch, sequence: raster.sequence, width: raster.width,
    byteLength: raster.bytes.byteLength, sha256: createHash('sha256').update(raster.bytes).digest('hex'), firstPixel: [...raster.bytes.subarray(0, 4)] });
}
function stop() {
  if (closed) return;
  closed = true;
  clearTimeout(lifetime);
  if (pending) { pending.cancelled = true; finish(pending); pending = undefined; }
  raster = undefined; contactHeld = false;
  port.removeListener('message', message);
  reply({ kind: 'closed', rawBytes: 0, contactHeld: false, nativeTimers: 0, nativeListeners: 0 });
  port.close();
}
function message(input) {
  if (closed) return;
  if (++messages > 256 || !input || input.capability !== capability) { stop(); return; }
  try {
    if (input.kind === 'media') {
      if (++frames > 64 || pending) throw Error('capacity');
      const value = frame(input);
      if (holding) { pending = value; reply({ kind: 'held', id: value.id, byteLength: value.bytes.byteLength }); }
      else finish(value);
      return;
    }
    if (own(input, ['kind', 'capability', 'id']) && input.kind === 'cancel' && integer(input.id, 1, 256)) {
      // Cancellation changes logical authority, but does not fabricate an ACK.
      // A held operation retains its native bytes until hold is released or exit.
      if (pending?.id === input.id) pending.cancelled = true;
      return;
    }
    if (own(input, ['kind', 'capability', 'id', 'hold']) && input.kind === 'hold' && integer(input.id, 1, 256) && typeof input.hold === 'boolean') {
      holding = input.hold;
      reply({ kind: 'mode', id: input.id, hold: holding, pending: Number(!!pending) });
      if (!holding && pending) { const value = pending; pending = undefined; finish(value); }
      return;
    }
    if (own(input, ['kind', 'capability', 'id', 'epoch']) && input.kind === 'retire-epoch' && integer(input.id, 1, 256) && integer(input.epoch, 2, 4)) {
      minimumEpoch = Math.max(minimumEpoch, input.epoch); raster = undefined;
      if (pending && pending.epoch < minimumEpoch) pending.cancelled = true;
      reply({ kind: 'epoch', id: input.id, epoch: minimumEpoch }); return;
    }
    if (own(input, ['kind', 'capability', 'id', 'sequence', 'phase']) && input.kind === 'contact' && integer(input.id, 1, 256) &&
        integer(input.sequence, 1, 64) && input.sequence > controlSequence && ['down', 'up', 'cancel'].includes(input.phase)) {
      controlSequence = input.sequence; contactHeld = input.phase === 'down';
      reply({ kind: 'contact', id: input.id, sequence: controlSequence, held: contactHeld, released: false }); return;
    }
    if (own(input, ['kind', 'capability', 'id']) && input.kind === 'release' && integer(input.id, 1, 256)) {
      contactHeld = false; reply({ kind: 'contact', id: input.id, sequence: 0, held: false, released: true }); return;
    }
    if (own(input, ['kind', 'capability']) && input.kind === 'close') { stop(); return; }
    throw Error('grammar');
  } catch { if (integer(input.id, 1, 256)) reply({ kind: 'rejected', id: input.id }); else stop(); }
}
const lifetime = setTimeout(stop, 10000);
port.on('message', message);
reply({ kind: 'ready', profile: 'owned-private-raster-contact/1', recipient });
