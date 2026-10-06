import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const reviewedSha256 = '7bb4137d774b85ad461413962e9f95cf1cb67679a49d4cf21bb7c8ea8f09c59b';
const limits = Object.freeze({ sourceBytes: 16384, chunkBytes: 65536, writeBytes: 1024, pendingWrites: 1, lifetimeMs: 10000 });
const typedArrayBytes = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const typedArraySet = Uint8Array.prototype.set;
function snapshot(input, maximum) {
  if (!(input instanceof Uint8Array)) throw Error('headless-input');
  const size = Reflect.apply(typedArrayBytes, input, []);
  if (size < 1 || size > maximum) throw Error('headless-input');
  const owned = new Uint8Array(size); Reflect.apply(typedArraySet, owned, [input]);
  return Buffer.from(owned.buffer, 0, size);
}
function own(value, name) { try { const field = Object.getOwnPropertyDescriptor(value, name); return field && 'value' in field ? field.value : undefined; } catch { return undefined; } }

/** Fixed reviewed Linux software producer. Host callbacks are cooperative, not sandboxed. No route permission is minted here. */
export function createHeadlessNodeStdioPort({ source, onChunk, onDisconnect }) {
  if (process.platform !== 'linux' || process.arch !== 'arm64' || typeof onChunk !== 'function' || typeof onDisconnect !== 'function') throw Error('headless-input');
  const bytes = snapshot(source, limits.sourceBytes);
  if (createHash('sha256').update(bytes).digest('hex') !== reviewedSha256) throw Error('headless-reviewed-source');
  const child = spawn(process.execPath, ['--max-old-space-size=32', '--input-type=module', '--eval', bytes.toString('utf8') + '\nrunProducer();'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' } });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) throw Error('headless-child');
  const clockId = `node-rss:${child.pid}`;
  let closing = false, closed = false, notified = false, inFlight = 0, writes = 0, settledWrites = 0, receivedBytes = 0, stderrBytes = 0;
  let terminate, kill, reason = 'running', exitCode, exitSignal;
  const disconnected = () => {
    if (notified) return; notified = true;
    try { onDisconnect(reason); } catch { /* Teardown cannot restore producer authority. */ }
  };
  const ended = new Promise(resolve => child.once('close', (code, signal) => {
    closing = true; closed = true; exitCode = code; exitSignal = signal;
    clearTimeout(lifetime); clearTimeout(terminate); clearTimeout(kill); disconnected(); resolve();
  }));
  function retire(next) {
    if (closing) return; closing = true; reason = next; disconnected();
    child.stdin.end();
    terminate = setTimeout(() => { if (!closed) child.kill('SIGTERM'); }, 150);
    kill = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 400);
  }
  const lifetime = setTimeout(() => retire('lifetime'), limits.lifetimeMs);
  child.stdout.on('data', chunk => {
    if (closing) return;
    if (chunk.byteLength > limits.chunkBytes) { retire('chunk-capacity'); return; }
    receivedBytes += chunk.byteLength;
    try { onChunk(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); }
    catch { retire('reader-failed'); }
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.byteLength; retire('producer-stderr'); });
  child.stdout.on('error', () => retire('stdout-error')); child.stderr.on('error', () => retire('stderr-error'));
  child.stdin.on('error', () => retire('stdin-error')); child.on('error', () => retire('child-error'));
  child.on('exit', () => { if (!closing) { reason = 'producer-exit'; closing = true; disconnected(); } });
  return Object.freeze({
    clockId,
    write(input, context) {
      let bytes;
      try { bytes = snapshot(input, limits.writeBytes); } catch { return Promise.reject(Error('headless-write')); }
      if (!context || typeof context !== 'object') return Promise.reject(Error('headless-write'));
      if (closing || closed || inFlight >= limits.pendingWrites) return Promise.reject(Error('headless-busy'));
      // Reserve before trusted currentness callbacks. Logical cancellation/close never frees issued work.
      inFlight++;
      const signal = own(context, 'signal'), isCurrent = own(context, 'isCurrent');
      let issued = false;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => { if (settled) return; settled = true; inFlight--; if (issued) settledWrites++; if (error) reject(Error('headless-write-failed')); else resolve(); };
        const current = () => {
          let approved = false;
          try { approved = signal instanceof AbortSignal && !signal.aborted && typeof isCurrent === 'function' && isCurrent() === true; } catch { /* Explicit currentness required. */ }
          return approved && !signal.aborted && !closing && !closed && child.stdin.writable;
        };
        try {

          if (!current()) { finish(Error('revoked')); return; }
          issued = true; writes++; child.stdin.write(bytes, finish);
        } catch { finish(Error('dispatch')); }
      });
    },
    /** SIGKILL is scoped to this owned software child; issued effects are not undone. */
    terminateOwned() { if (!closing) { reason = 'owned-termination'; closing = true; disconnected(); child.kill('SIGKILL'); } },
    close() { retire('closed'); return ended; },
    status() { return Object.freeze({ closing, closed, reason, writes, settledWrites, inFlightWrites: inFlight, receivedBytes, stderrBytes, exitCode, exitSignal, limits }); },
  });
}
