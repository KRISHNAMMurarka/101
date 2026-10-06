#!/usr/bin/env node
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
assert.deepEqual(process.argv.slice(2), ['--workspace-exports']);
assert.equal(process.version, 'v24.14.0', 'Pinned native Node runtime');
const names = new Set(['connect', 'device-model', 'device-runtime', 'device-web', 'hub-server', 'pairing', 'protocol', 'input', 'transport-webrtc', 'transport-websocket', 'vision']);
const resolutions = {}, dependencies = new Map(), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (!specifier.startsWith('@101/')) return next(specifier, context);
  const name = specifier.slice(5); assert.ok(names.has(name), 'Only selected ordinary public SDK exports');
  const url = pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href; resolutions[specifier] = url; return next(url, context);
}, load(url, context, next) {
  if (url.startsWith(pathToFileURL(root + '/').href) && /\.(?:mjs|ts)$/.test(url)) { const path = fileURLToPath(url); dependencies.set(path.slice(root.length + 1), sha(readFileSync(path))); }
  return next(url, context);
} });
const owned = ['packages/hub-server/src/hosted-application.ts', 'packages/hub-server/src/hosted-application.test.ts', 'examples/hosted-application/consumer.mjs', 'tools/qa-hosted-application.mjs'];
const pins = () => Object.fromEntries(owned.map(path => [path, sha(readFileSync(join(root, path)))])), before = pins();
try {
  const { runHostedApplicationExample } = await import('../examples/hosted-application/consumer.mjs');
  const result = await runHostedApplicationExample(); assert.deepEqual(pins(), before);
  for (const [path, digest] of dependencies) assert.equal(sha(readFileSync(join(root, path))), digest, 'Actual dependency bytes unchanged');
  const text = JSON.stringify(result); assert.equal(text.includes('"capability":'), false); assert.equal(text.includes('"socketPath":'), false); assert.equal(text.includes('"pixels":'), true); // only the fixed public pixel count limit
  console.log(JSON.stringify({ ...result, sourceRoot: root, sourcePins: before, publicResolutions: resolutions, dependencyPins: Object.fromEntries([...dependencies].sort(([a], [b]) => a.localeCompare(b))),
    provenance: { ordinaryPublicSourceImports: true, installedSDK: false, separateNativeApplication: true, fixedReviewedChild: true, sourceHashesFrozen: true, nativeRendering: true, physicalRendering: false } }, null, 2));
} finally { hooks.deregister(); }
