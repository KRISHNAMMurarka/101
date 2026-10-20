import { createIndexedDbOwnerDataStorage, createOwnerDataController, createSettingsStore } from '@uynis-connect/connect';
import type { OwnerDataController, OwnerDataPorts, OwnerDataScope, OwnerDataStorage, SettingsDocument, SettingsResult, SettingsStore } from '@uynis-connect/connect';

export const SETTINGS_OWNER = 'app-player-settings:this-browser';
export const SETTINGS_DATABASE = 'app-player-settings-managed-v1';
export const SETTINGS_LIMITS = Object.freeze({ managementMs: 30000, sessions: 8, operations: 64, raw: 1 });
export type ThemeChoice = 'system' | 'light' | 'dark';
export type SettingsAction = 'manage' | 'save' | 'reset' | 'delete' | 'resume-delete';
type Message = 'arrival' | 'review' | 'loading' | 'ready' | 'saved' | 'reset' | 'deleted' | 'cancelled' | 'stopped' |
  'expired' | 'conflict' | 'corrupt' | 'incompatible' | 'wrong-owner' | 'unavailable' | 'pending-deletion' | 'limit';
export interface SettingsTaskState {
  readonly active: boolean; readonly pending: boolean; readonly message: Message;
  readonly theme: ThemeChoice; readonly revision?: number; readonly deadline?: number;
  readonly review?: Readonly<{ action: SettingsAction; token: object }>;
  readonly canSave: boolean; readonly canReset: boolean; readonly canDelete: boolean; readonly canResume: boolean;
}
export interface SettingsStorageSession { readonly storage: OwnerDataStorage; close(): Promise<void> }
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
// A newly mounted page cannot reuse this realm's fixed native storage while an
// earlier page still owns an unresolved opening or closing transaction.
const nativeSessions = new WeakMap<IDBFactory, Promise<void>>();

/** Delegates to the SDK's real atomic adapter. Only native open lifetime is added:
 * blocked/timeout is not a native terminal event and never releases the slot. */
