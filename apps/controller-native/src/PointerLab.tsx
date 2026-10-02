import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type NativeTouchEvent, type NativeSyntheticEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import { createNativePeerPort, decodeManualPeerCode, encodeManualPeerCode, PeerDataTransport, PointerResourceProvider, type PointerSourceDriver } from '@101/connect';
import { space, type, useTheme } from './theme.ts';
import { Button } from './ui.tsx';

type Session = {
  generation: number; epoch: string; peer: PeerDataTransport; provider: PointerResourceProvider;
  timer?: ReturnType<typeof setInterval>; unsubscribe?: () => void; answered: boolean;
  statsPending: boolean; lastStatsAt: number; missingStats: number;
};
function touchId(value: unknown): number | undefined {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

/** Local general pointer source, deliberately initiating its own native RTC channels. */
export default function PointerLab({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const mounted = useRef(false);
  const foreground = useRef(AppState.currentState === 'active');
  const generation = useRef(0);
  const session = useRef<Session | undefined>(undefined);
  const pad = useRef({ width: 0, height: 0 });
  const [status, setStatus] = useState('Create a connection to the local pointer receiver.');
  const [offer, setOffer] = useState('');
  const [answer, setAnswer] = useState('');
  const [active, setActive] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [details, setDetails] = useState(true);
  const [contact, setContact] = useState(false);

  const stop = useCallback((message?: string) => {
    generation.current++;
    const current = session.current;
    session.current = undefined;
    if (current) {
      if (current.timer !== undefined) clearInterval(current.timer);
      current.provider.stop();
      current.unsubscribe?.();
      void current.peer.disconnect().catch(() => { /* Authority has already been retired locally. */ });
    }
    if (mounted.current) {
      setActive(false); setReady(false); setBusy(false); setAnswered(false); setContact(false); setOffer(''); setAnswer('');
      if (message) setStatus(message);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (!foreground.current) stop('Connection stopped. Return here and create a fresh connection.');
    });
    return () => { mounted.current = false; stop(); subscription.remove(); };
  }, [stop]);
  const current = (value: Session) => mounted.current && session.current === value && generation.current === value.generation;

  const start = async () => {
    stop();
    if (!foreground.current || typeof globalThis.performance?.now !== 'function' || typeof RTCPeerConnection !== 'function') {
      setStatus('Touch control is unavailable. Keep this screen open and try again.'); return;
    }
    setBusy(true); setActive(true); setStatus('Creating a local connection…');
    const version = generation.current;
    let candidate: Session | undefined;
    try {
      const epoch = Array.from(Crypto.getRandomBytes(16), byte => byte.toString(16).padStart(2, '0')).join('');
      const peer = new PeerDataTransport({ initiator: true, createPeer: () => createNativePeerPort(
        new RTCPeerConnection({ iceServers: [] }), value => new RTCSessionDescription(value),
        { unsetDeliveryLimit: Platform.OS === 'ios' ? 65535 : -1 },
      ) });
      const provider = new PointerResourceProvider({ peer, epoch, clockId: `native:${epoch}`, now: () => globalThis.performance.now(),
        platform: Platform.OS, available: () => foreground.current && mounted.current && generation.current === version,
        onStatus: () => {
          const value = session.current;
          if (value?.generation === version && current(value) && value.provider.status().ready)
            setStatus('Ready. Slide on the pad to move; lift to release.');
        },
      });
      candidate = { generation: version, epoch, peer, provider, answered: false, statsPending: false, lastStatsAt: 0, missingStats: 0 };
      session.current = candidate;
      const owned = candidate;
      owned.unsubscribe = peer.onStateChange(state => {
        if (!current(owned)) return;
        if (state === 'failed' || state === 'disconnected') stop('Connection ended. Create a fresh connection to try again.');
      });
      owned.timer = setInterval(() => {
        if (!current(owned)) return;
        try {
          provider.tick();
          const state = provider.status();
          const driver = provider.driver();
          if (driver && !driver.state().lastAdmission) {
            stop('Touch control reached its connection limit. Create a fresh connection to try again.'); return;
          }
          const now = globalThis.performance.now();
          if (!owned.statsPending && now - owned.lastStatsAt >= 250 && peer.isOpen('reliable') && peer.isOpen('disposable')) {
            owned.statsPending = true; owned.lastStatsAt = now;
            void peer.stats().then(report => {
              if (!current(owned)) return;
              owned.statsPending = false;
              let measured = 0;
              report?.forEach((row: unknown) => {
                if (typeof row !== 'object' || row === null) return;
                const stat = row as Record<string, unknown>;
                if (stat.type === 'data-channel' && typeof stat.bytesSent === 'number' && Number.isSafeInteger(stat.bytesSent) && stat.bytesSent >= 0 &&
                  typeof stat.messagesSent === 'number' && Number.isSafeInteger(stat.messagesSent) && stat.messagesSent >= 0) measured++;
              });
              owned.missingStats = measured >= 2 ? 0 : owned.missingStats + 1;
              if (owned.missingStats >= 3) stop('This connection cannot measure pending touch input. Create a fresh connection to try again.');
            }).catch(() => { if (current(owned)) stop('Touch control is unavailable. Create a fresh connection to try again.'); });
          }
          if (state.stopped) { stop('Touch control stopped. Create a fresh connection to try again.'); return; }
          setReady(state.ready);
          setContact(provider.driver()?.state().contact ?? false);
          if (state.ready) setStatus('Ready. Slide on the pad to move; lift to release.');
          else if (owned.answered) setStatus('On the receiver, choose Allow pointer for one minute.');
        } catch { stop('Touch control is unavailable. Create a fresh connection to try again.'); }
      }, 10);
      const description = await peer.createOffer();
      if (!current(owned)) return;
      setOffer(encodeManualPeerCode(epoch, description)); setBusy(false); setDetails(true);
      setStatus('Copy the offer to the local pointer receiver, then paste its answer here.');
    } catch {
      if (generation.current !== version || !mounted.current) return;
      if (candidate && !current(candidate)) return;
      stop('Could not create this connection. Create a fresh connection to try again.');
    }
  };
  const accept = async () => {
    const owned = session.current;
    if (!owned || busy || owned.answered) return;
    setBusy(true);
    try {
      const packet = decodeManualPeerCode(answer, 'answer', owned.epoch);
      await owned.peer.acceptAnswer(packet.description);
      if (!current(owned)) return;
      owned.answered = true; setAnswered(true); setBusy(false); setAnswer('');
      setStatus('On the receiver, choose Allow pointer for one minute.');
    } catch {
      if (current(owned)) stop('This answer could not connect. Create a fresh connection and transfer its complete codes.');
    }
  };
  const copy = async () => {
    const owned = session.current;
    if (!owned || !offer) return;
    try {
      const copied = await Clipboard.setStringAsync(offer);
      if (current(owned)) setStatus(copied ? 'Offer copied. Paste it into the local pointer receiver.' : 'Select the offer below and copy it manually.');
    } catch { if (current(owned)) setStatus('Select the offer below and copy it manually.'); }
  };
  const input = (): PointerSourceDriver | undefined => session.current?.provider.driver();
  const touches = (event: NativeSyntheticEvent<NativeTouchEvent>, action: 'begin' | 'move' | 'end') => {
    const driver = input(); if (!driver) return;
    for (const touch of event.nativeEvent.changedTouches) {
      const id = touchId(touch.identifier); if (id === undefined) continue;
      if (action === 'end') driver.end(id);
      else driver[action](id, touch.locationX, touch.locationY, pad.current.width, pad.current.height);
    }
  };
  const release = () => { input()?.release(); setContact(false); };
  const text = { color: t.text };
  const field = { color: t.text, backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 12, padding: space.sm, minHeight: 80 };
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: 44 }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
        <Text style={[type.title, text]}>Pointer lab</Text>
        <Button label="Close" onPress={() => { stop(); onClose(); }} />
      </View>
      <Text style={[type.body, { color: t.muted }]}>Control a separate local pointer surface with touch or the direction buttons.</Text>
      <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={[type.body, text]}>{status}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        <Button label={active ? 'Start fresh connection' : 'Create connection'} onPress={() => { void start(); }} disabled={busy} tone="strong" />
        <Button label="Stop" onPress={() => stop('Stopped. Create a fresh connection when you are ready.')} disabled={!active} />
      </View>
      <Button label={details ? 'Hide pairing details' : 'Show pairing details'} onPress={() => setDetails(value => !value)} />
      {details && <View style={{ gap: space.sm }}>
        <Text style={[type.body, { color: t.muted }]}>Open /pointer-lab on your local browser receiver. Transfer the offer there and paste its answer below. On that receiver, choose Allow pointer for one minute.</Text>
        <Text style={[type.body, { color: t.muted }]}>These manual codes prove possession of pairing details; they do not authenticate the other endpoint.</Text>
        {!!offer && <>
          <Text style={[type.action, text]}>Offer code</Text>
          <TextInput accessibilityLabel="Offer code, select to copy manually" value={offer} editable={false} multiline selectTextOnFocus style={[field, { maxHeight: 120 }]} />
          <Button label="Copy offer" onPress={() => { void copy(); }} />
          <Text style={[type.action, text]}>Answer code</Text>
          <TextInput accessibilityLabel="Paste complete answer code" value={answer} onChangeText={setAnswer} multiline maxLength={65536} autoCorrect={false} autoCapitalize="none" style={[field, { maxHeight: 140 }]} editable={!busy && !answered} />
          <Button label="Connect answer" onPress={() => { void accept(); }} disabled={busy || !answer.trim() || answered} />
        </>}
      </View>}
      <View
        accessible accessibilityLabel="Relative touch pad. Slide to move the pointer and lift to release. Direction buttons below provide the same movement."
        accessibilityState={{ disabled: !ready }}
        onLayout={event => { const { width, height } = event.nativeEvent.layout; pad.current = { width, height }; }}
        onStartShouldSetResponder={() => ready} onMoveShouldSetResponder={() => ready}
        onResponderTerminationRequest={() => true} onResponderTerminate={release}
        onTouchStart={event => touches(event, 'begin')} onTouchMove={event => touches(event, 'move')}
        onTouchEnd={event => touches(event, 'end')} onTouchCancel={release}
        style={{ minHeight: 250, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: ready ? t.lineStrong : t.line, backgroundColor: contact ? t.surfacePressed : t.surface, alignItems: 'center', justifyContent: 'center', opacity: ready ? 1 : 0.5 }}
      >
        <Text pointerEvents="none" style={[type.title, text]}>{ready ? 'Slide to move' : 'Waiting for receiver approval'}</Text>
        <Text pointerEvents="none" style={[type.body, { color: t.muted }]}>{contact ? 'Touch held' : 'Lift to release'}</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm }}>
        {([['Left', -0.025, 0], ['Up', 0, -0.025], ['Down', 0, 0.025], ['Right', 0.025, 0]] as const).map(([label, dx, dy]) =>
          <Button key={label} label={label} onPress={() => input()?.nudge(dx, dy)} disabled={!ready} />)}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Hold contact, release to lift. Activate to toggle contact." accessibilityActions={[{ name: 'activate', label: 'Toggle contact' }]}
        onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'activate') { const driver = input(); if (driver) driver.setContact(!driver.state().contact); } }} accessibilityState={{ disabled: !ready, selected: contact }} disabled={!ready}
        onPressIn={() => input()?.setContact(true)} onPressOut={release}
        style={({ pressed }) => ({ minHeight: 52, borderRadius: 26, padding: space.md, alignItems: 'center', backgroundColor: pressed ? t.surfacePressed : t.surface, borderWidth: 1, borderColor: t.line, opacity: ready ? 1 : 0.5 })}>
        <Text style={[type.action, text]}>Hold contact</Text>
      </Pressable>
    </ScrollView>
  );
}
