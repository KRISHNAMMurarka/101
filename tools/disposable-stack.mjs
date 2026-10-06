#!/usr/bin/env node
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '..');
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
let cliReserved = false;
const publicNames = ['hub-server', 'pairing', 'protocol', 'input', 'connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'];
/** CLI-owned public source resolution only; no credentials/path/config options. */
export async function runDisposableStackCli(mode, signal, report = value => console.log(JSON.stringify(value))) {
  if (cliReserved) throw Error('Disposable stack CLI already active.');
  if (!['exercise', 'serve'].includes(mode)) throw Error('Select exercise or serve.'); cliReserved = true;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const name = specifier.startsWith('@101/') ? specifier.slice(5) : '';
    return next(publicNames.includes(name) ? pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href : specifier, context);
  } });
  try {
    const { runDisposableStack } = await import('../examples/coordinator/disposable-stack.mjs');
    const receipt = await runDisposableStack({ mode, signal, onEvent: report });
    if (mode === 'exercise' && receipt.result === 'pass' && nativeAborted.call(signal) === false) await report({ event: 'exercised', profile: receipt.profile, proof: receipt });
    return receipt;
  } finally { hooks.deregister(); cliReserved = false; }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--exercise', '--serve'].includes(args[0])) { console.error('Use node tools/disposable-stack.mjs --exercise or --serve.'); process.exitCode = 2; return; }
  const owner = new AbortController(), cancel = () => owner.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { await runDisposableStackCli(args[0].slice(2), owner.signal); }
  catch { console.error('Disposable stack failed. Check local Node/OpenSSL requirements and retry. A removed event confirms settled cleanup.'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
