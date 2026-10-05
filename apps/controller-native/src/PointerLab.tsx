import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, useWindowDimensions, View, type NativeTouchEvent, type NativeSyntheticEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import {
  AuthenticatedResourcePeer, createNativePeerPort, decodeManualPeerCode, decodeReceiverInvitationInput, encodeManualPeerCode,
  PeerDataTransport, PointerResourceProvider, receiverInvitationCurrent,
  type EndpointIdentity, type PointerSourceDriver, type ReceiverInvitation,
} from '@101/connect';
import { createNativeIdentityStore, nativeEndpointCrypto } from './native-identity.ts';
import { space, type, useTheme } from './theme.ts';
import { Button } from './ui.tsx';
import { applyPointerTouches } from './pointer-touch.ts';

type Session = {
  generation: number; epoch: string; invitation: ReceiverInvitation;
  peer: PeerDataTransport; facade: AuthenticatedResourcePeer; provider: PointerResourceProvider;
  timer?: ReturnType<typeof setInterval>; detach: (() => void)[]; answered: boolean; confirmed: boolean; admitted: boolean;
  statsPending: boolean; lastStatsAt: number; missingStats: number;
};

/** Local general pointer source, deliberately initiating its own native RTC channels. */
export default function PointerLab({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const viewport = useWindowDimensions();
  const mounted = useRef(false);
  const foreground = useRef(AppState.currentState === 'active');
  const generation = useRef(0);
  const session = useRef<Session | undefined>(undefined);
  const store = useRef<ReturnType<typeof createNativeIdentityStore> | undefined>(undefined);
  const identity = useRef<EndpointIdentity | null>(null);
  const identityOperation = useRef(0);
  const detachIdentity = useRef<(() => void) | undefined>(undefined);
  const reviewedTarget = useRef<ReceiverInvitation | undefined>(undefined);
  const pad = useRef({ width: 0, height: 0 });
  const [identityState, setIdentityState] = useState<'loading' | 'absent' | 'available' | 'error'>('loading');
  const [identityStatus, setIdentityStatus] = useState('Loading the saved local identity…');
  const [invitation, setInvitation] = useState('');
  const [reviewed, setReviewed] = useState<ReceiverInvitation | undefined>(undefined);
  const [digest, setDigest] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState('Ask the receiver to create an invitation, then review it here.');
  const [offer, setOffer] = useState('');
  const [answer, setAnswer] = useState('');
  const [active, setActive] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [details, setDetails] = useState(true);
  const [contact, setContact] = useState(false);

  const stop = useCallback((message?: string, clearTarget = true) => {
    generation.current++;
    const current = session.current;
    session.current = undefined;
    if (current) {
      if (current.timer !== undefined) clearInterval(current.timer);
      try { current.provider.stop(); } catch { /* Continue retiring connection authority. */ }
      try { current.facade.stop(); } catch { /* Disconnect the owned raw transport as well. */ }
      for (const detach of current.detach) { try { detach(); } catch { /* Dispose every subscription. */ } }
      void current.peer.disconnect().catch(() => { /* Authority has already been retired locally. */ });
    }
    if (clearTarget) reviewedTarget.current = undefined;
    if (mounted.current) {
      setActive(false); setReady(false); setBusy(false); setAnswered(false); setContact(false); setOffer(''); setAnswer('');
      setDigest(''); setConfirmed(false);
      if (clearTarget) { setReviewed(undefined); setInvitation(''); }
      if (message) setStatus(message);
    }
  }, []);
  const getStore = useCallback(() => {
    store.current ??= createNativeIdentityStore();
    return store.current;
  }, []);
  const installIdentity = useCallback((value: EndpointIdentity | null) => {
    detachIdentity.current?.(); detachIdentity.current = undefined;
    identity.current = value;
    setIdentityState(value ? 'available' : 'absent');
    setIdentityStatus(value ? 'Saved local identity is ready.' : 'No saved local identity. Create one to connect.');
    if (value) detachIdentity.current = value.onInvalidated(() => {
      if (!mounted.current || identity.current !== value) return;
      identity.current = null;
      setIdentityState('error'); setIdentityStatus('The saved identity is no longer available. Retry saved identity or remove it before creating a new one.');
      stop('Connection stopped because the local identity is no longer available. Review a fresh receiver invitation after recovery.');
    });
  }, [stop]);
  const readIdentity = useCallback(async () => {
    const operation = ++identityOperation.current;
    stop();
    detachIdentity.current?.(); detachIdentity.current = undefined; identity.current = null;
    setIdentityState('loading'); setIdentityStatus('Loading the saved local identity…');
    try {
      const value = await getStore().load();
      if (mounted.current && identityOperation.current === operation) installIdentity(value);
    } catch {
      if (!mounted.current || identityOperation.current !== operation) return;
      setIdentityState('error');
      setIdentityStatus('Local identity storage is unavailable. Unlock this device and retry. If it remains unavailable, open a supported native build.');
    }
  }, [getStore, installIdentity, stop]);
  const createIdentity = async () => {
    if (identityState !== 'absent' || !foreground.current) return;
    const operation = ++identityOperation.current;
    stop(); setIdentityState('loading'); setIdentityStatus('Creating a local identity…');
    try {
      const value = await getStore().create();
      if (mounted.current && identityOperation.current === operation) installIdentity(value);
    } catch {
      if (!mounted.current || identityOperation.current !== operation) return;
      setIdentityState('error');
      setIdentityStatus('Could not create the local identity. Unlock this device and retry saved identity, or open a supported native build.');
    }
  };
  const removeIdentity = async () => {
    if (identityState === 'loading' || identityState === 'absent') return;
    const operation = ++identityOperation.current;
    stop('Connection stopped. Removing the saved identity…');
    detachIdentity.current?.(); detachIdentity.current = undefined; identity.current = null;
    setIdentityState('loading'); setIdentityStatus('Removing the saved identity…');
    try {
      await getStore().remove();
      if (!mounted.current || identityOperation.current !== operation) return;
      installIdentity(null); setStatus('Saved identity removed. Create a local identity, then review a fresh receiver invitation.');
    } catch {
      if (!mounted.current || identityOperation.current !== operation) return;
      setIdentityState('error');
      setIdentityStatus('Could not remove the saved identity. The connection is stopped. Unlock this device and retry removal or saved identity.');
    }
  };
  useEffect(() => {
    mounted.current = true;
    const operation = ++identityOperation.current;
    void Promise.resolve().then(() => getStore().load()).then(value => {
      if (mounted.current && identityOperation.current === operation) installIdentity(value);
    }).catch(() => {
      if (!mounted.current || identityOperation.current !== operation) return;
      setIdentityState('error');
      setIdentityStatus('Local identity storage is unavailable. Unlock this device and retry. If it remains unavailable, open a supported native build.');
    });
    const subscription = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (!foreground.current) stop('Connection stopped. Return here and review a fresh receiver invitation.');
    });
    return () => {
      mounted.current = false; identityOperation.current++; detachIdentity.current?.(); detachIdentity.current = undefined;
      stop(); subscription.remove();
    };
  }, [getStore, installIdentity, stop]);
  useEffect(() => {
    if (!reviewed || active) return;
    const timer = setTimeout(() => {
      if (!mounted.current || reviewedTarget.current !== reviewed || receiverInvitationCurrent(reviewed, Date.now())) return;
      reviewedTarget.current = undefined; setReviewed(undefined);
      setStatus('This invitation expired. Ask the receiver for a fresh invitation and review it here.');
    }, Math.max(0, reviewed.expiresAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [active, reviewed]);
  const current = (value: Session) => mounted.current && foreground.current && session.current === value && generation.current === value.generation;

  const reviewInvitation = () => {
    if (active || busy || identityState === 'loading') return;
    reviewedTarget.current = undefined; setReviewed(undefined);
    try {
      const target = decodeReceiverInvitationInput(invitation, Date.now());
      reviewedTarget.current = target; setReviewed(target);
      setStatus('Review the application and session below. Choose Connect to this receiver only if this is your intended target.');
    } catch {
      setStatus('Use a complete invitation created within the last five minutes. Check both device clocks, then ask the receiver for a fresh invitation.');
    }
  };

  const start = async () => {
    const selected = reviewedTarget.current;
    const savedIdentity = identity.current;
    if (busy || active || !savedIdentity || !selected || identityState !== 'available') return;
    if (!receiverInvitationCurrent(selected, Date.now())) {
      stop('This invitation expired. Ask the receiver for a fresh invitation and review it here.'); return;
    }
    stop(undefined, false);
    if (!foreground.current || typeof globalThis.performance?.now !== 'function' || typeof RTCPeerConnection !== 'function') {
      setStatus('Touch control is unavailable. Keep this screen open and try again.'); return;
    }
    setBusy(true); setActive(true); setStatus('Creating a connection to the reviewed receiver…');
    const version = generation.current;
    let candidate: Session | undefined;
    let raw: PeerDataTransport | undefined;
    let facade: AuthenticatedResourcePeer | undefined;
    try {
      if (!await savedIdentity.isCurrent()) {
        if (mounted.current && generation.current === version) {
          installIdentity(null);
          stop('The saved identity is no longer current. Create a local identity and review a fresh receiver invitation.');
        }
        return;
      }
      if (!mounted.current || !foreground.current || generation.current !== version) return;
      if (!receiverInvitationCurrent(selected, Date.now())) {
        stop('This invitation expired. Ask the receiver for a fresh invitation and review it here.'); return;
      }
      const epoch = selected.epoch;
      const peer = new PeerDataTransport({ initiator: true, createPeer: () => createNativePeerPort(
        new RTCPeerConnection({ iceServers: [] }), value => new RTCSessionDescription(value),
        { unsetDeliveryLimit: Platform.OS === 'ios' ? 65535 : -1 },
      ) });
      raw = peer;
      const authenticated = new AuthenticatedResourcePeer({ transport: peer, identity: savedIdentity, crypto: nativeEndpointCrypto,
        epoch, applicationId: selected.applicationId, sessionId: selected.sessionId, role: 'source', now: () => globalThis.performance.now() });
      facade = authenticated;
      const provider = new PointerResourceProvider({ peer: authenticated, epoch, clockId: `native:${epoch}`, now: () => globalThis.performance.now(),
        platform: Platform.OS, available: () => foreground.current && mounted.current && generation.current === version,
        onStatus: () => {
          const value = session.current;
          if (value?.generation === version && current(value) && value.provider.status().ready)
            setStatus('Ready. Slide on the pad to move; lift to release.');
        },
      });
      candidate = { generation: version, epoch, invitation: selected, peer, facade: authenticated, provider,
        detach: [], answered: false, confirmed: false, admitted: false, statsPending: false, lastStatsAt: 0, missingStats: 0 };
      session.current = candidate;
      const owned = candidate;
      owned.detach.push(peer.onStateChange(state => {
        if (!current(owned)) return;
        if (state === 'failed' || state === 'disconnected') stop('Connection ended. Review a fresh receiver invitation to try again.');
      }));
      owned.detach.push(authenticated.onStateChange(state => {
        if (!current(owned)) return;
        if (state === 'connected') {
          if (!receiverInvitationCurrent(owned.invitation, Date.now())) {
            stop('This invitation expired before enrollment completed. Ask the receiver for a fresh invitation.'); return;
          }
          owned.admitted = true;
        } else if (state === 'failed' || state === 'disconnected') {
          stop('Connection verification stopped. Retry saved identity if needed, then review a fresh receiver invitation.');
        }
      }));
      owned.timer = setInterval(() => {
        if (!current(owned)) return;
        try {
          if (!owned.admitted && !receiverInvitationCurrent(owned.invitation, Date.now())) {
            stop('This invitation expired before enrollment completed. Ask the receiver for a fresh invitation.'); return;
          }
          authenticated.tick();
          if (!current(owned)) return;
          const authentication = authenticated.status();
          if (authentication.phase === 'stopped') {
            stop('Connection verification stopped. Retry saved identity if needed, then review a fresh receiver invitation.'); return;
          }
          setDigest(authentication.comparisonDigest ?? '');
          provider.tick();
          const state = provider.status();
          const driver = provider.driver();
          if (driver && !driver.state().lastAdmission) {
            stop('Touch control reached its connection limit. Review a fresh receiver invitation to try again.'); return;
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
              if (owned.missingStats >= 3) stop('This connection cannot measure pending touch input. Review a fresh receiver invitation to try again.');
            }).catch(() => { if (current(owned)) stop('Touch control is unavailable. Review a fresh receiver invitation to try again.'); });
          }
          if (state.stopped) { stop('Touch control stopped. Review a fresh receiver invitation to try again.'); return; }
          setReady(state.ready);
          setContact(provider.driver()?.state().contact ?? false);
          if (state.ready) setStatus('Ready. Slide on the pad to move; lift to release.');
          else if (authentication.phase === 'active') setStatus('Both owners allowed this connection. On the receiver, choose Allow pointer for one minute.');
          else if (authentication.comparisonDigest) setStatus(owned.confirmed
            ? 'Waiting for the receiver owner to confirm the matching code.'
            : 'Compare every character of the verified code on both screens before allowing this connection.');
          else if (owned.answered) setStatus('Verifying this connection. Keep both screens open.');
        } catch { stop('Touch control is unavailable. Review a fresh receiver invitation to try again.'); }
      }, 10);
      const description = await peer.createOffer();
      if (!current(owned)) return;
      setOffer(encodeManualPeerCode(epoch, description)); setBusy(false); setDetails(true);
      setStatus('Copy this offer to the reviewed receiver, then paste its answer here.');
    } catch {
      if (!candidate) { facade?.stop(); void raw?.disconnect().catch(() => {}); }
      if (generation.current !== version || !mounted.current) return;
      if (candidate && !current(candidate)) return;
      stop('Could not create this connection. Retry saved identity if needed, then review a fresh receiver invitation.');
    }
  };
  const accept = async () => {
    const owned = session.current;
    if (!owned || busy || owned.answered) return;
    if (!receiverInvitationCurrent(owned.invitation, Date.now())) {
      stop('This invitation expired. Ask the receiver for a fresh invitation and review it here.'); return;
    }
    setBusy(true);
    try {
      const packet = decodeManualPeerCode(answer, 'answer', owned.epoch);
      await owned.peer.acceptAnswer(packet.description);
      if (!current(owned)) return;
      owned.answered = true; setAnswered(true); setBusy(false); setAnswer('');
      setStatus('Verifying this connection. Compare the full verified code on both screens when it appears.');
    } catch {
      if (current(owned)) stop('This answer could not connect. Review a fresh receiver invitation and transfer its complete codes.');
    }
  };
  const confirmConnection = () => {
    const owned = session.current;
    if (!owned || !current(owned) || !digest || owned.confirmed) return;
    if (!receiverInvitationCurrent(owned.invitation, Date.now())) {
      stop('This invitation expired before enrollment completed. Ask the receiver for a fresh invitation.'); return;
    }
    if (owned.facade.status().comparisonDigest !== digest || !owned.facade.confirmEnrollment(digest)) {
      stop('This verified code is no longer current. Review a fresh receiver invitation and compare the new code.'); return;
    }
    if (!current(owned)) return;
    owned.confirmed = true; setConfirmed(true);
    setStatus('Waiting for the receiver owner to confirm the matching code.');
  };
  const copy = async () => {
    const owned = session.current;
    if (!owned || !offer) return;
    try {
      const copied = await Clipboard.setStringAsync(offer);
      if (current(owned)) setStatus(copied ? 'Offer copied. Paste it into the reviewed receiver.' : 'Select the offer below and copy it manually.');
    } catch { if (current(owned)) setStatus('Select the offer below and copy it manually.'); }
  };
  const input = (): PointerSourceDriver | undefined => {
    const owned = session.current;
    return owned && current(owned) && owned.admitted && owned.facade.state === 'connected' ? owned.provider.driver() : undefined;
  };
  const touches = (event: NativeSyntheticEvent<NativeTouchEvent>, action: 'begin' | 'move' | 'end') => {
    const driver = input(); if (!driver) return;
    applyPointerTouches(driver, event.nativeEvent.changedTouches, action, pad.current);
  };
  const release = () => { input()?.release(); setContact(false); };
  const text = { color: t.text };
  const field = { color: t.text, backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 12, padding: space.sm, minHeight: 80 };
  // Before approval, controls scroll with setup. While ready, they have no
  // scrolling ancestor; genuine cancellation still releases the driver.
  const controls = (
      <View style={{ padding: space.lg, paddingBottom: 28, gap: space.sm, flexShrink: 1 }}>
      <View
        pointerEvents="box-only"
        accessible accessibilityLabel="Relative touch pad. Slide to move the pointer and lift to release. Direction buttons below provide the same movement."
        accessibilityState={{ disabled: !ready }}
        onLayout={event => { const { width, height } = event.nativeEvent.layout; pad.current = { width, height }; }}
        onStartShouldSetResponder={() => ready} onMoveShouldSetResponder={() => ready}
        onResponderTerminationRequest={() => false} onResponderTerminate={release}
        onTouchStart={event => touches(event, 'begin')} onTouchMove={event => touches(event, 'move')}
        onTouchEnd={event => touches(event, 'end')} onTouchCancel={release}
        style={{ height: Math.min(250, Math.max(100, viewport.height * 0.3)), minHeight: 64, flexShrink: 1, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: ready ? t.lineStrong : t.line, backgroundColor: contact ? t.surfacePressed : t.surface, alignItems: 'center', justifyContent: 'center', opacity: ready ? 1 : 0.5 }}
      >
        <Text pointerEvents="none" style={[type.title, text]}>{ready ? 'Slide to move' : 'Waiting for receiver approval'}</Text>
        <Text pointerEvents="none" style={[type.body, { color: t.muted }]}>{contact ? 'Touch held' : 'Lift to release'}</Text>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.sm }}>
        {([['Left', -0.025, 0], ['Up', 0, -0.025], ['Down', 0, 0.025], ['Right', 0.025, 0]] as const).map(([label, dx, dy]) =>
          <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !ready }}
            onPress={() => input()?.nudge(dx, dy)} disabled={!ready}
            style={({ pressed }) => ({ flex: 1, minHeight: 48, borderRadius: 26, paddingHorizontal: space.sm,
              justifyContent: 'center', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.line,
              backgroundColor: pressed ? t.surfacePressed : t.surface, opacity: ready ? 1 : 0.4 })}>
            <Text style={[type.action, text]}>{label}</Text>
          </Pressable>)}
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Hold contact, release to lift. Activate to toggle contact." accessibilityActions={[{ name: 'activate', label: 'Toggle contact' }]}
        onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'activate') { const driver = input(); if (driver) driver.setContact(!driver.state().contact); } }} accessibilityState={{ disabled: !ready, selected: contact }} disabled={!ready}
        onPressIn={() => input()?.setContact(true)} onPressOut={release}
        style={({ pressed }) => ({ flex: 1, minHeight: 52, borderRadius: 26, padding: space.md, alignItems: 'center', backgroundColor: pressed ? t.surfacePressed : t.surface, borderWidth: 1, borderColor: t.line, opacity: ready ? 1 : 0.5 })}>
        <Text style={[type.action, text]}>Hold contact</Text>
      </Pressable>
      {ready && <Button label="Stop" onPress={() => stop('Stopped. Review a fresh receiver invitation when you are ready.')} />}
      </View>
      </View>
  );
  return (
    <SafeAreaView style={{ flex: 1, maxHeight: viewport.height - (Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) + 44 : 0), backgroundColor: t.bg, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.lg }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
        <Text style={[type.title, text]}>Pointer lab</Text>
        <Button label="Close" onPress={() => { stop(); onClose(); }} />
      </View>
      <Text style={[type.body, { color: t.muted }]}>Control a separate local pointer surface with touch or the direction buttons.</Text>
      <View style={{ gap: space.sm }}>
        <Text style={[type.action, text]}>Local identity</Text>
        <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={[type.body, text]}>{identityStatus}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {identityState === 'loading' && <Button label="Local identity busy…" onPress={() => {}} disabled />}
          {identityState === 'absent' && <Button label="Create local identity" onPress={() => { void createIdentity(); }} tone="strong" />}
          {identityState === 'error' && <Button label="Retry saved identity" onPress={() => { void readIdentity(); }} />}
          {(identityState === 'available' || identityState === 'error') &&
            <Button label="Stop and remove saved identity" onPress={() => { void removeIdentity(); }} />}
        </View>
      </View>
      <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={[type.body, text]}>{status}</Text>
      {!active && <>
        <Text style={[type.action, text]}>Receiver invitation</Text>
        <Text style={[type.body, { color: t.muted }]}>On the receiver, create a fresh invitation for its application and session. Paste it here, then review the target before connecting.</Text>
        <TextInput accessibilityLabel="Paste receiver invitation" value={invitation} multiline maxLength={2048}
          autoCorrect={false} autoCapitalize="none" editable={!busy && identityState !== 'loading'}
          onChangeText={value => {
            reviewedTarget.current = undefined; setReviewed(undefined); setInvitation(value);
            setStatus('Review this invitation before choosing the receiver.');
          }} style={[field, { maxHeight: 140 }]} />
        <Button label="Review invitation" onPress={reviewInvitation}
          disabled={busy || identityState === 'loading' || !invitation.trim()} />
      </>}
      {reviewed && <View style={{ gap: space.sm }}>
        <Text selectable accessibilityLabel="Reviewed receiver application" style={[type.body, text]}>Application: {reviewed.applicationId}</Text>
        <Text selectable accessibilityLabel="Reviewed receiver session" style={[type.body, text]}>Session: {reviewed.sessionId}</Text>
        {!active && <Text style={[type.body, { color: t.muted }]}>Connect only if these are the application and session you intend to control. A pasted invitation alone does not allow a connection.</Text>}
      </View>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {!active && <Button label="Connect to this receiver" onPress={() => { void start(); }}
          disabled={busy || identityState !== 'available' || !reviewed}
          tone={identityState === 'available' ? 'strong' : 'quiet'} />}
        {!ready && <Button label="Stop" onPress={() => stop('Stopped. Review a fresh receiver invitation when you are ready.')} disabled={!active} />}
      </View>
      {!!offer && <View style={{ gap: space.sm }}>
        <Button label="Copy offer" onPress={() => { void copy(); }} />
        <Text style={[type.action, text]}>Answer code</Text>
        <TextInput accessibilityLabel="Paste complete answer code" value={answer} onChangeText={setAnswer} multiline maxLength={65536} autoCorrect={false} autoCapitalize="none" style={[field, { maxHeight: 140 }]} editable={!busy && !answered} />
        <Button label="Connect answer" onPress={() => { void accept(); }} disabled={busy || !answer.trim() || answered} />
      </View>}
      <Button label={details ? 'Hide pairing details' : 'Show pairing details'} onPress={() => setDetails(value => !value)} />
      {details && <View style={{ gap: space.sm }}>
        <Text style={[type.body, { color: t.muted }]}>Transfer the offer to the receiver that created your reviewed invitation, then paste its complete answer below.</Text>
        <Text style={[type.body, { color: t.muted }]}>After verification, compare the full code on both screens and let each owner allow the connection. The receiver then separately allows pointer control for one minute.</Text>
        {!!offer && <>
          <Text style={[type.action, text]}>Offer code</Text>
          <TextInput accessibilityLabel="Offer code, select to copy manually" value={offer} editable={false} multiline selectTextOnFocus style={[field, { maxHeight: 120 }]} />
        </>}
      </View>}
      {!!digest && <View style={{ gap: space.sm }}>
        <Text style={[type.action, text]}>Verified comparison code</Text>
        <Text selectable accessibilityLabel={`Verified comparison code: ${digest}`} style={[type.body, text, { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>{digest}</Text>
        <Text style={[type.body, { color: t.muted }]}>Compare every character on both screens. Allow only when the full codes match. This verifies the endpoint connection, not a person or account.</Text>
        <Button label="Codes match — allow connection" onPress={confirmConnection}
          disabled={!active || busy || confirmed} tone={confirmed ? 'quiet' : 'strong'} />
        {confirmed && <Text accessibilityLiveRegion="polite" style={[type.body, text]}>You allowed this matching code. Both owners must allow the connection before pointer control can be selected.</Text>}
      </View>}
      {!ready && controls}
    </ScrollView>
      {ready && controls}
    </SafeAreaView>
  );
}
