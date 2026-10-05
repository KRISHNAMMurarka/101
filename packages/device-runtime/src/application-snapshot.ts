import { DeviceValidationError, parseAssetReference, parseWorkloadRequirements, snapshotJson, verifyAssetContent } from '@101/device-model';
import type { AssetReference, JsonValue, WorkloadRequirements } from '@101/device-model';

export interface ApplicationSnapshot {
  readonly schemaVersion: 1;
  readonly application: Readonly<{ id: string; version: string; codeSha256: string }>;
  readonly formatVersion: number;
  /** Processor internals never resume from application state. */
  readonly processorState: 'reset-on-resume';
  readonly assets: readonly Readonly<AssetReference>[];
  readonly state: JsonValue;
}
export type SnapshotRestoreResult = Readonly<{ ok: true; state: JsonValue; processorState: 'reset-on-resume' }> |
  Readonly<{ ok: false; reason: 'snapshot-disabled' | 'incompatible-snapshot' | 'invalid-state';
    alternative: 'cold-restart' }> |
  Readonly<{ ok: false; reason: 'missing-assets'; alternative: 'install-assets-then-cold-restart' }>;

const cold = (reason: 'snapshot-disabled' | 'incompatible-snapshot' | 'invalid-state'): SnapshotRestoreResult =>
  Object.freeze({ ok: false, reason, alternative: 'cold-restart' });
const missing = (): SnapshotRestoreResult =>
  Object.freeze({ ok: false, reason: 'missing-assets', alternative: 'install-assets-then-cold-restart' });
function fail(path: string): never { throw new DeviceValidationError('snapshot-invalid', path); }
function object(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path);
  return input as Record<string, unknown>;
}
function exact(input: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(input).sort().join('\0') !== [...keys].sort().join('\0')) fail(path);
}
function sameAsset(left: AssetReference, right: AssetReference): boolean {
  return left.id === right.id && left.kind === right.kind && left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength && left.sha256 === right.sha256;
}
function parseSnapshot(input: unknown): ApplicationSnapshot {
  const value = object(snapshotJson(input), '$.snapshot');
  exact(value, ['schemaVersion', 'application', 'formatVersion', 'processorState', 'assets', 'state'], '$.snapshot');
  if (value.schemaVersion !== 1 || value.processorState !== 'reset-on-resume' ||
      typeof value.formatVersion !== 'number' || !Number.isSafeInteger(value.formatVersion) || value.formatVersion < 1)
    fail('$.snapshot');
  const application = object(value.application, '$.snapshot.application');
  exact(application, ['id', 'version', 'codeSha256'], '$.snapshot.application');
  if (typeof application.id !== 'string' || typeof application.version !== 'string' ||
      typeof application.codeSha256 !== 'string') fail('$.snapshot.application');
  if (!Array.isArray(value.assets) || value.assets.length > 32) fail('$.snapshot.assets');
  const assets = value.assets.map(parseAssetReference);
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) fail('$.snapshot.assets');
  return Object.freeze({ schemaVersion: 1, application: Object.freeze({ id: application.id,
    version: application.version, codeSha256: application.codeSha256 }), formatVersion: value.formatVersion,
    processorState: 'reset-on-resume', assets: Object.freeze(assets), state: value.state as JsonValue });
}
function compatible(snapshot: ApplicationSnapshot, workload: WorkloadRequirements): boolean {
  return workload.restart.mode === 'snapshot' && snapshot.application.id === workload.id &&
    snapshot.application.version === workload.version &&
    snapshot.application.codeSha256 === workload.application.codeSha256 &&
    snapshot.formatVersion === workload.restart.formatVersion &&
    snapshot.assets.length === workload.assets.length &&
    snapshot.assets.every(asset => workload.assets.some(required => sameAsset(asset, required)));
}

/** Captures only bounded app-owned JSON; the caller must pause mutation and validate its own state schema. */
export function createApplicationSnapshot(workloadInput: unknown, context: unknown, stateInput: unknown): Readonly<ApplicationSnapshot> {
  const workload = parseWorkloadRequirements(workloadInput, context);
  if (workload.restart.mode !== 'snapshot') fail('$.restart');
  const state = snapshotJson(stateInput);
  return Object.freeze({ schemaVersion: 1, application: Object.freeze({ id: workload.id, version: workload.version,
    codeSha256: workload.application.codeSha256 }), formatVersion: workload.restart.formatVersion,
    processorState: 'reset-on-resume', assets: Object.freeze([...workload.assets]), state });
}

/** Returns app state only after pin, format, state-schema and required asset-byte checks. */
export async function restoreApplicationSnapshot(
  workloadInput: unknown, context: unknown, snapshotInput: unknown, availableAssets: unknown,
  validateState: (state: JsonValue) => boolean,
): Promise<SnapshotRestoreResult> {
  const workload = parseWorkloadRequirements(workloadInput, context);
  if (workload.restart.mode !== 'snapshot') return cold('snapshot-disabled');
  if (typeof validateState !== 'function') fail('$.validateState');
  let snapshot: ApplicationSnapshot;
  try { snapshot = parseSnapshot(snapshotInput); } catch { return cold('incompatible-snapshot'); }
  if (!compatible(snapshot, workload)) return cold('incompatible-snapshot');
  try { if (validateState(snapshot.state) !== true) return cold('invalid-state'); }
  catch { return cold('invalid-state'); }
  if (!Array.isArray(availableAssets) || availableAssets.length > 64) return missing();
  for (const required of workload.assets) {
    let verified = false;
    for (const entry of availableAssets) {
      try {
        const value = object(entry, '$.availableAssets[]');
        exact(value, ['reference', 'bytes'], '$.availableAssets[]');
        const reference = Object.getOwnPropertyDescriptor(value, 'reference');
        const bytes = Object.getOwnPropertyDescriptor(value, 'bytes');
        if (!reference || !Object.hasOwn(reference, 'value') || !bytes || !Object.hasOwn(bytes, 'value') ||
            !sameAsset(parseAssetReference(reference.value), required)) continue;
        if (await verifyAssetContent(required, bytes.value)) { verified = true; break; }
      } catch { /* Bad or absent local bytes cannot satisfy the required asset. */ }
    }
    if (!verified) return missing();
  }
  return Object.freeze({ ok: true, state: snapshot.state, processorState: 'reset-on-resume' });
}