export function createSettingsStorageSession(factory: IDBFactory = globalThis.indexedDB): SettingsStorageSession {
  if (!factory || nativeSessions.has(factory)) throw Error('unavailable');
  let retired = false, rawOpen: Promise<void> | undefined, opening = false, finishOpen: (() => void) | undefined;
  const operations = new Set<Promise<unknown>>();
  const nativeOpen = factory.open;
  const observed = Object.create(factory) as IDBFactory;
  Object.defineProperty(observed, 'open', { value(name: string, version?: number) {
    if (retired || opening || name !== SETTINGS_DATABASE || version !== 1) throw Error('unavailable');
    opening = true;
    rawOpen = new Promise<void>(resolve => { finishOpen = resolve; });
    let request: IDBOpenDBRequest;
    try { request = nativeOpen.call(factory, name, version); }
    catch (error) { opening = false; finishOpen?.(); throw error; }
    const terminal = () => {
      remove.call(request, 'success', terminal); remove.call(request, 'error', terminal);
      if (retired) { try { request.result.close(); } catch { /* Error has no database. */ } }
      opening = false; finishOpen?.();
    };
    // Native IDB events are queued; listeners coexist with the SDK's handlers.
    add.call(request, 'success', terminal, { once: true }); add.call(request, 'error', terminal, { once: true });
    return request;
  } });
  const adapter = createIndexedDbOwnerDataStorage({ databaseName: SETTINGS_DATABASE, indexedDB: observed });
  let finishSession!: () => void;
  const sessionLifetime = new Promise<void>(resolve => { finishSession = resolve; });
  nativeSessions.set(factory, sessionLifetime);
  const storage: OwnerDataStorage = Object.freeze({
    transact<T>(ownerId: string, mutation: (current: unknown) => { state: unknown; result: T }, guard?: Parameters<OwnerDataStorage['transact']>[2]): Promise<T> {
      if (retired) return Promise.reject(Error('unavailable'));
      const operation = adapter.transact(ownerId, mutation, guard);
      operations.add(operation); void operation.then(() => operations.delete(operation), () => operations.delete(operation));
      return operation;
    },
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({ storage, close() {
    if (closing) return closing;
    let finish!: () => void; closing = new Promise<void>(resolve => { finish = resolve; });
    retired = true; adapter.close();
    void Promise.allSettled([...operations, ...(rawOpen ? [rawOpen] : [])]).then(() => {
      if (nativeSessions.get(factory) === sessionLifetime) nativeSessions.delete(factory);
      finishSession(); finish();
    });
    return closing;
  } });
}

interface Lease {
  readonly generation: number; readonly abort: AbortController; readonly deadline: number;
  session?: SettingsStorageSession; owner?: OwnerDataController; ports?: OwnerDataPorts; store?: SettingsStore;
  document?: SettingsDocument; deletionId?: string; close?: Promise<void>; needsReload?: boolean;
}
interface Review { readonly action: SettingsAction; readonly token: object; readonly generation: number;
  readonly deadline: number; readonly theme: ThemeChoice; readonly revision?: number; readonly deletionId?: string }
export interface SettingsTask {
  snapshot(): SettingsTaskState;
  review(action: SettingsAction): object | undefined;
  decide(token: object, allow: boolean): Promise<void>;
  reload(): Promise<void>;
  chooseTheme(theme: ThemeChoice): void;
  cancelPreview(): void;
  stop(): void;
  close(): Promise<void>;
}
export interface SettingsTaskOptions {
  readonly now?: () => number;
  readonly createStorage?: () => SettingsStorageSession | Promise<SettingsStorageSession>;
  readonly onChange?: (state: SettingsTaskState) => void;
}
/** No identity, native opening, persisted choices or theme effect on construction. */
export function createSettingsTask(options: SettingsTaskOptions = {}): SettingsTask {
  const clock = options.now ?? Date.now, createStorage = options.createStorage ?? (() => createSettingsStorageSession());
  let closed = false, generation = 0, attempts = 0, operations = 0, lastNow = -1;
  let lease: Lease | undefined, review: Review | undefined, pending: Promise<void> | undefined, closing: Promise<void> | undefined;
  let retiredStorage: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let message: Message = 'arrival', theme: ThemeChoice = 'system';
  function snapshot(): SettingsTaskState {
    return Object.freeze({ active: !!lease, pending: !!pending || !!retiredStorage, message, theme,
      ...(lease?.document ? { revision: lease.document.revision } : {}), ...(lease ? { deadline: lease.deadline } : {}),
      ...(review ? { review: Object.freeze({ action: review.action, token: review.token }) } : {}),
      canSave: !!lease?.document && !lease.deletionId && !lease.needsReload, canReset: !!lease?.store && !lease.deletionId && message !== 'wrong-owner',
      canDelete: !!lease?.document && !lease.deletionId, canResume: !!lease?.deletionId });
  }
  function publish() { try { options.onChange?.(snapshot()); } catch { /* An observer cannot grant authority. */ } }
  function closeLease(value: Lease) {
    if (value.close) return value.close;
    value.abort.abort(); value.ports?.close(); value.owner?.close();
    value.ports = undefined; value.store = undefined;
    // A provisionally retired factory still owns its unresolved return. Its
    // eventual session must be closed, not mistaken for this empty placeholder.
    if (!value.session) return Promise.resolve();
    value.close = value.session.close();
    const raw = value.close; retiredStorage = raw;
    void raw.then(() => { if (retiredStorage === raw) { retiredStorage = undefined; publish(); } }, () => {
      // A failed cleanup is retained; another session cannot acquire its slot.
      message = 'unavailable'; publish();
    });
    return raw;
  }
  function retire(next: Message) {
    generation++; clearTimeout(timer); timer = undefined; review = undefined;
    const old = lease; lease = undefined; message = next; theme = 'system';
    if (old) closeLease(old); publish();
  }
  function now(): number {
    let time: unknown;
    try { time = clock(); } catch { retire('unavailable'); throw Error('unavailable'); }
    if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0 || time < lastNow) {
      retire('unavailable'); throw Error('unavailable');
    }
    lastNow = time; return time;
  }
  function current(value: Lease): boolean {
    if (closed || lease !== value || value.abort.signal.aborted) return false;
    let time: number; try { time = now(); } catch { return false; }
    if (closed || lease !== value || value.abort.signal.aborted) return false;
    if (time >= value.deadline) { retire('expired'); return false; }
    return true;
  }
  function arm(deadline: number, expected: number) {
    clearTimeout(timer); timer = undefined;
    let time: number; try { time = now(); } catch { return; }
    if (closed || generation !== expected) return;
    if (time >= deadline) { retire('expired'); return; }
    timer = setTimeout(() => { if (generation === expected && !closed) retire('expired'); }, deadline - time);
  }
  function grant(value: Lease, scope: OwnerDataScope) {
    if (!current(value) || scope.ownerId !== SETTINGS_OWNER) return undefined;
    let permitted = false;
    if (scope.action === 'open-stores') permitted = !review;
    if (scope.action === 'delete') permitted = review?.action === 'delete' && scope.request.purpose === 'player-settings-delete' &&
      Array.isArray(scope.request.kinds) && scope.request.kinds.length === 1 && scope.request.kinds[0] === 'settings';
    if (scope.action === 'resume-delete') permitted = review?.action === 'resume-delete' && scope.request.operationId === value.deletionId;
    if (!permitted || !current(value)) return undefined;
    return Object.freeze({ scope, expiresAt: Math.min(scope.deadline, value.deadline), signal: value.abort.signal,
      isCurrent: () => current(value) });
  }
  function guardedStorage(value: Lease, storage: OwnerDataStorage): OwnerDataStorage {
    return { async transact(owner, mutation, guard) {
      if (!current(value)) throw Error('unavailable');
      const commit = new AbortController(), abort = () => commit.abort();
      const signals = [value.abort.signal, ...(guard ? [guard.signal] : [])];
      try {
        for (const signal of signals) { add.call(signal, 'abort', abort, { once: true }); if (signal.aborted) abort(); }
        return await storage.transact(owner, mutation, { signal: commit.signal,
          isCurrent() { return current(value) && (!guard || guard.isCurrent()) && current(value) && !commit.signal.aborted; } });
      } finally { for (const signal of signals) remove.call(signal, 'abort', abort); }
    } };
  }
  function accept(value: Lease, result: SettingsResult) {
    if (!current(value)) return;
    if (result.ok) { value.document = result.value; value.needsReload = false; theme = result.value.preferences.theme;
      message = result.status === 'saved' ? 'saved' : result.status === 'reset' ? 'reset' : 'ready';
    } else {
      if (result.reason !== 'conflict') value.document = undefined; else value.needsReload = true;
      message = ['conflict', 'corrupt', 'incompatible', 'wrong-owner'].includes(result.reason) ? result.reason as Message : 'unavailable';
    }
  }
  function start(action: () => Promise<void>): Promise<void> {
    if (closed || pending || retiredStorage || operations >= SETTINGS_LIMITS.operations) {
      if (operations >= SETTINGS_LIMITS.operations) message = 'limit'; return Promise.resolve();
    }
    operations++;
    let finish!: () => void; const raw = new Promise<void>(resolve => { finish = resolve; }); pending = raw;
    publish();
    void Promise.resolve().then(action).catch(() => { if (!closed && lease) retire('unavailable'); }).finally(() => {
      if (pending === raw) pending = undefined; finish(); publish();
    });
    return raw;
  }
  async function manage(approved: Review) {
    if (closed || generation !== approved.generation || now() >= approved.deadline || generation !== approved.generation) return;
    if (++attempts > SETTINGS_LIMITS.sessions) { message = 'limit'; return; }
    const value: Lease = { generation, deadline: approved.deadline, abort: new AbortController() };
    lease = value; message = 'loading'; review = undefined; publish();
    if (!current(value)) return;
    const session = await createStorage(); value.session = session;
    if (!current(value)) { await closeLease(value); return; }
    value.owner = createOwnerDataController({ ownerId: SETTINGS_OWNER, storage: guardedStorage(value, session.storage), trustedNow: now,
      authorize: scope => grant(value, scope), availableDevices: () => [] });
    const opened = await value.owner.openStores({ retireOwned() { value.ports?.close(); value.ports = undefined; value.store = undefined; } });
    if (!current(value)) { await closeLease(value); return; }
    if (!opened.ok) {
      if (opened.reason === 'review-required') {
        const deletion = await value.owner.inspectDeletion();
        if (!current(value)) return;
        if (deletion.ok && deletion.value?.state === 'pending') { value.deletionId = deletion.value.operationId; message = 'pending-deletion'; arm(value.deadline, value.generation); return; }
      }
      retire(opened.reason === 'incompatible' || opened.reason === 'wrong-owner' ? opened.reason : 'unavailable'); return;
    }
    value.ports = opened.value;
    value.store = createSettingsStore({ ownerId: SETTINGS_OWNER, storage: opened.value.settings, availableDevices: () => [] });
    accept(value, await value.store.load()); if (current(value)) arm(value.deadline, value.generation);
  }
  const task: SettingsTask = {
    snapshot,
    review(action) {
      if (closed || pending || retiredStorage || review || !['manage', 'save', 'reset', 'delete', 'resume-delete'].includes(action)) return undefined;
      if (action === 'manage' ? !!lease : !lease || !current(lease)) return undefined;
      if (action === 'save' && (!lease?.document || lease.needsReload) || action === 'reset' && (!lease?.store || message === 'wrong-owner') ||
        action === 'delete' && !lease?.document || action === 'resume-delete' && !lease?.deletionId ||
        (action === 'save' || action === 'reset' || action === 'delete') && lease?.deletionId) return undefined;
      const expected = generation;
      let time: number; try { time = now(); } catch { return undefined; }
      if (closed || expected !== generation) return undefined;
      const token = Object.freeze({}); review = Object.freeze({ action, token, generation, deadline: lease?.deadline ?? time + SETTINGS_LIMITS.managementMs,
        theme, revision: lease?.document?.revision, deletionId: lease?.deletionId });
      message = 'review'; arm(review.deadline, generation); publish();
      return review?.token === token ? token : undefined;
    },
    decide(token, allow) {
      const approved = review;
      if (!approved || token !== approved.token || closed || pending || retiredStorage) return Promise.resolve();
      const expected = generation;
      let time: number; try { time = now(); } catch { return Promise.resolve(); }
      if (closed || expected !== generation || time >= approved.deadline) { if (!closed && expected === generation) retire('expired'); return Promise.resolve(); }
      if (allow !== true) { review = undefined; message = 'cancelled';
        if (!lease) { clearTimeout(timer); timer = undefined; } publish(); return Promise.resolve(); }
      return start(async () => {
        if (approved.action === 'manage') { await manage(approved); return; }
        const value = lease; if (!value || !current(value) || review !== approved) return;
        if (approved.action === 'save' && value.store && approved.revision !== undefined) {
          accept(value, await value.store.save(approved.revision, { preferences: { ...value.document!.preferences, theme: approved.theme }, profiles: [] }));
        } else if (approved.action === 'reset' && value.store) {
          // Valid unexposed choices are preserved. Producer reset is the
          // explicitly reviewed recovery for unreadable private preferences.
          const result = value.document
            ? await value.store.save(value.document.revision, { preferences: { ...value.document.preferences, theme: 'system' }, profiles: [] })
            : await value.store.reset();
          accept(value, result); if (result.ok && current(value)) message = 'reset';
        }
        else if (approved.action === 'delete' || approved.action === 'resume-delete') {
          const result = approved.action === 'delete'
            ? await value.owner!.beginDeletion({ kinds: ['settings'], purpose: 'player-settings-delete' })
            : await value.owner!.resumeDeletionReviewed(approved.deletionId!);
          if (!current(value)) return;
          if (result.ok && result.value.state === 'completed') { retire('deleted'); return; }
          const inspection = await value.owner!.inspectDeletion();
          if (!current(value)) return;
          if (inspection.ok && inspection.value?.state === 'pending') { value.deletionId = inspection.value.operationId; message = 'pending-deletion'; }
          else message = 'unavailable';
        }
        if (current(value)) review = undefined;
      });
    },
    reload() { return start(async () => { const value = lease; if (!value?.store || !current(value)) return;
      review = undefined; accept(value, await value.store.load()); }); },
    chooseTheme(value) { if (!['system', 'light', 'dark'].includes(value) || pending || review || !lease?.document || lease.needsReload || !current(lease)) return;
      theme = value; message = 'ready'; publish(); },
    cancelPreview() { if (lease?.document) theme = lease.document.preferences.theme; review = undefined; message = 'cancelled'; publish(); },
    stop() {
      if (closed) return;
      // Even a stopped-state clock callback can cancel provisional admission.
      // Avoid republishing an already retired state to a reentrant observer.
      if (!lease && !review && message === 'stopped') { generation++; return; }
      retire('stopped');
    },
    close() {
      if (closing) return closing;
      let finish!: () => void; closing = new Promise<void>(resolve => { finish = resolve; });
      closed = true; retire('stopped');
      void Promise.allSettled([...(pending ? [pending] : []), ...(retiredStorage ? [retiredStorage] : [])]).then(async () => {
        if (retiredStorage) await retiredStorage; finish();
      });
      return closing;
    },
  };
  return Object.freeze(task);
}

/** An explicitly owned preview; competing theme writes are preserved. */
export function createSettingsThemePreview(element: Pick<Element, 'getAttribute' | 'setAttribute' | 'removeAttribute'>) {
  const before = element.getAttribute('data-theme'); let owned: string | null | undefined;
  return Object.freeze({ apply(theme: ThemeChoice) {
    if (!['system', 'light', 'dark'].includes(theme)) return;
    owned = theme === 'system' ? null : theme;
    if (owned === null) element.removeAttribute('data-theme'); else element.setAttribute('data-theme', owned);
  }, restore() {
    if (owned !== undefined && element.getAttribute('data-theme') === owned) {
      if (before === null) element.removeAttribute('data-theme'); else element.setAttribute('data-theme', before);
    }
    owned = undefined;
  } });
}
