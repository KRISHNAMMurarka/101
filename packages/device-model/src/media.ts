import { DeviceValidationError, snapshotJson } from './descriptor.ts';
import type { JsonObject } from './descriptor.ts';

export interface MediaRange { readonly min: number; readonly max: number }
export interface AudioProperties { readonly sampleRateHz: MediaRange; readonly channels: MediaRange }
export interface VideoProperties { readonly widthPx: MediaRange; readonly heightPx: MediaRange; readonly frameRateHz: MediaRange }
export interface VideoGeometry { readonly widthPx: number; readonly heightPx: number; readonly pixelRatio: number }
export type MediaTrackDescription = Readonly<{
  type: 'track'; id: string; media: 'audio' | 'video'; direction: 'capture' | 'output'; codecs: readonly string[];
} & ({ media: 'audio'; audio: AudioProperties } | { media: 'video'; video: VideoProperties })>;
export interface RenderTargetDescription {
  readonly type: 'render-target'; readonly id: string; readonly media: 'video'; readonly geometry: VideoGeometry;
}
export interface MediaManifest {
  readonly schemaVersion: 1; readonly id: string;
  readonly tracks: readonly MediaTrackDescription[];
  readonly renderTargets: readonly RenderTargetDescription[];
}
export interface MediaEndpointProbe {
  readonly resourceId: string; readonly registrationId: string; readonly state: 'available' | 'unavailable' | 'busy' | 'denied';
  readonly codecs: readonly string[];
  readonly audio?: Readonly<{ sampleRateHz: number; channels: number }>;
  readonly video?: Readonly<{ widthPx: number; heightPx: number; frameRateHz: number }>;
  readonly geometry?: VideoGeometry;
}
export interface MediaHostProbe { readonly source: MediaEndpointProbe; readonly target: MediaEndpointProbe }
export type MediaBindingResult =
  | { readonly ok: true; readonly value: Readonly<{ sourceId: string; targetId: string; sourceRegistrationId: string;
      targetRegistrationId: string; codec: string; audio?: MediaEndpointProbe['audio']; video?: MediaEndpointProbe['video'] }> }
  | { readonly ok: false; readonly reason: 'incompatible' | 'unavailable' | 'codec' | 'geometry' | 'probe' };

const ID = /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REGISTRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MIME = /^(audio|video)\/[a-z0-9][a-z0-9.+-]*$/;
function fail(code: string, path = '$'): never { throw new DeviceValidationError(code, path); }
function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('media-object', path);
  return value as JsonObject;
}
function closed(value: JsonObject, keys: readonly string[], path: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !keys.includes(key))) fail('media-fields', path);
}
function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 128 || !ID.test(value)) fail('media-id', path);
  return value;
}
function finite(value: unknown, min: number, max: number, path: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value))
    fail('media-range', path);
  return value;
}
function range(input: unknown, max: number, path: string, integer = false): MediaRange {
  const value = object(input, path); closed(value, ['min', 'max'], path);
  const min = finite(value.min, 1, max, `${path}.min`, integer);
  const upper = finite(value.max, min, max, `${path}.max`, integer);
  return Object.freeze({ min, max: upper });
}
function audio(input: unknown, path: string): AudioProperties {
  const value = object(input, path); closed(value, ['sampleRateHz', 'channels'], path);
  return Object.freeze({ sampleRateHz: range(value.sampleRateHz, 384000, `${path}.sampleRateHz`, true),
    channels: range(value.channels, 32, `${path}.channels`, true) });
}
function video(input: unknown, path: string): VideoProperties {
  const value = object(input, path); closed(value, ['widthPx', 'heightPx', 'frameRateHz'], path);
  return Object.freeze({ widthPx: range(value.widthPx, 16384, `${path}.widthPx`, true),
    heightPx: range(value.heightPx, 16384, `${path}.heightPx`, true),
    frameRateHz: range(value.frameRateHz, 240, `${path}.frameRateHz`) });
}
function geometry(input: unknown, path: string): VideoGeometry {
  const value = object(input, path); closed(value, ['widthPx', 'heightPx', 'pixelRatio'], path);
  return Object.freeze({ widthPx: finite(value.widthPx, 1, 16384, `${path}.widthPx`, true),
    heightPx: finite(value.heightPx, 1, 16384, `${path}.heightPx`, true),
    pixelRatio: finite(value.pixelRatio, 0.25, 8, `${path}.pixelRatio`) });
}
function codecList(input: unknown, media: 'audio' | 'video', path: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(input) || input.length > 8 || !allowEmpty && input.length === 0) fail('media-codecs', path);
  const codecs = input.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length > 64 || !MIME.test(entry) || !entry.startsWith(`${media}/`))
      fail('media-codec', `${path}[${index}]`);
    return entry;
  });
  if (new Set(codecs).size !== codecs.length) fail('media-codecs', path);
  return Object.freeze(codecs);
}

