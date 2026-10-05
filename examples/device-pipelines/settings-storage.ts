import { createSettingsStore, type SettingsStorage } from '@101/connect';

/** The default port is a simulation. Supply an atomic durable port for actual persistence. */
export async function runSettingsStorageExample(storage?: SettingsStorage) {
  const records = new Map<string, string>();
  const port = storage ?? {
    async read(key: string) { return records.get(key); },
    async compareAndSwap(key: string, expected: string | undefined, value: string) {
      if (records.get(key) !== expected) return false;
      records.set(key, value); return true;
    },
  };
  let devices = ['example-sensor'];
  const options = { ownerId: 'example-owner', storage: port, availableDevices: () => devices };
  const store = createSettingsStore(options);
  const fresh = await store.load();
  const preferences = { theme: 'dark', handedness: 'left', motion: 'reduce' };
  const saved = await store.save(0, { preferences, profiles: [{ id: 'desk', deviceId: 'example-sensor',
    profileId: 'example:scalar', profileRevision: 1, calibration: { scale: 2, offset: -1 } }] });
  const reloaded = await createSettingsStore(options).load();
  const authority = await store.save(1, { preferences, profiles: [], grants: [{ expiresAt: 9999 }] });
  devices = [];
  const pruned = await store.load();
  const reset = await store.reset();
  return Object.freeze({ simulatedStorage: storage === undefined, fresh: fresh.ok && fresh.status === 'fresh',
    saved: saved.ok, reloaded: reloaded.ok && reloaded.value.revision === 1 && reloaded.value.profiles.length === 1,
    authorityRejected: !authority.ok && authority.reason === 'invalid',
    removedDevicePruned: pruned.ok && pruned.status === 'pruned' && pruned.value.profiles.length === 0,
    reset: reset.ok && reset.value.profiles.length === 0 });
}
