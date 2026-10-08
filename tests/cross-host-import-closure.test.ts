import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('actual runtime host imports only the public hosted application and relay Hub entrypoints', () => {
  const host = new URL('../examples/cross-host-workload/runtime-host.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    const urls = new Set();
    registerHooks({ resolve(specifier, context, next) {
      const value = next(specifier, context); urls.add(value.url); return value;
    } });
    const start = performance.now();
    const host = await import(${JSON.stringify(host)});
    if (typeof host.describeCrossHostGroup !== 'function') throw Error('Actual host API missing');
    console.log(JSON.stringify({ urls: [...urls], elapsedMs: performance.now() - start }));
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const closure = JSON.parse(result.stdout) as { urls: string[]; elapsedMs: number };
  assert.ok(closure.urls.some(url => url.endsWith('/hub-server/src/hosted-application.ts')));
  assert.ok(closure.urls.some(url => url.endsWith('/hub-server/src/loopback-relay.ts')));
  assert.deepEqual(closure.urls.filter(url => /\/hub-server\/src\/(index|mqtt[^/]*)\.ts$|\/node_modules\/mqtt\//.test(url)), [],
    'Unused Hub facade and MQTT must stay outside the actual host import closure');
});
