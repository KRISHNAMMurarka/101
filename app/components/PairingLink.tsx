"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { copyInvitationLink, type InvitationCopyResult } from '../lib/invitation-copy';

/** Copy only a current invitation; retain the pending native write through withdrawal. */
export function PairingLink({ url = '', expiresAt = 0 }: { url?: string; expiresAt?: number }) {
  const id = useId(), field = useRef<HTMLInputElement>(null);
  const generation = useRef(0), mounted = useRef(false), reserved = useRef(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{url:string; phase:InvitationCopyResult} | undefined>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // This counter fences async completions; it is not a captured DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, []);
  useEffect(() => { generation.current++; }, [url, expiresAt]);

  const copy = async () => {
    if (reserved.current || !url) return;
    const revision = generation.current;
    const current = () => mounted.current && revision === generation.current && Date.now() < expiresAt;
    if (!current()) return;
    reserved.current = true; setPending(true); setResult(undefined);
    try {
      const phase = await copyInvitationLink({ url, isCurrent: current, writeText(text) {
        // Native clipboard access is requested only by this explicit button press.
        return navigator.clipboard?.writeText(text);
      } });
      if (phase === 'stopped' || !current()) return;
      setResult({url,phase});
      if (phase === 'manual') { field.current?.focus(); field.current?.select(); }
    } finally {
      reserved.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const phase = result?.url === url ? result.phase : undefined;
  return <>
    <div className="pair-link">
      <label className="sr-only" htmlFor={`${id}-link`}>Controller link</label>
      <input ref={field} id={`${id}-link`} value={url} readOnly spellCheck={false} autoComplete="off"
        aria-describedby={`${id}-status`} placeholder="Connect to make a link" onFocus={event => event.currentTarget.select()} />
      <button type="button" style={{minHeight:44}} disabled={!url || pending} onClick={() => void copy()}>
        {pending ? 'Copying…' : phase === 'copied' ? 'Copied' : 'Copy'}
      </button>
    </div>
    <p id={`${id}-status`} className="device-note" role="status" aria-live="polite">
      {pending ? 'Waiting for permission to copy. You can select and copy the link yourself.' :
        phase === 'manual' ? 'Copying is unavailable. The link is selected; copy it yourself, or scan the code.' :
          phase === 'copied' ? 'Link copied. Open it on your other device before the code expires.' :
            url ? 'Copy this link or scan the code on your other device.' : 'Choose a connection address to make a link.'}
    </p>
  </>;
}
