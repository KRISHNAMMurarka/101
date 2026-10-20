// Bounded local privacy observer for an explicitly owned software canvas.
// Unsupported values or exceeded bounds fail the check rather than imply absence.
import { createBrowserScreenPreviewPipeline } from '/screen-preview-caller.mjs';

const LIMIT = Object.freeze({ localKeys: 64, localValueChars: 4096, databases: 16, stores: 32,
  records: 128, valueNodes: 2048, valueDepth: 6, serializedValueChars: 65536,
  cacheNames: 16, cacheRequests: 64, cacheBodyBytes: 65536, consoleEvents: 64, consoleChars: 4096 });
const fail = message => { throw new Error('S15 preview privacy check: ' + message); };
const bounded = (value, max, label) => { if (value.length > max) fail(label + ' exceeded observation bound'); return value; };
function flatten(value, depth = 0, budget = { left: LIMIT.valueNodes }, seen = new Set()) {
  if (--budget.left < 0 || depth > LIMIT.valueDepth) fail('value traversal bound');
  if (typeof value === 'string') return [bounded(value, LIMIT.serializedValueChars, 'observed string')];
  if (value === null || ['number', 'boolean', 'undefined', 'bigint'].includes(typeof value)) return [];
  if (typeof value !== 'object' || seen.has(value)) fail('unsupported or cyclic observed value');
  seen.add(value);
  try {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (bytes.length > LIMIT.valueNodes) fail('observed byte bound');
      return [Array.from(bytes).join(',')];
    }
    if (value instanceof Blob) fail('Blob value cannot be inspected by this observer');
    if (value instanceof Map) {
      if (value.size > LIMIT.valueNodes) fail('Map bound');
      return [...value].flatMap(([key, item]) => [...flatten(key, depth + 1, budget, seen), ...flatten(item, depth + 1, budget, seen)]);
    }
    if (value instanceof Set) {
      if (value.size > LIMIT.valueNodes) fail('Set bound');
      return [...value].flatMap(item => flatten(item, depth + 1, budget, seen));
    }
    if (Array.isArray(value)) {
      if (value.length > LIMIT.valueNodes) fail('array bound');
      const descriptors = Object.getOwnPropertyDescriptors(value), extra = [];
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || !('value' in descriptors[key])) fail('unsupported array key or accessor');
        if (key !== 'length' && !(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)) {
          extra.push(bounded(key, LIMIT.serializedValueChars, 'array key'), ...flatten(descriptors[key].value, depth + 1, budget, seen));
        }
      }
      const output = value.flatMap(item => flatten(item, depth + 1, budget, seen));
      // Preserve numeric spans even when the surrounding record contains metadata.
      let span = [];
      const flush = () => { if (span.length) output.push(span.join(',')); span = []; };
      for (const item of value) { if (typeof item === 'number' && Number.isFinite(item)) span.push(item); else flush(); }
      flush(); output.push(...extra);
      // The observed preview producer emits a finite numeric row array.
      if (value.every(row => Array.isArray(row) && row.every(item => typeof item === 'number' && Number.isFinite(item)))) output.push(bounded(JSON.stringify(value), LIMIT.serializedValueChars, 'numeric rows'));
      return output;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('unsupported observed object');
    const descriptors = Object.getOwnPropertyDescriptors(value), output = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !('value' in descriptors[key])) fail('unsupported key or accessor');
      output.push(bounded(key, LIMIT.serializedValueChars, 'object key'), ...flatten(descriptors[key].value, depth + 1, budget, seen));
    }
    return output;
  } finally { seen.delete(value); }
}
function inspectPrivacyValue(value) { return flatten(value); }
function entries(storage, label) {
  if (!storage) fail(label + ' unavailable');
  if (storage.length > LIMIT.localKeys) fail(label + ' key bound');
  const result = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index); if (key === null) fail(label + ' changed during snapshot');
    const value = storage.getItem(key); if (value === null) fail(label + ' changed during snapshot');
    result.push([bounded(key, 256, label + ' key'), bounded(value, LIMIT.localValueChars, label + ' value')]);
  }
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}
function openDb(name) {
  return new Promise((resolve, reject) => { const request = indexedDB.open(name); request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
}
async function idbSnapshot() {
  if (!globalThis.indexedDB || typeof indexedDB.databases !== 'function') fail('IndexedDB enumeration unavailable; no privacy pass can be reported');
  const databases = await indexedDB.databases(); if (databases.length > LIMIT.databases) fail('IndexedDB database bound');
  const found = [];
  for (const descriptor of databases) {
    if (!descriptor.name) continue;
    const db = await openDb(descriptor.name);
    try {
      const names = [...db.objectStoreNames]; if (names.length > LIMIT.stores) fail('IndexedDB store bound');
      for (const name of names) {
        const values = await new Promise((resolve, reject) => {
          const transaction = db.transaction(name, 'readonly'), request = transaction.objectStore(name).getAll(undefined, LIMIT.records + 1);
          request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
        });
        if (values.length > LIMIT.records) fail('IndexedDB record bound');
        found.push({ database: descriptor.name, store: name, strings: values.flatMap(value => flatten(value)) });
      }
    } finally { db.close(); }
  }
  return found;
}
async function cacheSnapshot() {
  if (!globalThis.caches) fail('CacheStorage unavailable; no privacy pass can be reported');
  const names = await caches.keys(); if (names.length > LIMIT.cacheNames) fail('CacheStorage name bound');
  const found = [];
  for (const name of names) {
    const cache = await caches.open(name), requests = await cache.keys();
    if (requests.length > LIMIT.cacheRequests) fail('CacheStorage request bound');
    for (const request of requests) {
      const response = await cache.match(request); if (!response) fail('CacheStorage changed during snapshot');
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > LIMIT.cacheBodyBytes) fail('CacheStorage body bound');
      let text = ''; try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { /* Binary bodies are covered by byte signatures below. */ }
      found.push({ cache: name, url: bounded(request.url, 2048, 'CacheStorage full request URL'), text, bytes: Array.from(body).join(',') });
    }
  }
  return found;
}
async function snapshot() {
  return { local: entries(localStorage, 'localStorage'), session: entries(sessionStorage, 'sessionStorage'),
    indexedDB: await idbSnapshot(), cacheStorage: await cacheSnapshot() };
}
function representations(rows) {
  const bytes = Uint8Array.from(rows.flat());
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return [JSON.stringify(rows), Array.from(bytes).join(','), btoa(binary)];
}
function findText(snapshotValue, needle) {
  const json = JSON.stringify(snapshotValue);
  return json.includes(needle);
}
function scanRaster(snapshotValue, variants) { return variants.some(variant => variant.length > 0 && findText(snapshotValue, variant)); }
function waitUntil(predicate, label, advance = () => {}) {
  const deadline = performance.now() + 2500;
  return new Promise((resolve, reject) => {
    const poll = () => { try { advance(); if (predicate()) return resolve(); if (performance.now() >= deadline) return reject(new Error(label + ' deadline')); setTimeout(poll, 20); } catch (error) { reject(error); } };
    poll();
  });
}
async function deleteOwnedDatabase(dbName) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    const deadline = setTimeout(() => reject(new Error('Owned database deletion deadline')), 2500);
    request.onsuccess = () => { clearTimeout(deadline); resolve(); };
    request.onerror = () => { clearTimeout(deadline); reject(request.error ?? new Error('Owned database deletion failed')); };
    // A blocked request is still pending. Only native success permits readback.
    request.onblocked = () => {};
  });
  if ((await indexedDB.databases()).some(item => item.name === dbName)) fail('owned database still enumerated after deletion');
}
async function positiveControl(rasterVariants, rows) {
  const nonce = crypto.randomUUID(), marker = 'S15-OWNED-SENTINEL-' + nonce;
  const localKey = 's15-local-' + nonce, sessionKey = 's15-session-' + nonce;
  const dbName = 's15-owned-' + nonce, cacheName = 's15-owned-' + nonce, cacheUrl = '/s15-owned-' + nonce;
  let db;
  try {
    localStorage.setItem(localKey, marker); sessionStorage.setItem(sessionKey, marker);
    db = await new Promise((resolve, reject) => { const request = indexedDB.open(dbName, 1); request.onupgradeneeded = () => request.result.createObjectStore('sentinel'); request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
    await new Promise((resolve, reject) => { const transaction = db.transaction('sentinel', 'readwrite'); const store = transaction.objectStore('sentinel'); store.put(marker, 'marker');
      store.put(rows.flat(), 'numeric-array'); store.put(rows, 'nested-raster'); store.put({ [rasterVariants[1]]: 'owned' }, 'object-key');
      store.put(new Map([[rasterVariants[1], rows.flat()]]), 'map'); store.put(new Set([rows.flat()]), 'set'); store.put(Uint8Array.from(rows.flat()), 'typed-bytes'); store.put(Object.assign([], { raster: rasterVariants[1] }), 'array-own-property'); store.put([...rows.flat(), 'owned'], 'heterogeneous-array'); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    await (await caches.open(cacheName)).put(cacheUrl, new Response(marker));
    console.log(marker);
    console.log({ ownedPrivacyRaster: rows });
    console.log(new Map([[rasterVariants[1], 'owned-positive-control']]));
    console.log(new Set([Uint8Array.from(rows.flat())]));
    console.log('S15-ARRAY-OWN-PROPERTY', Object.assign([], { raster: rasterVariants[1] }));
    console.log('S15-HETEROGENEOUS-ARRAY', [...rows.flat(), 'owned']);
    const observed = await snapshot();
    if (!observed.local.some(([, value]) => value === marker)) fail('positive control missed localStorage');
    if (!observed.session.some(([, value]) => value === marker)) fail('positive control missed sessionStorage');
    const stored = observed.indexedDB.find(item => item.database === dbName);
    if (!stored?.strings.includes(marker) || !rasterVariants.slice(0, 2).every(item => stored.strings.includes(item))) fail('positive control missed structured IndexedDB raster');
    if (!observed.cacheStorage.some(item => item.cache === cacheName && item.text === marker)) fail('positive control missed CacheStorage');
    return { detected: ['localStorage', 'sessionStorage', 'IndexedDB', 'CacheStorage'], consoleControlText: marker, markerSha256: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(marker)).then(bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('')) };
  } finally {
    db?.close(); localStorage.removeItem(localKey); sessionStorage.removeItem(sessionKey);
    if (!await caches.delete(cacheName)) fail('owned cache was not deleted');
    await deleteOwnedDatabase(dbName);
    if (localStorage.getItem(localKey) !== null || sessionStorage.getItem(sessionKey) !== null || (await caches.keys()).includes(cacheName)) fail('owned persistent container remains');
    const afterCleanup = await snapshot(); if (findText(afterCleanup, marker) || findText(afterCleanup, nonce)) fail('positive-control persistent artifacts remain after owned cleanup');
  }
}

export async function prepareS15PreviewPrivacyObservation() {
  const baseline = await snapshot();
  if (baseline.local.length || baseline.session.length || baseline.indexedDB.length || baseline.cacheStorage.length) fail('fresh isolated origin is not empty; refusing ambiguous baseline');
  return baseline;
}

export async function runS15PreviewPrivacyObservation(baseline) {
  if (!baseline || !Array.isArray(baseline.local) || !Array.isArray(baseline.session) || !Array.isArray(baseline.indexedDB) || !Array.isArray(baseline.cacheStorage)) fail('prepared baseline missing');
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function' || typeof HTMLVideoElement.prototype.requestVideoFrameCallback !== 'function') return { result: 'unsupported', reason: 'owned-canvas media APIs unavailable', nativeScreenCaptureQualified: false };
  const producer = document.createElement('canvas'), preview = document.createElement('canvas'); producer.width = 64; producer.height = 48; preview.width = 8; preview.height = 8;
  const paint = producer.getContext('2d'), readback = preview.getContext('2d'); if (!paint || !readback) fail('Canvas2D unavailable');
  paint.fillStyle = '#ff0000'; let producerFrames = 0, drawInFlight = false;
  const draw = () => { drawInFlight = true; try { paint.fillRect(0, 0, producer.width, producer.height); producerFrames++; } finally { drawInFlight = false; } };
  draw();
  const stream = producer.captureStream(10), track = stream.getVideoTracks()[0]; if (!track) fail('owned canvas track unavailable');
  const owner = new AbortController(), capture = new AbortController(); let opens = 0, approvals = 0;
  const environment = { fixtureKind: 'owned-canvas-fixture', getDisplayMedia(constraints) { opens++; if (JSON.stringify(constraints) !== JSON.stringify({ video: true, audio: false })) fail('unexpected display constraint'); return Promise.resolve(stream); },
    createVideo: () => document.createElement('video'), createCanvas: () => document.createElement('canvas'), MediaStream, HTMLVideoElement, HTMLCanvasElement, ImageData,
    target: window, document, hidden: () => document.hidden, focused: () => document.hasFocus(), secureContext: () => isSecureContext, userActivation: () => navigator.userActivation?.isActive === true };
  const pipeline = createBrowserScreenPreviewPipeline({ ownerSignal: owner.signal, environment, preview,
    authorizeCapture(request) { approvals++; return { request, signal: capture.signal, expiresAt: performance.now() + 12000 }; },
    authorizeRoutes(request) { if (request.principalId === 'screen-owner' && request.applicationId === 'screen-example' && request.sessionId === 'screen-session' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write') return { expiresAt: performance.now() + 12000, maxAgeMs: 250, maxHz: 10 }; } });
  const frameTimer = setInterval(draw, 100);
  let final;
  try {
    const activation = pipeline.activate('s15-selected-preview-privacy-check');
    const started = await activation; if (!started.ok) fail('capture failed: ' + started.reason);
    await waitUntil(() => producerFrames >= 2 && pipeline.state().delivered > 0 && pipeline.state().latest !== undefined, 'nonempty authorized raster after a subsequent owned canvas frame', () => pipeline.tick());
    const rows = pipeline.state().latest?.value?.rows; if (!rows || rows.length !== 8 || rows.some(row => row.length !== 32)) fail('expected bounded delivered raster missing');
    const rasterVariants = representations(rows), observed = await snapshot();
    if (scanRaster(observed, rasterVariants)) fail('exact sampled raster representation appeared in an observed persistent/cache sink');
    pipeline.stop(); await waitUntil(() => pipeline.state().latest === undefined && pipeline.state().released > 0, 'revocation release');
    const afterRevoke = await snapshot(); if (scanRaster(afterRevoke, rasterVariants)) fail('exact sampled raster remained in an observed sink after revoke');
    await pipeline.close(); owner.abort();
    const afterClose = await snapshot(); if (scanRaster(afterClose, rasterVariants)) fail('exact sampled raster remained in an observed sink after close');
    if (opens !== 1 || approvals !== 1 || !track.readyState || track.readyState !== 'ended') fail('owned capture or cleanup evidence incomplete');
    // The host closes the absence window before deliberate positive console controls.
    console.log('S15-PRIVACY-ABSENCE-WINDOW-CLOSED');
    const control = await positiveControl(rasterVariants, rows);
    const finalProvider = pipeline.provider.snapshot();
    if (finalProvider.phase !== 'closed' || finalProvider.activeSources !== 0 || finalProvider.rawPending !== 0 || finalProvider.listeners !== 0 || finalProvider.cleanupFailures !== 0) fail('provider did not report closed and quiescent');
    const previewBytesZero = Array.from(readback.getImageData(0, 0, 8, 8).data).every(value => value === 0); if (!previewBytesZero) fail('caller-owned preview canvas did not clear');
    final = { result: 'pass', source: 'actual public browser provider/runtime pipeline with explicitly owned canvas captureStream', nativeScreenCaptureQualified: false,
      deliveredRaster: { width: 8, height: 8, nonempty: true, signaturesChecked: ['JSON rows', 'decimal byte sequence', 'base64 bytes'] },
      consoleAuditForHost: { rasterVariants, positiveControlText: control.consoleControlText }, observations: ['fresh-origin baseline prepared before user activation', 'after authorized sample', 'after revoke and release', 'after close'], sinks: ['origin localStorage key/value pairs', 'origin sessionStorage key/value pairs', 'enumerable IndexedDB values including numeric arrays, plain object keys, Map keys/values and Set values', 'CacheStorage full bounded request URLs and bounded response bodies', 'Playwright console text and bounded actual structured arguments'],
      positiveControl: { detected: control.detected, markerSha256: control.markerSha256, ownedStorageArtifactsRemoved: true }, cleanup: { ownedCaptureOpens: opens, captureApprovals: approvals, trackEnded: track.readyState === 'ended', previewBytesZero, provider: finalProvider },
      limits: ['String controls cover each selected sink; native structured IndexedDB and console controls exercise the newly supported forms. Arbitrary transformations remain unobserved.', 'IndexedDB traversal is bounded and fails closed on unsupported enumeration, Blob values or bounds; CacheStorage response bodies are bounded.', 'The host inspects console text and bounded supported structured arguments; unsupported values or failed serialization fail closed. Exact selected raster encodings are checked, not every possible transformed/hash/encrypted representation, browser-internal cache, OS log, crash dump or forensic residue.', 'Consumer-held transient observations before revoke are allowed; no claim of erasure or absence from memory is made.', 'The producer is a software-owned canvas stream. No OS chooser, physical capture, hardware freshness or screen permission claim.'] };
    return final;
  } finally {
    clearInterval(frameTimer); await new Promise(resolve => setTimeout(resolve, 0));
    if (drawInFlight) fail('owned canvas draw callback did not settle');
    owner.abort(); capture.abort(); await pipeline.close().catch(() => {}); stream.getTracks().forEach(item => item.stop());
    producer.width = 1; producer.height = 1; preview.width = 1; preview.height = 1; producer.remove(); preview.remove();
    delete globalThis.__s15RecordConsole;
  }
}

export { inspectPrivacyValue };
