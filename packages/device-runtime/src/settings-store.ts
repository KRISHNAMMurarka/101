import { snapshotJson } from '@101/device-model';

/** The adapter must compare and replace within one atomic storage transaction. */
export interface SettingsStorage {
  read(key: string): Promise<string | undefined>;
  compareAndSwap(key: string, expected: string | undefined, value: string): Promise<boolean>;
}
export interface SettingsPreferences {
  readonly theme: 'system' | 'light' | 'dark';
  readonly handedness: 'left' | 'right';
  readonly motion: 'system' | 'reduce';
}
export interface StoredProfileChoice {
  readonly id: string; readonly deviceId: string; readonly profileId: string; readonly profileRevision: number;
  readonly calibration: Readonly<{ scale: number; offset: number }>;
}
export interface SettingsDocument {
  readonly version: 2; readonly ownerId: string; readonly revision: number;
  readonly preferences: SettingsPreferences; readonly profiles: readonly StoredProfileChoice[];
}
export type SettingsResult = Readonly<{ ok: true; value: SettingsDocument; status: 'fresh' | 'loaded' | 'migrated' | 'pruned' | 'saved' | 'reset' }> |
  Readonly<{ ok: false; reason: 'invalid' | 'corrupt' | 'incompatible' | 'wrong-owner' | 'rollback' | 'conflict' | 'unavailable' }>;
export interface SettingsStore {
  readonly key: string;
  load(): Promise<SettingsResult>;
  save(expectedRevision: number, choices: unknown): Promise<SettingsResult>;
  removeDevice(deviceId: string): Promise<SettingsResult>;
  /** Explicitly discard this owner's saved choices, including corrupt/future data. Grants are never stored. */
  reset(): Promise<SettingsResult>;
}
export interface SettingsStoreOptions {
  readonly ownerId: string; readonly storage: SettingsStorage;
  /** Trusted current inventory; it is not read from a backup or settings record. */
  readonly availableDevices: () => readonly string[];
  /** Optional trusted rollback floor retained outside the settings backup. */
  readonly minimumRevision?: number;
}
type Failure = Extract<SettingsResult, { ok: false }>['reason'];
class InvalidSettings extends Error {
  readonly reason: Failure;
  constructor(reason: Failure) { super(reason); this.reason = reason; }
}
function fail(reason: Failure): never { throw new InvalidSettings(reason); }
const result = (reason: Failure): SettingsResult => Object.freeze({ ok: false, reason });
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('corrupt');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail('corrupt');
}
function choices(input: unknown, legacy = false): Pick<SettingsDocument, 'preferences' | 'profiles'> {
  const value = object(snapshotJson(input)); exact(value, ['preferences', 'profiles']);
  const p = object(value.preferences); exact(p, legacy ? ['theme', 'handedness'] : ['theme', 'handedness', 'motion']);
  if (!['system', 'light', 'dark'].includes(p.theme as string) || !['left', 'right'].includes(p.handedness as string) ||
    !legacy && p.motion !== 'system' && p.motion !== 'reduce') fail('corrupt');
  if (!Array.isArray(value.profiles) || value.profiles.length > 8) fail('corrupt');
  const seen = new Set<string>();
  const profiles = value.profiles.map(input => {
    const profile = object(input); exact(profile, ['id', 'deviceId', 'profileId', 'profileRevision', 'calibration']);
    if (!id(profile.id) || !id(profile.deviceId) || !id(profile.profileId) || !integer(profile.profileRevision) ||
      profile.profileRevision < 1 || seen.has(profile.id)) fail('corrupt');
    seen.add(profile.id);
    const c = object(profile.calibration); exact(c, ['scale', 'offset']);
    if (typeof c.scale !== 'number' || !Number.isFinite(c.scale) || Math.abs(c.scale) < 0.000001 || Math.abs(c.scale) > 1000000 ||
      typeof c.offset !== 'number' || !Number.isFinite(c.offset) || Math.abs(c.offset) > 1000000) fail('corrupt');
    return Object.freeze({ id: profile.id, deviceId: profile.deviceId, profileId: profile.profileId,
      profileRevision: profile.profileRevision, calibration: Object.freeze({ scale: c.scale, offset: c.offset }) });
  });
  return Object.freeze({ preferences: Object.freeze({ theme: p.theme as SettingsPreferences['theme'],
    handedness: p.handedness as SettingsPreferences['handedness'], motion: legacy ? 'system' : p.motion as SettingsPreferences['motion'] }),
  profiles: Object.freeze(profiles) });
}
function document(ownerId: string, revision: number, value: Pick<SettingsDocument, 'preferences' | 'profiles'>): SettingsDocument {
  return Object.freeze({ version: 2, ownerId, revision, preferences: value.preferences, profiles: value.profiles });
}
const defaults = () => choices({ preferences: { theme: 'system', handedness: 'right', motion: 'system' }, profiles: [] });