/** Closed immutable static descriptions. They never include a ready or working claim. */
export function parseMediaManifest(input: unknown): Readonly<MediaManifest> {
  const copied = snapshotJson(input);
  const root = object(copied, '$'); closed(root, ['schemaVersion', 'id', 'tracks', 'renderTargets'], '$');
  if (root.schemaVersion !== 1) fail('media-version');
  const manifestId = id(root.id, '$.id');
  if (!Array.isArray(root.tracks) || !Array.isArray(root.renderTargets) ||
      root.tracks.length + root.renderTargets.length < 1 || root.tracks.length + root.renderTargets.length > 32)
    fail('media-count');
  const tracks = root.tracks.map((entry, index) => {
    const path = `$.tracks[${index}]`, value = object(entry, path);
    const kind = value.media;
    if (value.type !== 'track' || kind !== 'audio' && kind !== 'video' ||
        value.direction !== 'capture' && value.direction !== 'output') fail('media-track', path);
    closed(value, ['type', 'id', 'media', 'direction', 'codecs', kind], path);
    const codecs = codecList(value.codecs, kind, `${path}.codecs`);
    return Object.freeze({ type: 'track' as const, id: id(value.id, `${path}.id`), media: kind,
      direction: value.direction, codecs, ...(kind === 'audio' ? { audio: audio(value.audio, `${path}.audio`) } :
        { video: video(value.video, `${path}.video`) }) }) as MediaTrackDescription;
  });
  const renderTargets = root.renderTargets.map((entry, index) => {
    const path = `$.renderTargets[${index}]`, value = object(entry, path);
    closed(value, ['type', 'id', 'media', 'geometry'], path);
    if (value.type !== 'render-target' || value.media !== 'video') fail('media-target', path);
    return Object.freeze({ type: 'render-target' as const, id: id(value.id, `${path}.id`), media: 'video' as const,
      geometry: geometry(value.geometry, `${path}.geometry`) });
  });
  const ids = [manifestId, ...tracks.map(track => track.id), ...renderTargets.map(target => target.id)];
  if (new Set(ids).size !== ids.length) fail('media-duplicate-id');
  return Object.freeze({ schemaVersion: 1, id: manifestId, tracks: Object.freeze(tracks), renderTargets: Object.freeze(renderTargets) });
}

function probe(input: unknown, media: 'audio' | 'video', shape: 'audio' | 'video' | 'geometry'): MediaEndpointProbe | undefined {
  try {
    const value = object(input, '$.probe');
    closed(value, ['resourceId', 'registrationId', 'state', 'codecs', shape], '$.probe');
    const resourceId = id(value.resourceId, '$.probe.resourceId');
    if (typeof value.registrationId !== 'string' || value.registrationId.length > 128 || !REGISTRATION_ID.test(value.registrationId))
      fail('media-registration', '$.probe.registrationId');
    const registrationId = value.registrationId;
    if (!['available', 'unavailable', 'busy', 'denied'].includes(value.state as string)) return;
    const codecs = codecList(value.codecs, media, '$.probe.codecs', true);
    const selected = object(value[shape], `$.probe.${shape}`);
    if (shape === 'audio') {
      closed(selected, ['sampleRateHz', 'channels'], '$.probe.audio');
      return Object.freeze({ resourceId, registrationId, state: value.state as MediaEndpointProbe['state'], codecs,
        audio: Object.freeze({ sampleRateHz: finite(selected.sampleRateHz, 1, 384000, '$.probe.audio.sampleRateHz', true),
          channels: finite(selected.channels, 1, 32, '$.probe.audio.channels', true) }) });
    }
    if (shape === 'video') {
      closed(selected, ['widthPx', 'heightPx', 'frameRateHz'], '$.probe.video');
      return Object.freeze({ resourceId, registrationId, state: value.state as MediaEndpointProbe['state'], codecs,
        video: Object.freeze({ widthPx: finite(selected.widthPx, 1, 16384, '$.probe.video.widthPx', true),
          heightPx: finite(selected.heightPx, 1, 16384, '$.probe.video.heightPx', true),
          frameRateHz: finite(selected.frameRateHz, 1, 240, '$.probe.video.frameRateHz') }) });
    }
    return Object.freeze({ resourceId, registrationId, state: value.state as MediaEndpointProbe['state'], codecs,
      geometry: geometry(selected, '$.probe.geometry') });
  } catch { return; }
}

