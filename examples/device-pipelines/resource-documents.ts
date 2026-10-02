import { chunkResource, createAssetReference, readVerifiedResource } from '@101/connect';
import type { ResourceReadRequest } from '@101/connect';

/** Deterministic local byte sources; there is no implicit URL or file read. */
export async function runResourceDocumentExample() {
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  const textBytes = encoder.encode('Hello from a bounded resource.');
  const jsonBytes = encoder.encode(JSON.stringify({ title: '101 resource example', revision: 1 }));
  const textReference = await createAssetReference('document:greeting', 'text', textBytes);
  const jsonReference = await createAssetReference('document:metadata', 'json-document', jsonBytes);
  const scope = { principalId: 'resource-owner', applicationId: 'document-viewer', sessionId: 'embedded-documents' };
  const approved = new Map([textReference, jsonReference].map(reference => [reference.id, reference]));
  const authorize = (request: Readonly<ResourceReadRequest>) =>
    request.principalId === scope.principalId && request.applicationId === scope.applicationId &&
    request.sessionId === scope.sessionId && approved.get(request.reference.id)?.sha256 === request.reference.sha256 &&
    approved.get(request.reference.id)?.byteLength === request.reference.byteLength &&
    approved.get(request.reference.id)?.kind === request.reference.kind
      ? { expiresAt: 60000, maxBytes: 65536 } : undefined;
  const read = (reference: typeof textReference, bytes: Uint8Array, principalId = scope.principalId) =>
    readVerifiedResource({ reference, chunks: chunkResource(bytes, 7), signal: new AbortController().signal,
      now: () => 1000, ...scope, principalId, authorize });
  const text = decoder.decode(await read(textReference, textBytes));
  const document = JSON.parse(decoder.decode(await read(jsonReference, jsonBytes))) as { title: string };
  let denied = false, corrupted = false, cancelled = false;
  try { await read(textReference, textBytes, 'visitor'); } catch { denied = true; }
  try {
    const changed = Uint8Array.from(textBytes); changed[0] = 'h'.charCodeAt(0);
    await read(textReference, changed);
  } catch { corrupted = true; }
  const controller = new AbortController();
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const stalled = { [Symbol.asyncIterator]() { return {
    next() { entered(); return new Promise<IteratorResult<never>>(() => {}); },
    return() { return Promise.resolve({ done: true as const, value: undefined }); },
  }; } };
  const reading = readVerifiedResource({ reference: textReference, chunks: stalled, signal: controller.signal,
    now: () => 1000, ...scope, authorize });
  await pending;
  controller.abort();
  try { await reading; } catch { cancelled = true; }
  return Object.freeze({ kind: 'embedded-simulated-resource', text, documentTitle: document.title,
    denied, corrupted, cancelled });
}
