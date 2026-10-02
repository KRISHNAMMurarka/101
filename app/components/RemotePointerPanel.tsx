'use client';

import { decodeManualPeerCode, encodeManualPeerCode, PeerDataTransport } from '@101/connect';
import type { InputFrame } from '@101/input';
import { createGamePointerReceiver, INPUT_LAB_POINTER_MANIFEST } from '@/examples/device-pipelines/game-pointer-bridge';
import { useCallback, useEffect, useRef, useState } from 'react';

type Receiver = ReturnType<typeof createGamePointerReceiver>;
type Connection = { peer: PeerDataTransport; receiver: Receiver; dispose: () => void };
const EMPTY = { described: false, clockReady: false, active: 0, stopped: false };

/** Application-owned consent and explicit classic/player-1 mapping for this developer diagnostic. */
export default function RemotePointerPanel({ sessionId, acceptFrame, removeDevice }: {
  sessionId: string; acceptFrame: (frame: InputFrame) => boolean; removeDevice: (deviceId: string, playerId: string) => void;
}) {
  const [offer, setOffer] = useState('');
  const [answer, setAnswer] = useState('');
  const [message, setMessage] = useState('Paste an offer from a pointer source you control.');
  const [snapshot, setSnapshot] = useState(EMPTY);
  const connection = useRef<Connection | null>(null);
  const generation = useRef(0);
  const stop = useCallback((update = true) => {
    generation.current++;
    const previous = connection.current; connection.current = null; previous?.dispose();
    if (update) { setAnswer(''); setSnapshot({ ...EMPTY, stopped: true }); setMessage('Stopped. Aim is neutral and trigger is released. Use a fresh offer to continue.'); }
  }, []);
  useEffect(() => {
    const blur = () => { if (connection.current?.receiver.bridge.state().approved) stop(); };
    const hidden = () => { if (document.hidden && connection.current?.receiver.bridge.state().approved) stop(); };
    const leave = () => stop(false);
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', leave); stop(false); };
  }, [stop, sessionId]);

  const acceptOffer = async () => {
    stop(false); setSnapshot(EMPTY); setAnswer('');
    const id = generation.current;
    let peer: PeerDataTransport | undefined;
    try {
      const code = decodeManualPeerCode(offer, 'offer');
      peer = new PeerDataTransport({ initiator: false });
      const selectedPeer = peer;
      const receiver = createGamePointerReceiver({ peer, epoch: code.epoch, manifest: INPUT_LAB_POINTER_MANIFEST,
        scope: { applicationId: INPUT_LAB_POINTER_MANIFEST.game, sessionId, playerId: 'player-1', roleId: 'classic',
          deviceId: `remote-pointer-${code.epoch}`, clockDomain: `input-lab:${code.epoch}` },
        mapping: { vector: 'aim', action: 'trigger', coordinates: 'normalized-to-signed', source: 'custom' },
        emit: acceptFrame, removeDevice, now: () => performance.now() });
      const refresh = () => {
        if (connection.current?.peer !== selectedPeer) return;
        receiver.tick();
        const state = receiver.receiver.status(), bridge = receiver.bridge.state();
        if (state.stopped || bridge.stopped || selectedPeer.state === 'failed' || selectedPeer.state === 'disconnected') {
          stop(); setMessage('Connection ended. Aim is neutral and trigger is released. Use a fresh offer.'); return;
        }
        const next = { described: !!receiver.receiver.description(), clockReady: state.clockReady, active: state.active, stopped: false };
        setSnapshot(previous => previous.described === next.described && previous.clockReady === next.clockReady && previous.active === next.active && !previous.stopped ? previous : next);
        if (state.active === 2) setMessage('Allowed for one minute: player 1, Classic Controller; aim and trigger only.');
      };
      const detach = peer.onStateChange(state => {
        if (connection.current?.peer !== selectedPeer) return;
        if (state === 'failed' || state === 'disconnected') { stop(); setMessage('Connection lost. Aim is neutral and trigger is released. Use a fresh offer.'); }
        else if (state === 'connected') setMessage('Connected. Review the mapping and allow the two resources.');
      });
      const timer = window.setInterval(refresh, 10);
      connection.current = { peer, receiver, dispose() { clearInterval(timer); detach(); receiver.stop(); void selectedPeer.disconnect(); } };
      setMessage('Preparing a local answer…');
      const description = await peer.acceptOffer(code.description);
      if (generation.current !== id) return;
      setAnswer(encodeManualPeerCode(code.epoch, description));
      setMessage('Copy the answer to the source. Connection does not grant control: choose Allow aim and trigger after reviewing the mapping.');
    } catch {
      if (generation.current === id) { stop(); void peer?.disconnect(); setMessage('Could not use this offer. Paste a complete fresh offer and try again.'); }
    }
  };
  const allow = () => {
    try {
      if (!connection.current?.receiver.select()) { stop(); setMessage('Resources could not be allowed. Use a fresh offer.'); return; }
      setMessage('Resources approved for player 1 / Classic Controller.');
    } catch { stop(); setMessage('Resources could not be allowed. Use a fresh offer.'); }
  };
  return <details className='linked-card'>
    <summary>Remote pointer resources</summary>
    <p>Source: native pointer lab or browser <a href='/pointer-lab'>Pointer lab</a> in Send pointer mode.</p>
    <p>Application scope: <strong>player 1 · Classic Controller</strong>. Position maps to aim with x = 2x − 1 and y = 2y − 1. Contact maps to trigger. This software resource uses the custom input source. Movement controls remain available locally.</p>
    <p>Hand-transferred codes are a possession diagnostic and do not verify endpoint identity. Share only with a source you control.</p>
    <label htmlFor='input-lab-pointer-offer'>Offer from source</label>
    <textarea id='input-lab-pointer-offer' value={offer} onChange={event => setOffer(event.target.value)} maxLength={65536}
      spellCheck={false} rows={3} style={{ width: '100%', minWidth: 0 }} />
    <button className='outline-button' onClick={() => void acceptOffer()}>Use offer</button>
    {answer ? <>
      <label htmlFor='input-lab-pointer-answer'>Answer to copy to source</label>
      <textarea id='input-lab-pointer-answer' value={answer} readOnly spellCheck={false} rows={3} style={{ width: '100%', minWidth: 0 }} />
      <button className='outline-button' onClick={() => void navigator.clipboard.writeText(answer)
        .then(() => setMessage('Answer copied. Paste it into the source.'))
        .catch(() => setMessage('Select and copy the answer from its field.'))}>Copy answer</button>
    </> : null}
    <button className='outline-button' onClick={allow} disabled={!snapshot.described || !snapshot.clockReady || snapshot.active > 0 || snapshot.stopped}>Allow aim and trigger for one minute</button>
    <button className='outline-button' onClick={() => stop()}>Stop remote pointer</button>
    <p role='status' aria-live='polite' data-testid='game-pointer-status'>{message}</p>
  </details>;
}
