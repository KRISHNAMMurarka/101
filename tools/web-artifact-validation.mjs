import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readLocalLicenseBytes } from './generate-license-inventory.mjs';

const REQUIRED_WEB_FILES = Object.freeze([
  'server/index.js', 'server/BUILD_ID', 'client/.vite/manifest.json', 'client/vinext-client-entry-manifest.json',
  'client/sw.js', 'client/link.webmanifest', 'client/manifest.webmanifest', 'client/icons/101-link.svg',
  'client/models/pose_landmarker_lite.task', 'client/models/hand_landmarker.task',
  'client/mediapipe/wasm/vision_wasm_internal.js', 'client/mediapipe/wasm/vision_wasm_internal.wasm',
  'client/mediapipe/wasm/vision_wasm_nosimd_internal.js', 'client/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeAsset = path => typeof path === 'string' && path.length <= 2048 && path.startsWith('_next/static/')
  && !/[\\?#]/.test(path) && ![...path].some(character => character.charCodeAt(0) <= 32) && !path.split('/').some(part => !part || part === '.' || part === '..');

/** Selected local web profile only. No evaluation, rendering or browser/network access. */
export async function auditWebRuntimeAssets(directory, contents) {
  const files = new Map(contents.map(entry => [entry.path, entry]));
  function requireFile(path) {
    if (!files.has(path) || files.get(path).bytes <= 0) throw new Error(`Missing or empty required web asset: ${path}`);
  }
  for (const path of REQUIRED_WEB_FILES) requireFile(path);
  async function json(path) {
    const bytes = await readLocalLicenseBytes(join(directory, path), 2 * 1024 * 1024);
    if (bytes.length !== files.get(path).bytes || createHash('sha256').update(bytes).digest('hex') !== files.get(path).sha256)
      throw new Error(`Web manifest changed after fingerprinting: ${path}`);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!object(value)) throw new Error(`Invalid web manifest: ${path}`);
    return value;
  }
  const manifest = await json('client/.vite/manifest.json');
  const entries = Object.entries(manifest);
  if (!entries.length || entries.length > 4096) throw new Error('Invalid bounded web manifest');
  for (const [key, entry] of entries) {
    if (!key || key.length > 2048 || !object(entry) || !safeAsset(entry.file)) throw new Error('Invalid web asset path in manifest');
    requireFile('client/' + entry.file);
    for (const field of ['css', 'assets']) {
      const paths = entry[field] ?? [];
      if (!Array.isArray(paths) || paths.length > 4096) throw new Error('Invalid bounded web manifest assets');
      for (const path of paths) {
        if (!safeAsset(path)) throw new Error('Invalid web asset path in manifest');
        requireFile('client/' + path);
      }
    }
    for (const field of ['imports', 'dynamicImports']) {
      const imports = entry[field] ?? [];
      if (!Array.isArray(imports) || imports.length > 4096 || imports.some(key => typeof key !== 'string' || !Object.hasOwn(manifest, key)))
        throw new Error('Unresolved web manifest dependency');
    }
  }
  const browser = manifest['virtual:vinext-app-browser-entry'];
  const entry = await json('client/vinext-client-entry-manifest.json');
  if (!object(browser) || entry.appBrowserEntry !== browser.file) throw new Error('Web manifest browser entry does not match its build dependency');
}