/** Preferences/profile pins only. No identities, grants, invitations, live values or executable descriptions. */
export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  if (!id(options.ownerId) || typeof options.storage?.read !== 'function' || typeof options.storage?.compareAndSwap !== 'function' ||
    typeof options.availableDevices !== 'function' || options.minimumRevision !== undefined && !integer(options.minimumRevision))
    throw new TypeError('Invalid settings storage scope');
  const owner = options.ownerId, port = options.storage, inventory = options.availableDevices, key = `101.settings:${owner}`;
  let highest = options.minimumRevision ?? 0;
  function devices(): Set<string> {
    let list: readonly string[];
    try { list = inventory(); } catch { return fail('unavailable'); }
    if (!Array.isArray(list) || list.length > 128 || list.some(value => !id(value)) || new Set(list).size !== list.length) fail('unavailable');
    return new Set(list);
  }
  async function readRaw(): Promise<string | undefined> {
    try { return await port.read(key); } catch { return fail('unavailable'); }
  }
  async function read() {
    const raw = await readRaw();
    if (raw === undefined) {
      if (highest > 0) fail('rollback');
      return { raw, value: document(owner, 0, defaults()), legacy: false, fresh: true };
    }
    if (typeof raw !== 'string' || raw.length > 4096 || new TextEncoder().encode(raw).length > 4096) fail('corrupt');
    const value = object(snapshotJson(JSON.parse(raw)));
    if (value.ownerId !== owner) fail('wrong-owner');
    if (value.version !== 1 && value.version !== 2) fail('incompatible');
    exact(value, ['version', 'ownerId', 'revision', 'preferences', 'profiles']);
    if (!integer(value.revision)) fail('corrupt');
    if (value.revision < highest) fail('rollback');
    const parsed = document(owner, value.revision, choices({ preferences: value.preferences, profiles: value.profiles }, value.version === 1));
    highest = Math.max(highest, parsed.revision);
    return { raw, value: parsed, legacy: value.version === 1, fresh: false };
  }
  function next(revision: number): number { if (revision >= Number.MAX_SAFE_INTEGER) fail('unavailable'); return revision + 1; }
  async function write(expected: string | undefined, value: SettingsDocument, status: Extract<SettingsResult, { ok: true }>['status']): Promise<SettingsResult> {
    let encoded: string;
    try { encoded = JSON.stringify(snapshotJson(value)); } catch { return result('invalid'); }
    if (encoded.length > 4096 || new TextEncoder().encode(encoded).length > 4096) return result('invalid');
    let accepted: boolean;
    try { accepted = await port.compareAndSwap(key, expected, encoded); } catch { return result('unavailable'); }
    if (accepted !== true) return result('conflict');
    highest = Math.max(highest, value.revision);
    return Object.freeze({ ok: true, value, status });
  }
  async function attempt(operation: () => Promise<SettingsResult>, invalid: Failure = 'corrupt'): Promise<SettingsResult> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof InvalidSettings) return result(error.reason);
      // Parser errors carry no backend/private messages into the public result.
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof Error && error.name === 'DeviceValidationError') return result(invalid);
      return result('unavailable');
    }
  }
  return Object.freeze<SettingsStore>({
    key,
    load: () => attempt(async () => {
      const stored = await read(), available = devices();
      const profiles = stored.value.profiles.filter(profile => available.has(profile.deviceId));
      const pruned = profiles.length !== stored.value.profiles.length;
      if (stored.legacy || pruned) return write(stored.raw, document(owner, next(stored.value.revision),
        { preferences: stored.value.preferences, profiles: Object.freeze(profiles) }), stored.legacy ? 'migrated' : 'pruned');
      return Object.freeze({ ok: true, value: stored.value, status: stored.fresh ? 'fresh' : 'loaded' });
    }),
    save: (expectedRevision, input) => attempt(async () => {
      if (!integer(expectedRevision)) return result('invalid');
      let selected: ReturnType<typeof choices>;
      try { selected = choices(input); } catch { return result('invalid'); }
      const available = devices();
      if (selected.profiles.some(profile => !available.has(profile.deviceId))) return result('invalid');
      const stored = await read();
      if (stored.value.revision !== expectedRevision) return result('conflict');
      return write(stored.raw, document(owner, next(stored.value.revision), selected), 'saved');
    }),
    removeDevice: deviceId => attempt(async () => {
      if (!id(deviceId)) return result('invalid');
      const stored = await read();
      return write(stored.raw, document(owner, next(stored.value.revision), { preferences: stored.value.preferences,
        profiles: Object.freeze(stored.value.profiles.filter(profile => profile.deviceId !== deviceId)) }), 'saved');
    }),
    reset: () => attempt(async () => {
      const raw = await readRaw();
      if (typeof raw === 'string' && raw.length <= 4096) {
        try {
          const header = object(snapshotJson(JSON.parse(raw)));
          if (id(header.ownerId) && header.ownerId !== owner) fail('wrong-owner');
          if (header.ownerId === owner && integer(header.revision)) highest = Math.max(highest, header.revision);
        } catch (error) {
          if (error instanceof InvalidSettings && error.reason === 'wrong-owner') throw error;
          // Explicit reset recovers malformed choices only within this owner's key.
        }
      }
      return write(raw, document(owner, next(highest), defaults()), 'reset');
    }),
  });
}

