import { spawnSync } from 'node:child_process';

// QA-only diagnostics for actual synchronous compiler and private-board calls.
// The caller retains each original command, environment and native bound.
export function clipboardNativeProbe(name, command, args, options, { status = 0, emptyStderr = true } = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, options);
  const stdout = result.stdout?.toString() ?? '', stderr = result.stderr?.toString() ?? '';
  const probe = Object.freeze({ name, command, args: [...args], timeoutMs: options.timeout ?? null,
    maxBuffer: options.maxBuffer ?? null, elapsedMs: performance.now() - started, pid: result.pid,
    status: result.status, signal: result.signal,
    error: result.error ? { code: result.error.code ?? null, message: result.error.message.slice(0, 512) } : null,
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    stdout: stdout.slice(-8192), stderr: stderr.slice(-8192),
  });
  if (result.status !== status || emptyStderr && stderr !== '') {
    throw new Error(`Native clipboard probe failed; probe=${JSON.stringify(probe)}`);
  }
  return { ...result, probe };
}
