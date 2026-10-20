'use client';
import { createWebCryptoIdentityStore } from '@uynis-connect/connect';
import type { EndpointIdentity } from '@uynis-connect/connect';
import { useCallback, useEffect, useRef, useState } from 'react';

type Phase = 'loading' | 'missing' | 'ready' | 'error';
type Store = ReturnType<typeof createWebCryptoIdentityStore>;
/** Browser UI owns one namespace/store; stale async operations cannot replace its key view. */
export function useEndpointIdentity(namespace: string) {
  const [state, setState] = useState<{ namespace: string; phase: Phase; identity?: EndpointIdentity }>({ namespace, phase: 'loading' });
  const owned = useRef<{ namespace: string; store: Store } | undefined>(undefined);
  const operation = useRef(0);
  const load = useCallback(() => {
    const version = ++operation.current;
    owned.current?.store.close();
    const selected = { namespace, store: createWebCryptoIdentityStore({ databaseName: namespace }) };
    owned.current = selected;
    return Promise.resolve().then(() => selected.store.load()).then(identity => {
      if (owned.current === selected && operation.current === version) setState({ namespace, phase: identity ? 'ready' : 'missing', identity });
    }, () => { if (owned.current === selected && operation.current === version) setState({ namespace, phase: 'error' }); });
  }, [namespace]);
  const reload = useCallback(async () => { setState({ namespace, phase: 'loading' }); await load(); }, [namespace, load]);
  useEffect(() => {
    const ownership = owned, sequence = operation;
    void load();
    return () => {
      const latest = ownership.current; ownership.current = undefined; sequence.current++;
      latest?.store.close();
    };
  }, [load]);
  const create = async () => {
    const selected = owned.current; if (!selected || selected.namespace !== namespace) return;
    const version = ++operation.current; setState({ namespace, phase: 'loading' });
    try {
      const identity = await selected.store.create();
      if (owned.current === selected && operation.current === version) setState({ namespace, phase: 'ready', identity });
    } catch { if (owned.current === selected && operation.current === version) setState({ namespace, phase: 'error' }); }
  };
  const remove = async () => {
    const selected = owned.current; if (!selected || selected.namespace !== namespace) return;
    const version = ++operation.current;
    const expected = state.namespace === namespace ? state.identity?.keyId : undefined;
    setState({ namespace, phase: 'loading' });
    try {
      await selected.store.remove(expected);
      if (owned.current === selected && operation.current === version) setState({ namespace, phase: 'missing' });
    } catch { if (owned.current === selected && operation.current === version) setState({ namespace, phase: 'error' }); }
  };
  return { ...(state.namespace === namespace ? state : { namespace, phase: 'loading' as const }), create, remove, reload };
}