export interface IndexedDbSettingsStorage extends SettingsStorage { close(): void }
/** One durable readwrite transaction performs each compare-and-swap. Uses only the caller's local database. */
export function createIndexedDbSettingsStorage(factory: IDBFactory, databaseName = '101-owner-settings'): IndexedDbSettingsStorage {
  if (!factory || typeof factory.open !== 'function' || !id(databaseName)) throw new TypeError('Invalid settings database');
  let retired = false;
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('settings'); };
    request.onerror = () => reject(new Error('Settings storage unavailable'));
    request.onblocked = () => { retired = true; reject(new Error('Settings storage unavailable')); };
    request.onsuccess = () => {
      const db = request.result;
      if (retired || !db.objectStoreNames.contains('settings')) { db.close(); reject(new Error('Settings storage unavailable')); return; }
      db.onversionchange = () => { retired = true; db.close(); };
      resolve(db);
    };
  });
  void database.catch(() => { /* Availability is returned by the first explicit operation. */ });
  async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, set: (value: T) => void) => void): Promise<T> {
    const db = await database;
    if (retired) throw new Error('Settings storage unavailable');
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('settings', mode); let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(new Error('Settings storage unavailable'));
      try { run(tx.objectStore('settings'), next => { value = next; }); } catch { tx.abort(); }
    });
  }
  return Object.freeze<IndexedDbSettingsStorage>({
    read: key => transaction<string | undefined>('readonly', (store, set) => {
      const request = store.get(key);
      request.onsuccess = () => { if (request.result !== undefined && typeof request.result !== 'string') { request.transaction?.abort(); return; } set(request.result as string | undefined); };
    }),
    compareAndSwap: (key, expected, value) => transaction<boolean>('readwrite', (store, set) => {
      const request = store.get(key);
      request.onsuccess = () => { if (request.result !== expected) { set(false); return; } store.put(value, key); set(true); };
    }),
    close() { retired = true; void database.then(db => db.close()).catch(() => {}); },
  });
}
