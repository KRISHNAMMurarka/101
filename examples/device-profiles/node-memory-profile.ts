import { parseConnectorProfileManifest } from '@101/connect';
import type { ConnectorProfileManifest } from '@101/connect';

export const NODE_MEMORY_REVIEWED_SHA256 = '7bb4137d774b85ad461413962e9f95cf1cb67679a49d4cf21bb7c8ea8f09c59b';

/** The caller supplies the verified digest of the one fixed reviewed local module. */
export function createNodeMemoryProfile(codeSha256: string = NODE_MEMORY_REVIEWED_SHA256): Readonly<ConnectorProfileManifest> {
  return parseConnectorProfileManifest({
    schemaVersion: 1, id: 'example:node-memory', version: '1.0.0',
    decoder: { id: 'example:node-memory-jsonl', version: '1.0.0', codeSha256 },
    identityFilters: [{ field: 'backendId', equals: 'node-memory' }, { field: 'wireVersion', equals: 1 }],
    framing: { kind: 'jsonl', maxFrameBytes: 4096, maxChunkBytes: 8192, maxFramesPerPush: 16 },
    resources: [
      { capability: { id: 'resident', semantic: 'example:resident-memory', schemaVersion: 1, kind: 'sample',
        value: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER },
        delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 1000 }, permissions: ['subscribe'] },
        direction: 'source', calibration: { revision: 1, unit: 'By', maxAbsoluteErrorBound: 0 }, command: null },
      { capability: { id: 'enabled', semantic: 'example:sampling-enabled', schemaVersion: 1, kind: 'event',
        value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: ['subscribe'] },
        direction: 'source', calibration: null, command: null },
      { capability: { id: 'sampling', semantic: 'example:sampling-enabled', schemaVersion: 1, kind: 'command',
        value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: ['invoke'], ownership: { mode: 'exclusive' } },
        direction: 'sink', calibration: null, command: { idempotent: true, deadlineMs: 1000,
          feedback: ['dispatched', 'target-acknowledged', 'observed'], observedState: 'enabled', safeState: false } },
    ], budgets: { maxBufferedBytes: 4096, maxOutputsPerFrame: 8, maxPendingCommands: 4, maxCommandBytes: 1024, callbackTimeoutMs: 1000 },
    license: 'MIT',
  });
}
