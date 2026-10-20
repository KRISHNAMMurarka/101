import type { Replay101 } from '../../sdk/src/replay.ts';

/** Explicit export only: never rewrites a native catalog, retention clock, or existing file. */
export function exportNativeRecording(replay: Readonly<Replay101>) {
  if (replay.schema !== 1 || !Array.isArray(replay.frames) || !Array.isArray(replay.events)) throw new Error('Expected a 101 schema 1 recording');
  return {
    schema: 2 as const, applicationId: replay.gameId, applicationVersion: replay.gameVersion,
    recordingId: replay.seed, startedAt: replay.startedAt,
    frames: replay.frames.map(frame => {
      const { deviceId, sequence, timestamp, source, receivedAt, ...value } = frame;
      return { deviceId, sequence, timestamp, source, ...(receivedAt === undefined ? {} : { receivedAt }), value: structuredClone(value) };
    }),
    events: replay.events.map(event => ({ timestamp: event.timestamp, type: event.type, ...(event.data === undefined ? {} : { data: structuredClone(event.data) }) })),
  };
}

/** 101 policy remains in Games; Connect only validates static application package metadata. */
export function exportNativeApplicationManifest(input: unknown, entry = 'index.html') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid game manifest');
  const value = input as Record<string, unknown>;
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128
      || typeof value.version !== 'string' || !value.version || value.version.length > 64
      || !['2d', '3d', 'dom', 'hybrid'].includes(value.renderer as string)
      || value.engine == null || !value.players || typeof value.players !== 'object' || Array.isArray(value.players)
      || !Array.isArray(value.inputs) || !value.inputs.length || value.offline !== true || value.procedural !== true) {
    throw new Error('Game package does not satisfy the 101 offline/procedural contract');
  }
  if (!entry || entry.length > 256 || entry.startsWith('/') || entry.includes('\\') || entry.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid application entry');
  return { id: value.id, name: value.name, version: value.version, entry };
}
