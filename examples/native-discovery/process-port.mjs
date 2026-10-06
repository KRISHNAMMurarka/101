import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Host-provisioned executable, never a path received in TXT/discovery input.
 * Construction performs no file read, process launch or permission request.
 * This source-bound Node host adapter is not a browser/native-mobile backend. */
export function createMacosDnsSdProvider(options) {
  if (process.platform !== 'darwin') return undefined;
  if (!options || Object.keys(options).some(key => !['executable', 'sha256', 'onProcess'].includes(key)) || typeof options.executable !== 'string' ||
    !isAbsolute(options.executable) || typeof options.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(options.sha256)) throw new TypeError('Invalid provisioned native executable');
  if (options.onProcess !== undefined && typeof options.onProcess !== 'function') throw new TypeError('Invalid owned process observer');
  const executable = resolve(options.executable), sha256 = options.sha256, onProcess = options.onProcess;
  return Object.freeze({ profile: 'macos-local-only-dns-sd/1', open(scope, callbacks, signal) {
    if (signal.aborted || scope.interfaceIndex !== 0xffffffff || scope.domain !== 'local.' || scope.profile !== 'macos-local-only-dns-sd/1' ||
      scope.operation !== 'observe' || !/^_[A-Za-z0-9-]{1,15}\._tcp$/.test(scope.serviceType)) throw new Error('Unavailable native scope');
    const file = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const state = fstatSync(file); if (!state.isFile() || state.size < 1 || state.size > 1048576 || realpathSync(executable) !== executable) throw new Error('Unavailable native executable');
      const bytes = Buffer.alloc(state.size + 1); let length = 0;
      for (let turn = 0; turn < 256; turn++) {
        const count = readSync(file, bytes, length, bytes.length - length, length); length += count;
        if (length > state.size) throw new Error('Native executable changed');
        if (count === 0) { if (length !== state.size || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== sha256) throw new Error('Native executable pin mismatch'); break; }
        if (turn === 255) throw new Error('Native executable read bound');
      }
    } finally { closeSync(file); }
    if (signal.aborted) throw new Error('Native scope retired');
    const child = spawn(executable, ['browse', scope.serviceType, '30000'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 30000,
    });
    let stopped = false, ended = false, timer, bytes = 0, text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    function stop() {
      if (stopped || ended) return; stopped = true; child.stdout.off('data', receive);
      try { child.stdin.end('stop\n'); } catch { /* Owned fallback signal below. */ }
      timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 2000);
    }
    function receive(chunk) {
      if (stopped || ended || signal.aborted) return;
      try {
        bytes += chunk.byteLength; if (bytes > 16384) throw new Error('Native output quota');
        text += decoder.decode(chunk, { stream: true });
        for (let newline; (newline = text.indexOf('\n')) >= 0;) {
          const line = text.slice(0, newline); text = text.slice(newline + 1);
          if (!line || Buffer.byteLength(line) > 2048) throw new Error('Native event bound');
          if (!stopped && !ended && !signal.aborted) callbacks.event(JSON.parse(line));
        }
      } catch { stop(); }
    }
    const revoked = () => stop(); signal.addEventListener('abort', revoked, { once: true });
    child.stdout.on('data', receive); child.stderr.on('data', stop); child.on('error', stop); child.stdin.on('error', stop);
    child.once('close', () => { if (ended) return; ended = true; stopped = true;
      if (timer !== undefined) clearTimeout(timer); child.stdout.off('data', receive); child.stderr.off('data', stop);
      child.stdin.off('error', stop); signal.removeEventListener('abort', revoked); callbacks.closed(); });
    if (signal.aborted) stop();
    // Trusted owned-process diagnostics run only after cleanup/exit listeners exist.
    try { onProcess?.(child); } catch { stop(); }
    if (signal.aborted) stop(); return Object.freeze({ stop });
  } });
}