function inside(value: number, bounds: MediaRange): boolean { return value >= bounds.min && value <= bounds.max; }
const no = (reason: Extract<MediaBindingResult, { ok: false }>['reason']): MediaBindingResult => Object.freeze({ ok: false, reason });

/** A host-owned proposal only; no track is opened or media effect claimed. */
export function planMediaBinding(input: unknown, sourceId: string, targetId: string, host: MediaHostProbe): MediaBindingResult {
  const manifest = parseMediaManifest(input);
  const source = manifest.tracks.find(track => track.id === sourceId && track.direction === 'capture');
  const target = manifest.tracks.find(track => track.id === targetId && track.direction === 'output') ??
    manifest.renderTargets.find(entry => entry.id === targetId);
  if (!source || !target || source.media !== target.media || source.id === target.id) return no('incompatible');
  let hostValue: JsonObject;
  try {
    hostValue = object(snapshotJson(host), '$.host');
    closed(hostValue, ['source', 'target'], '$.host');
  } catch { return no('probe'); }
  const sourceProbe = probe(hostValue.source, source.media, source.media);
  const targetProbe = probe(hostValue.target, target.media, target.type === 'render-target' ? 'geometry' : target.media);
  if (!sourceProbe || !targetProbe || sourceProbe.resourceId !== source.id || targetProbe.resourceId !== target.id ||
      sourceProbe.registrationId === targetProbe.registrationId) return no('probe');
  if (sourceProbe.state !== 'available' || targetProbe.state !== 'available') return no('unavailable');
  const codecs = source.codecs.filter(codec => sourceProbe.codecs.includes(codec) && targetProbe.codecs.includes(codec) &&
    (target.type === 'render-target' || target.codecs.includes(codec)));
  const codec = codecs[0];
  if (codec === undefined) return no('codec');
  if (source.media === 'video') {
    const actual = sourceProbe.video;
    if (!actual || !inside(actual.widthPx, source.video.widthPx) || !inside(actual.heightPx, source.video.heightPx) ||
        !inside(actual.frameRateHz, source.video.frameRateHz)) return no('geometry');
    if (target.type === 'render-target') {
      const planned = target.geometry, available = targetProbe.geometry;
      if (!available || available.widthPx !== planned.widthPx || available.heightPx !== planned.heightPx ||
          available.pixelRatio !== planned.pixelRatio || actual.widthPx !== planned.widthPx || actual.heightPx !== planned.heightPx)
        return no('geometry');
    } else if (!targetProbe.video || target.media !== 'video' ||
        !inside(actual.widthPx, target.video.widthPx) || !inside(actual.heightPx, target.video.heightPx) ||
        !inside(actual.frameRateHz, target.video.frameRateHz) || JSON.stringify(actual) !== JSON.stringify(targetProbe.video)) return no('geometry');
    return Object.freeze({ ok: true, value: Object.freeze({ sourceId, targetId,
      sourceRegistrationId: sourceProbe.registrationId, targetRegistrationId: targetProbe.registrationId,
      codec, video: Object.freeze({ ...actual }) }) });
  }
  if (target.type !== 'track' || target.media !== 'audio' || !sourceProbe.audio || !targetProbe.audio ||
      !inside(sourceProbe.audio.sampleRateHz, source.audio.sampleRateHz) || !inside(sourceProbe.audio.channels, source.audio.channels) ||
      !inside(sourceProbe.audio.sampleRateHz, target.audio.sampleRateHz) || !inside(sourceProbe.audio.channels, target.audio.channels) ||
      sourceProbe.audio.sampleRateHz !== targetProbe.audio.sampleRateHz || sourceProbe.audio.channels !== targetProbe.audio.channels)
    return no('geometry');
  return Object.freeze({ ok: true, value: Object.freeze({ sourceId, targetId,
    sourceRegistrationId: sourceProbe.registrationId, targetRegistrationId: targetProbe.registrationId,
    codec, audio: Object.freeze({ ...sourceProbe.audio }) }) });
}
