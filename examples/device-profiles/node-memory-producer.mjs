import { pathToFileURL } from 'node:url';

const clockId = `node-rss:${process.pid}`;
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) throw Error('node-memory-frame');
  return value;
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function stamp(frame, context) {
  if (frame.wireVersion !== 1 || frame.clockId !== context.clockId || typeof frame.at !== 'number' ||
    !Number.isFinite(frame.at) || frame.at < 0 || frame.at > Number.MAX_SAFE_INTEGER || !positive(frame.sequence)) throw Error('node-memory-stamp');
  return Object.freeze({ clockId: frame.clockId, at: frame.at });
}
function command(input) {
  const value = closed(input, ['resourceId', 'commandId', 'value']);
  if (value.resourceId !== 'sampling' || typeof value.value !== 'boolean' || typeof value.commandId !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(value.commandId) || !positive(Number(value.commandId))) throw Error('node-memory-command');
  return value;
}

/** Fixed reviewed decoder. Importing this module never starts a process or reads the device. */
export function createNodeMemoryDecoder() {
  return {
    decode(bytes, context) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 4096) throw Error('node-memory-frame');
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (input?.kind === 'ack') {
        const value = closed(input, ['wireVersion', 'kind', 'clockId', 'at', 'sequence', 'commandId', 'resourceId']);
        if (value.resourceId !== 'sampling' || typeof value.commandId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value.commandId)) throw Error('node-memory-ack');
        return [{ kind: 'ack', resourceId: 'sampling', commandId: value.commandId, sequence: value.sequence, sourceTime: stamp(value, context) }];
      }
      const value = closed(input, ['wireVersion', 'kind', 'clockId', 'at', 'sequence', 'rssBytes', 'enabled', 'quality', 'calibrationRevision', 'absoluteErrorBound']);
      if (value.kind !== 'reading' || !Number.isSafeInteger(value.rssBytes) || value.rssBytes < 0 || typeof value.enabled !== 'boolean' ||
        value.quality !== 'valid' || value.calibrationRevision !== 1 || value.absoluteErrorBound !== 0) throw Error('node-memory-reading');
      const sourceTime = stamp(value, context);
      return [{ kind: 'sample', resourceId: 'resident', value: value.rssBytes, sequence: value.sequence, sourceTime, quality: value.quality,
        calibration: { revision: value.calibrationRevision, unit: 'By', absoluteErrorBound: value.absoluteErrorBound } },
      { kind: 'sample', resourceId: 'enabled', value: value.enabled, sequence: value.sequence, sourceTime, quality: value.quality, calibration: null }];
    },
    encodeCommand(input) {
      const value = command(input);
      return new TextEncoder().encode(`${JSON.stringify({ wireVersion: 1, kind: 'command', ...value })}\n`);
    },
    reset() {},
  };
}

function runProducer() {
  let enabled = false, sequence = 0, watermark = 0, buffer = Buffer.alloc(0), blocked = false, timer, ended = false;
  let credits = 16, creditAt = performance.now();
  function stop(code = 0) {
    if (ended) return; ended = true; enabled = false; clearInterval(timer); timer = undefined;
    buffer = Buffer.alloc(0); process.stdin.destroy(); process.exitCode = code;
  }
  function emit(value) {
    if (ended || blocked) return false;
    const frame = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(frame) > 4096) { stop(64); return false; }
    if (!process.stdout.write(frame)) { blocked = true; process.stdin.pause(); }
    return true;
  }
  function reading() {
    if (ended || blocked) return;
    // The value is the actual Node RSS integer, not a calibrated physical sensor claim.
    const at = performance.now(), rssBytes = process.memoryUsage().rss;
    emit({ wireVersion: 1, kind: 'reading', clockId, at, sequence: ++sequence, rssBytes, enabled,
      quality: 'valid', calibrationRevision: 1, absoluteErrorBound: 0 });
  }
  process.stdout.on('drain', () => { blocked = false; if (!ended) { reading(); process.stdin.resume(); } });
  process.stdout.on('error', () => stop(0));
  process.stdin.on('error', () => stop(0));
  process.stdin.on('end', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.stdin.on('data', chunk => {
    if (ended) return;
    if (chunk.byteLength > 8192) { stop(64); return; }
    const combined = Buffer.concat([buffer, chunk]); let from = 0, count = 0;
    try {
      for (let index = 0; index < combined.length; index++) {
        if (combined[index] !== 10) { if (index - from + 1 > 4096) throw Error('frame'); continue; }
        if (++count > 16 || blocked) throw Error('backpressure');
        const now = performance.now(); credits = Math.min(16, credits + (now - creditAt) * 32 / 1000); creditAt = now;
        if (credits < 1) throw Error('rate'); credits--;
        const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined.subarray(from, index))); from = index + 1;
        closed(input, ['wireVersion', 'kind', 'resourceId', 'commandId', 'value']);
        if (input.wireVersion !== 1 || input.kind !== 'command') throw Error('operation');
        command({ resourceId: input.resourceId, commandId: input.commandId, value: input.value });
        const id = Number(input.commandId); if (id <= watermark) throw Error('replay'); watermark = id;
        enabled = input.value;
        clearInterval(timer); timer = enabled ? setInterval(reading, 50) : undefined;
        // ACK confirms the accepted command; a separate read of current state follows it.
        emit({ wireVersion: 1, kind: 'ack', clockId, at: performance.now(), sequence: ++sequence, commandId: input.commandId, resourceId: 'sampling' });
        reading();
      }
      buffer = combined.subarray(from); if (buffer.byteLength > 4096) throw Error('buffer');
    } catch { stop(64); }
  });
  reading();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runProducer();
