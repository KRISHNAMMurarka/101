import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";

import type { ControllerLayout, LinkState } from "@101/protocol";
import { createPairingIntake, type PairingCandidate } from "@101/pairing";

import { ControllerPanel, type ControllerActions } from "./src/controls";
import { ControllerSession, type ControllerAssignment } from "./src/controller-session";
import { connectionErrorMessage } from "./src/link-error";
import { ControllerSpeaker } from "./src/controller-speaker";
import { createControllerHaptics, type ControllerHaptics } from "./src/controller-haptics";
import { NativeMotionController, type MotionReadout } from "./src/motion-controller";
import { CONTROLLER_PRESETS, DEFAULT_PRESET } from "./src/presets";
import { ticketFromInput } from "./src/pairing-code";
import { createSavedPairingStore } from "./src/saved-pairing";
import { pinchDistance, zoomFromPinch } from "./src/scanner-controls";
import { createScannerSession } from "./src/scanner-session";
import { DARK_SURFACE, radius, space, type, useLayout, useTheme, type Theme } from "./src/theme";
import { Button, Label, StateDot } from "./src/ui";
import privateCue from "./assets/private-cue.wav";
import PointerLab from "./src/PointerLab";

const DEVICE_ID_KEY = "101-link-device-id-v1";
const savedPairing = createSavedPairingStore(SecureStore);

/**
 * Room for the system gesture bar under the bottom-anchored controls.
 *
 * `SafeAreaView` covers the notch but not this, and in landscape the lowest row of controls sat
 * directly on the bar — so the edge of a stick doubled as "go home", which is the worst possible
 * place to lose a thumb mid-game.
 */
const GESTURE_INSET = 34;

/**
 * 101 Link has exactly two screens, because it has exactly two situations: you are not connected
 * and need to be, or you are connected and want to play. Everything that is neither — presets,
 * calibration, diagnostics, disconnect — lives in a sheet you pull up, so it costs nothing until
 * it is wanted.
 *
 * The previous layout put all of it on one scrolling page, which meant the controls (the only
 * reason the app exists) sat below a fold of chrome that stayed on screen even after connecting.
 */
export default function App() {
  const [pointerLab, setPointerLab] = useState(false);
  return pointerLab ? <PointerLab onClose={() => setPointerLab(false)} /> : <GameControllerApp onOpenPointerLab={() => setPointerLab(true)} />;
}

function GameControllerApp({ onOpenPointerLab }: { onOpenPointerLab: () => void }) {
  const t = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const scanShort = windowHeight < 600;
  const privateAudioPlayer = useAudioPlayer(privateCue, { downloadFirst: true });
  const privateAudioStatus = useAudioPlayerStatus(privateAudioPlayer);
  const speaker = useMemo(() => new ControllerSpeaker(privateAudioPlayer), [privateAudioPlayer]);
  const [deviceId, setDeviceId] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [pairReview, setPairReview] = useState<PairingCandidate>();
  const [connectionPending, setConnectionPending] = useState(false);
  const pairIntake = useRef<ReturnType<typeof createPairingIntake> | null>(null);
  if (pairIntake.current === null) pairIntake.current = createPairingIntake({ parse: ticketFromInput });
  const [manualAnswer, setManualAnswer] = useState("");
  const [linkState, setLinkState] = useState<LinkState>("idle");
  const [layout, setLayout] = useState<ControllerLayout>(DEFAULT_PRESET.layout);
  const layoutRef = useRef(layout);
  const [hostControlled, setHostControlled] = useState(false);
  const [assignment, setAssignment] = useState<ControllerAssignment>();
  const [hostValues, setHostValues] = useState<Record<string, string | number | boolean>>({});
  const [hostMessage, setHostMessage] = useState<string>();
  const [hostTone, setHostTone] = useState<"normal" | "warning" | "critical">("normal");
  const [error, setError] = useState<string>();
  const [audioModeReady, setAudioModeReady] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const [speakerPlaybackFailed, setSpeakerPlaybackFailed] = useState(false);
  const [latency, setLatency] = useState<number>();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerGeneration, setScannerGeneration] = useState<number>();
  const [scannerZoom, setScannerZoom] = useState(0);
  const [scannerTorch, setScannerTorch] = useState(false);
  const [scannerMessage, setScannerMessage] = useState("");
  const scannerSession = useRef(createScannerSession());
  const pinchRef = useRef<{ distance: number; zoom: number } | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [codeEntryOpen, setCodeEntryOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [motionReadout, setMotionReadout] = useState<MotionReadout>();
  const [calibration, setCalibration] = useState({ sensitivity: 1, deadZone: 0.04, smoothing: 0.22 });
  const sessionRef = useRef<ControllerSession | undefined>(undefined);
  const motionRef = useRef<NativeMotionController | undefined>(undefined);
  const readoutRenderedAt = useRef(0);
  const hapticsRef = useRef<ControllerHaptics | undefined>(undefined);
  const hapticOwnerRef = useRef<ControllerAssignment | undefined>(undefined);
  const haptics = useMemo(() => ({
    play: (pattern: "tap" | "impact" | "warning") => hapticsRef.current?.play(pattern) ?? Promise.resolve("cancelled"),
    cancel: () => hapticsRef.current?.cancel(),
  }), []);
  const connectBusy = useRef(false);
  const connectRevision = useRef(0);
  const cancelPendingConnect = useCallback(() => { connectRevision.current++; haptics.cancel(); }, [haptics]);

  const closeScanner = useCallback(() => {
    scannerSession.current.retire();
    pinchRef.current = undefined;
    setScannerOpen(false);
    setScannerTorch(false);
  }, []);

  useEffect(() => {
    const scanner = scannerSession.current;
    scanner.mount(AppState.currentState === "active");
    const listener = AppState.addEventListener("change", (state) => {
      scanner.setForeground(state === "active");
      if (state !== "active") closeScanner();
    });
    return () => { listener.remove(); scanner.unmount(); };
  }, [closeScanner]);

  const haptic = useCallback((pattern: "tap" | "impact" | "warning") => haptics.play(pattern), [haptics]);

  useEffect(() => {
    const controller = createControllerHaptics(Haptics);
    hapticsRef.current = controller;
    controller.setActive(AppState.currentState === "active");
    const listener = AppState.addEventListener("change", (state) => controller.setActive(state === "active"));
    return () => { listener.remove(); controller.close(); if (hapticsRef.current === controller) hapticsRef.current = undefined; };
  }, []);

  useEffect(() => {
    let active = true;
    void setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: false,
      shouldPlayInBackground: false,
      interruptionMode: "mixWithOthers",
    }).then(() => {
      if (active) setAudioModeReady(true);
    }).catch(() => {
      if (active) setError("This phone could not prepare private game audio; host audio will be used.");
    });
    return () => { active = false; };
  }, []);

  const connect = useCallback(async (value: string) => {
    if (connectBusy.current) return;
    closeScanner();
    if (value.length > 400_000) { setError("That code is too large. Open a new connection link on the game screen."); return; }
    const input = value.trim();
    // Returning silently here made Connect look like a dead button: nothing moved, nothing
    // explained itself, and the only way to tell an empty field from a broken app was a debugger.
    if (!input) {
      setError("Paste a pairing code, or scan the code on your game screen.");
      return;
    }
    if (!sessionRef.current) {
      setError("101 Link is still starting up. Try again in a moment.");
      return;
    }
    haptics.cancel();
    setError(undefined);
    setManualAnswer("");
    setLinkState("connecting");
    connectBusy.current = true;
    setConnectionPending(true);
    const expected = ++connectRevision.current;
    try {
      if (input.startsWith("101C2.") || input.startsWith("101J2.")) {
        const answer = await sessionRef.current.connectManual(input);
        if (expected !== connectRevision.current) return;
        setManualAnswer(answer);
        await forgetPairing();
      } else {
        await sessionRef.current.connect(input);
        if (expected !== connectRevision.current) return;
        // Remembering the pairing is a convenience for next launch. It used to sit inside this
        // try block, so a keychain write failing *after* a successful connection reported the
        // whole pairing as failed — the player was connected and being told they were not.
        await rememberPairing(input);
      }
      if (expected !== connectRevision.current) return;
      setPairingInput(input);
      setCodeEntryOpen(false);
    } catch (reason) {
      if (expected !== connectRevision.current) return;
      setError(connectionErrorMessage(reason));
      setLinkState("failed");
    } finally {
      connectBusy.current = false;
      setConnectionPending(false);
    }
  }, [closeScanner, haptics]);

  const reviewPairing = useCallback((input: string, source: PairingCandidate["source"]) => {
    closeScanner();
    const result = pairIntake.current!.receive(input, source);
    if (result.status === "unchanged" || result.status === "rate-limited") return;
    if (result.status === "review") {
      setPairingInput(result.candidate.input);
      setPairReview(result.candidate);
      setError(undefined);
    } else {
      setPairReview(undefined);
      setError(result.status === "expired" ? "This code expired. Open a new one on the game screen." : "That connection link could not be read. Scan or paste a new one.");
    }
  }, [closeScanner]);

  const requestConnection = () => {
    if (pairingInput.length <= 400_000 && /^(101C2|101J2)\./.test(pairingInput.trim())) void connect(pairingInput);
    else reviewPairing(pairingInput, "paste");
  };

  const approvePairing = () => {
    if (connectBusy.current || !pairReview) return;
    if (!pairIntake.current!.approve(pairReview)) {
      setPairReview(undefined);
      setError("That connection expired. Open a new one on the game screen.");
      return;
    }
    const input = pairReview.input;
    setPairReview(undefined);
    void connect(input);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Everything downstream — the session, deep links, Connect, motion — is gated on having a
      // device id. This used to be three unguarded awaits inside a `void`, so a single keychain
      // failure left the whole app inert with nothing on screen to say why: buttons did nothing,
      // links were ignored, and "Motion on" reported success against a controller that was never
      // constructed. A stable id is worth having, but it is not worth being the thing that can
      // silently brick the app.
      let id: string | undefined;
      let warning: string | undefined;
      try {
        id = (await SecureStore.getItemAsync(DEVICE_ID_KEY)) ?? undefined;
      } catch {
        warning = "This device could not be remembered, so pairing will not persist between launches.";
      }
      if (!id) {
        id = `link-${Crypto.randomUUID()}`;
        try {
          await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
        } catch {
          warning ??= "This device could not be remembered, so pairing will not persist between launches.";
        }
      }
      if (cancelled) return;
      // Fall through with an in-memory identity: a controller that forgets itself still plays.
      setDeviceId(id);
      if (warning) setError(warning);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    const motion = new NativeMotionController((readout) => {
      if (motionRef.current !== motion || AppState.currentState !== "active") return;
      const activeLayout = layoutRef.current;
      if (activeLayout.motion) {
        const x = clamp(readout.angles.roll / (Math.PI / 3));
        const y = clamp(-readout.angles.pitch / (Math.PI / 3));
        sessionRef.current?.setMotion(
          activeLayout.motion.action,
          x,
          y,
          activeLayout.motion.gestures ?? {},
          readout.gestures,
        );
      }
      const now = Date.now();
      if (now - readoutRenderedAt.current >= 100) {
        readoutRenderedAt.current = now;
        setMotionReadout(readout);
      }
    });
    motionRef.current = motion;
    const session = new ControllerSession(deviceId, `${Platform.OS} 101 Link`, {
      state: (state) => { if (state !== "connected") haptics.cancel(); setLinkState(state); },
      layout: (next, fromHost) => {
        layoutRef.current = next;
        setLayout(next);
        setHostControlled(fromHost);
      },
      assignment: (next) => {
        const previous = hapticOwnerRef.current;
        if (previous?.playerId !== next?.playerId || previous?.role !== next?.role || previous?.gameId !== next?.gameId) haptics.cancel();
        hapticOwnerRef.current = next;
        setAssignment(next);
      },
      hostState: (values, message, tone) => {
        setHostValues(values);
        setHostMessage(message);
        setHostTone(tone ?? "normal");
      },
      haptic: (pattern) => void haptic(pattern),
      speakerCue: (cue) => {
        void speaker.play(cue).catch(() => {
          setSpeakerPlaybackFailed(true);
          sessionRef.current?.setSpeakerReady(false);
          setError("This phone could not play its private game audio; host audio will be used.");
        });
      },
      speakerDiscard: (cue) => { speaker.discard(cue); },
      speakerCancel: () => speaker.cancel(),
      speakerReset: () => speaker.reset(),
      calibration: () => {
        try {
          motion.calibrateNeutral();
          setCalibration(motion.calibration);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "Calibration failed");
        }
      },
      latency: setLatency,
      error: setError,
    });
    sessionRef.current = session;
    session.useLocalLayout(DEFAULT_PRESET.layout);

    let active = true;
    const intakeAtLaunch = pairIntake.current!;
    const initialRevision = intakeAtLaunch.revision;
    void (async () => {
      const initialUrl = await Linking.getInitialURL();
      // This line used to be an unguarded keychain read directly after the launch URL was
      // retrieved. Where the keychain is unavailable it threw, the surrounding `void`-ed async
      // function rejected, and `connect` below never ran — so a deep link that had arrived
      // perfectly well was dropped one line after it was read, on iOS only.
      const saved = await readSavedPairing();
      const candidate = initialUrl ?? saved;
      if (active && intakeAtLaunch.revision === initialRevision && candidate) {
        reviewPairing(candidate, initialUrl ? "link" : "saved");
      }
    })().catch(() => { if (active) setError("The saved connection could not be read. Scan or paste a new one."); });
    const link = Linking.addEventListener("url", ({ url }) => {
      if (active) reviewPairing(url, "link");
    });
    const appState = AppState.addEventListener("change", (state) => {
      setAppActive(state === "active");
      if (state !== "active") {
        motion.stop();
        setMotionEnabled(false);
        setMotionReadout(undefined);
        readoutRenderedAt.current = 0;
        // React effects run later; revoke the host's ready belief before an in-flight cue can use
        // the background player during that gap.
        session.setSpeakerReady(false);
        session.releaseAll();
      }
    });
    return () => {
      active = false;
      cancelPendingConnect();
      pairIntake.current!.clear();
      link.remove();
      appState.remove();
      motionRef.current = undefined;
      motion.stop();
      void session.disconnect();
      sessionRef.current = undefined;
    };
  }, [cancelPendingConnect, deviceId, haptic, haptics, reviewPairing, speaker]);

  useEffect(() => {
    sessionRef.current?.setSpeakerReady(
      privateAudioStatus.isLoaded
      && !privateAudioStatus.error
      && audioModeReady
      && appActive
      && !speakerPlaybackFailed,
    );
  }, [appActive, audioModeReady, deviceId, privateAudioStatus.error, privateAudioStatus.isLoaded, speakerPlaybackFailed]);

  const controls = useMemo<ControllerActions>(() => ({
    action: (name, value, owner) => sessionRef.current?.setAction(name, value, owner),
    actions: (values, owner) => sessionRef.current?.setActions(values, owner),
    axis: (name, value) => sessionRef.current?.setAxis(name, value),
    vector: (name, x, y) => sessionRef.current?.setVector(name, x, y),
    surface: (vectorAction, pressAction, x, y, held) => sessionRef.current?.setSurface(vectorAction, pressAction, x, y, held),
    localHaptic: () => void haptic("tap"),
  }), [haptic]);

  const enableMotion = async () => {
    const motion = motionRef.current;
    if (!motion) { setError("Motion sensing is still starting. Try again in a moment."); return; }
    if (AppState.currentState !== "active") return;
    try {
      const started = await motion.start();
      if (!started || !motion.active || motionRef.current !== motion || AppState.currentState !== "active") return;
      setMotionEnabled(true);
      setError(undefined);
    } catch (reason) {
      if (motionRef.current === motion && AppState.currentState === "active")
        setError(reason instanceof Error ? reason.message : "Motion sensors could not start");
    }
  };

  const calibrate = () => {
    try {
      motionRef.current?.calibrateNeutral();
      if (motionRef.current) setCalibration(motionRef.current.calibration);
      void haptic("impact");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Turn on motion before setting neutral");
    }
  };

  const choosePreset = (preset: (typeof CONTROLLER_PRESETS)[number]) => {
    if (hostControlled && linkState === "connected") return;
    layoutRef.current = preset.layout;
    setLayout(preset.layout);
    sessionRef.current?.useLocalLayout(preset.layout);
    void haptic("tap");
  };

  const openScanner = async () => {
    closeScanner();
    const scanner = scannerSession.current;
    const expected = scanner.begin(AppState.currentState === "active");
    if (expected === undefined) return;
    try {
      const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
      if (!scanner.current(expected, AppState.currentState === "active")) return;
      if (!permission.granted) {
        closeScanner();
        setError("101 Link needs the camera only to read the pairing code. You can paste the code instead.");
        return;
      }
      if (!scanner.open(expected, AppState.currentState === "active")) return;
      pairIntake.current!.clear();
      pinchRef.current = undefined;
      setScannerZoom(0);
      setScannerTorch(false);
      setScannerMessage("");
      setScannerGeneration(expected);
      setScannerOpen(true);
    } catch {
      if (!scanner.current(expected, AppState.currentState === "active")) return;
      closeScanner();
      setError("The camera could not open. Try scanning again, or paste the pairing code.");
    }
  };

  const acceptScan = (data: string, expected: number | undefined) => {
    if (!scannerSession.current.canScan(expected, AppState.currentState === "active")) return;
    const result = pairIntake.current!.receive(data, "scan");
    if (result.status === "unchanged" || result.status === "rate-limited") return;
    if (result.status !== "review") {
      setScannerMessage(result.status === "expired"
        ? "This code expired. Open a new one on the game screen."
        : "That isn't a 101 Link code. Keep scanning.");
      return;
    }
    closeScanner();
    setPairingInput(result.candidate.input);
    setPairReview(result.candidate);
    setError(undefined);
  };

  const updateScannerPinch = (touches: readonly { pageX: number; pageY: number }[]) => {
    const distance = pinchDistance(touches);
    if (distance === undefined) {
      pinchRef.current = undefined;
      return;
    }
    if (!pinchRef.current) {
      pinchRef.current = { distance, zoom: scannerZoom };
      return;
    }
    const next = zoomFromPinch(pinchRef.current.zoom, pinchRef.current.distance, distance);
    setScannerZoom((current) => Math.abs(current - next) < 0.005 ? current : next);
  };

  const disconnect = async () => {
    closeScanner();
    cancelPendingConnect();
    pairIntake.current!.clear();
    setPairReview(undefined);
    await sessionRef.current?.disconnect();
    await forgetPairing();
    setHostControlled(false);
    setManualAnswer("");
    setLinkState("disconnected");
    setAssignment(undefined);
    setSheetOpen(false);
  };

  const activePreset = CONTROLLER_PRESETS.find((preset) => preset.layout.title === layout.title);
  const playing = linkState === "connected";
  const dotState = playing ? "connected" : linkState === "connecting" ? "connecting" : linkState === "failed" ? "failed" : "idle";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg, paddingTop: Platform.OS === "android" ? RNStatusBar.currentHeight : 0 }}>
      <StatusBar style={t.scheme === "light" ? "dark" : "light"} />

      <TopBar
        theme={t}
        state={dotState}
        title={playing ? (assignment?.role ?? layout.title ?? "Controller") : "101 Link"}
        detail={playing ? assignment?.gameId : undefined}
        latency={playing ? latency : undefined}
        onMenu={playing ? () => setSheetOpen(true) : undefined}
      />

      {playing ? (
        <PlaySurface
          theme={t}
          layout={layout}
          controls={controls}
          message={hostMessage}
          tone={hostTone}
          values={hostValues}
        />
      ) : (
        <ConnectScreen
          theme={t}
          state={linkState}
          error={error}
          codeEntryOpen={codeEntryOpen}
          pairingInput={pairingInput}
          manualAnswer={manualAnswer}
          onScan={() => void openScanner()}
          onOpenCodeEntry={() => { closeScanner(); setCodeEntryOpen(true); setError(undefined); }}
          onCancelCodeEntry={() => setCodeEntryOpen(false)}
          onChangeCode={(value) => { pairIntake.current!.clear(); setPairReview(undefined); setPairingInput(value); }}
          onConnect={requestConnection}
          onCopyAnswer={() => { void Clipboard.setStringAsync(manualAnswer); void haptic("tap"); }}
          onCancelConnection={() => void disconnect()}
        />
      )}

      <Modal visible={Boolean(pairReview)} transparent animationType="none" onRequestClose={() => { pairIntake.current!.clear(); setPairReview(undefined); }}>
        <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
          <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: space.lg }}>
          <View accessibilityViewIsModal style={{ gap: space.md }}>
            <Text accessibilityRole="header" style={[type.display, { color: t.text }]}>Connect to this host?</Text>
            <Text style={[type.body, { color: t.text }]}>{pairReview?.ticket.hostName || "101 host"}</Text>
            <Text style={[type.body, { color: t.text }]}>{pairReview?.ticket.endpoint}</Text>
            <Text style={[type.body, { color: t.muted }]}>The name and address come from the connection link. Check them against your game screen.</Text>
            <Button label="Connect" wide tone="strong" disabled={connectionPending} onPress={approvePairing} />
            <Button label="Cancel" wide tone="bare" onPress={() => { pairIntake.current!.clear(); setPairReview(undefined); }} />
          </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {!playing ? <View style={{ paddingHorizontal: space.lg, paddingBottom: Platform.OS === "android" ? GESTURE_INSET + space.sm : space.sm }}>
        <Button label="Open pointer lab" wide onPress={() => { void disconnect().then(onOpenPointerLab); }} />
      </View> : null}

      <Sheet visible={sheetOpen} theme={t} onClose={() => setSheetOpen(false)}>
        {hostControlled ? (
          <Text style={[type.body, { color: t.muted }]}>
            {assignment?.gameId ?? "The game"} is choosing this panel. It changes on its own when the game does.
          </Text>
        ) : (
          <Section theme={t} label="Controller">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {CONTROLLER_PRESETS.map((preset) => (
                <Chip
                  key={preset.id}
                  theme={t}
                  label={preset.name}
                  selected={activePreset?.id === preset.id}
                  onPress={() => choosePreset(preset)}
                />
              ))}
            </View>
          </Section>
        )}

        {layout.motion ? (
          <Section theme={t} label="Motion">
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button label={motionEnabled ? "Motion on" : "Turn on motion"} tone={motionEnabled ? "quiet" : "strong"} onPress={() => void enableMotion()} />
              <Button label="Set neutral" onPress={calibrate} disabled={!motionEnabled} />
            </View>
          </Section>
        ) : null}

        {activePreset?.sensorLab && motionReadout ? (
          <Section theme={t} label="Sensor">
            <Readout theme={t} readout={motionReadout} calibration={calibration} />
          </Section>
        ) : null}

        {error ? <Text style={[type.body, { color: t.text }]}>{error}</Text> : null}

        <Button label="Disconnect" wide onPress={() => void disconnect()} />
        <Text style={[type.label, { color: t.faint, textAlign: "center" }]}>{deviceId || "…"}</Text>
      </Sheet>

      <Modal animationType="fade" visible={scannerOpen && appActive} onRequestClose={closeScanner}>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          {scannerOpen && appActive ? <CameraView
            key={scannerGeneration}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            facing="back"
            zoom={scannerZoom}
            enableTorch={scannerTorch}
            onBarcodeScanned={({ data }) => acceptScan(data, scannerGeneration)}
            style={StyleSheet.absoluteFill}
          /> : null}
          <View
            style={StyleSheet.absoluteFill}
            onStartShouldSetResponder={() => true}
            onTouchStart={(event) => updateScannerPinch(event.nativeEvent.touches)}
            onTouchMove={(event) => updateScannerPinch(event.nativeEvent.touches)}
            onTouchEnd={(event) => updateScannerPinch(event.nativeEvent.touches)}
            onTouchCancel={() => { pinchRef.current = undefined; }}
          />
          <SafeAreaView style={{
            flex: 1,
            justifyContent: "space-between",
            flexDirection: scanShort ? "row" : "column",
            gap: space.sm,
            paddingHorizontal: scanShort ? space.sm : space.lg,
            paddingTop: (Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 0) : 0) + space.sm,
            paddingBottom: Platform.OS === "android" ? GESTURE_INSET + space.sm : space.lg,
          }} pointerEvents="box-none">
            <View style={{ flex: scanShort ? 1 : undefined, justifyContent: "space-between", alignItems: "center", gap: space.xs }}>
              <View style={{ gap: space.xs, alignItems: "center" }}>
                <Text style={[type.title, { color: "#fff", textAlign: "center" }]}>Scan game code</Text>
                {!scanShort ? (
                  <Text style={[type.body, { color: "#fff", textAlign: "center" }]}>
                    Pinch to zoom. The camera adjusts to the light as you move.
                  </Text>
                ) : null}
              </View>
              <View pointerEvents="none" style={{ alignSelf: "center", width: scanShort ? Math.min(windowHeight - 100, 220) : 260, height: scanShort ? Math.min(windowHeight - 100, 220) : 260, borderRadius: radius.card, borderWidth: 3, borderColor: "#fff" }} />
            </View>
            <ScrollView style={{ flexGrow: scanShort ? 1 : 0, flexBasis: scanShort ? 0 : undefined }} contentContainerStyle={{ gap: space.md, justifyContent: "flex-end", flexGrow: 1 }}>
              {scannerMessage ? (
                <Text accessibilityRole="alert" style={[type.body, { color: "#fff", textAlign: "center", backgroundColor: "rgba(0,0,0,0.8)", padding: space.sm }]}>
                  {scannerMessage}
                </Text>
              ) : null}
              <View style={{ gap: space.sm, padding: space.sm, borderRadius: radius.control, backgroundColor: "rgba(0,0,0,0.8)" }}>
                <Text style={[type.label, { color: "#fff", textAlign: "center" }]}>Pinch to zoom · {Math.round(scannerZoom * 100)}%</Text>
                <Button label={scannerTorch ? "Light off" : "Light on"} wide palette={DARK_SURFACE} onPress={() => setScannerTorch((value) => !value)} />
              </View>
              <Text style={[type.body, { color: "#fff", backgroundColor: "rgba(0,0,0,0.7)", textAlign: "center" }]}>
                Point at the code on your game screen
              </Text>
              {/* The camera feed is black whatever the player's theme is, so this control is styled
                  from the dark palette explicitly. Styled from the app theme it rendered near-black
                  on black in light mode, which left the only way out of the scanner invisible. */}
              <Button label="Cancel" wide palette={DARK_SURFACE} onPress={closeScanner} />
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/**
 * One 44pt rule across the top, in both states. It is the only chrome that survives into play,
 * so it carries only what a player glances at mid-game: whether the link is up, what they are,
 * and how to reach everything else.
 */
function TopBar({ theme, state, title, detail, latency, onMenu }: {
  theme: Theme;
  state: "idle" | "connecting" | "connected" | "failed";
  title: string;
  detail?: string;
  latency?: number;
  onMenu?: () => void;
}) {
  return (
    <View style={{
      height: 48,
      paddingHorizontal: space.md,
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.line,
    }}>
      <StateDot state={state} theme={theme} />
      <Text numberOfLines={1} style={[type.label, { color: theme.text, flexShrink: 1 }]}>
        {title.toUpperCase()}
      </Text>
      {detail ? <Text numberOfLines={1} style={[type.label, { color: theme.faint, flexShrink: 1 }]}>{detail.toUpperCase()}</Text> : null}
      <View style={{ flex: 1 }} />
      {latency !== undefined ? <Text style={[type.label, { color: theme.faint }]}>{latency}MS</Text> : null}
      {onMenu ? (
        <Pressable accessibilityLabel="Controller settings" accessibilityRole="button" hitSlop={12} onPress={onMenu} style={{ padding: space.xs, gap: 3 }}>
          {[0, 1, 2].map((line) => (
            <View key={line} style={{ width: 17, height: 1.5, borderRadius: 1, backgroundColor: theme.text }} />
          ))}
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The whole screen when nothing is connected. One statement, one action, and a second way in for
 * people who cannot point a camera at the screen they are already looking at.
 */
function ConnectScreen({ theme, state, error, codeEntryOpen, pairingInput, manualAnswer, onScan, onOpenCodeEntry, onCancelCodeEntry, onChangeCode, onConnect, onCopyAnswer, onCancelConnection }: {
  theme: Theme;
  state: LinkState;
  error?: string;
  codeEntryOpen: boolean;
  pairingInput: string;
  manualAnswer: string;
  onScan(): void;
  onOpenCodeEntry(): void;
  onCancelCodeEntry(): void;
  onChangeCode(value: string): void;
  onConnect(): void;
  onCopyAnswer(): void;
  onCancelConnection(): void;
}) {
  const connecting = state === "connecting";
  const { maxWidth, displayScale, compact } = useLayout();
  return (
    <ScrollView
      contentContainerStyle={{ flexGrow: 1, padding: space.lg, gap: space.lg, alignItems: "center" }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ flex: 1, justifyContent: "center", gap: space.sm, width: "100%", maxWidth, paddingVertical: compact ? 0 : space.xl }}>
        <Text style={[type.display, {
          color: theme.text,
          fontSize: type.display.fontSize * displayScale,
          lineHeight: type.display.lineHeight * displayScale,
        }]}>
          {connecting ? "Connecting…" : "This phone is\nthe controller."}
        </Text>
        <Text style={[type.body, { color: theme.muted }]}>
          {connecting
            ? "Keep both devices on the same network."
            : "Scan the code on your game screen to pair. Nothing to install on the game side."}
        </Text>
      </View>

      {manualAnswer ? (
        <View style={{ gap: space.sm, width: "100%", maxWidth }}>
          <Label tone="muted">Send this back to the game</Label>
          <TextInput
            accessibilityLabel="Pairing answer to return to the host"
            editable={false}
            multiline
            selectTextOnFocus
            style={{
              color: theme.muted,
              backgroundColor: theme.surface,
              borderColor: theme.line,
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderRadius: radius.control,
              padding: space.md,
              maxHeight: 120,
              fontSize: 12,
            }}
            value={manualAnswer}
          />
          <Button label="Copy" wide tone="strong" onPress={onCopyAnswer} />
          {/* Manual pairing used to offer only Copy. A player who changed their mind, or whose game
              had moved on, had no way back to the start — the only exit was force-quitting. */}
          <Button label="Start over" wide tone="bare" onPress={onCancelConnection} />
        </View>
      ) : codeEntryOpen ? (
        <View style={{ gap: space.sm, width: "100%", maxWidth }}>
          <TextInput
            accessibilityLabel="Pairing code"
            autoCapitalize="none"
            autoCorrect={false}
            // The field only exists because the player just tapped "Enter code instead", so focus
            // follows their own action rather than stealing it on arrival — the case this rule
            // exists to prevent. Without it they must tap twice to do the thing they just asked for.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            multiline
            onChangeText={onChangeCode}
            placeholder="Paste the full connection link or 101L2 code"
            placeholderTextColor={theme.faint}
            style={{
              color: theme.text,
              backgroundColor: theme.surface,
              borderColor: theme.line,
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderRadius: radius.control,
              padding: space.md,
              minHeight: 96,
              maxHeight: 160,
              fontSize: 13,
            }}
            value={pairingInput}
          />
          {error ? <Text style={[type.body, { color: theme.text }]}>{error}</Text> : null}
          <Button label="Connect" wide tone="strong" onPress={onConnect} />
          <Button label="Back" wide tone="bare" onPress={onCancelCodeEntry} />
        </View>
      ) : (
        <View style={{ gap: space.sm, width: "100%", maxWidth }}>
          <Button label="Scan code" wide tone="strong" onPress={onScan} />
          <Button label="Enter code instead" wide onPress={onOpenCodeEntry} />
          {/* A pairing that never completes — the wrong network, a game that has since closed —
              otherwise left the player watching "Connecting…" with nothing to press. */}
          {connecting ? <Button label="Cancel" wide tone="bare" onPress={onCancelConnection} /> : null}
        </View>
      )}

      {error && !codeEntryOpen ? <Text style={[type.body, { color: theme.text, width: "100%", maxWidth }]}>{error}</Text> : null}

      <Text style={[type.body, { color: theme.faint, fontSize: 13, width: "100%", maxWidth }]}>
        No account, no telemetry, no cloud. Your inputs stay on your network.
      </Text>
    </ScrollView>
  );
}

/**
 * Once the link is up the controls get the entire screen. They lay out from the game's own JSON,
 * so this stays a container and nothing more — and because it simply fills whatever space exists,
 * it works upright, rotated, on a small phone and on a tablet without a special case for any.
 */
function PlaySurface({ theme, layout, controls, message, tone, values }: {
  theme: Theme;
  layout: ControllerLayout;
  controls: ControllerActions;
  message?: string;
  tone: "normal" | "warning" | "critical";
  values: Record<string, string | number | boolean>;
}) {
  const { landscape } = useLayout();
  const entries = Object.entries(values).slice(0, 4);
  const singleSwipe = layout.layout.length === 1 && layout.layout[0]?.type === "touch-surface" && Boolean(layout.layout[0].pressAction);
  return (
    <View style={{ flex: 1, backgroundColor: theme.bgLift }}>
      {message || entries.length ? (
        <View style={{
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          gap: 4,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.line,
        }}>
          {message ? (
            <Text numberOfLines={2} style={[type.body, { color: tone === "normal" ? theme.muted : theme.text, fontSize: 13 }]}>
              {message}
            </Text>
          ) : null}
          {entries.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
              {entries.map(([key, value]) => (
                <Text key={key} style={[type.label, { color: theme.faint }]}>
                  {key.toUpperCase()} <Text style={{ color: theme.text }}>{String(value)}</Text>
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {landscape ? (
        // Held in two hands, thumbs rest in the bottom corners — so the controls live there
        // rather than in the middle of the screen. Nothing scrolls in this orientation: a control
        // you have to find is a control you have already missed.
        <View style={{ flex: 1, justifyContent: "flex-end", paddingHorizontal: space.lg + (Platform.OS === "android" && singleSwipe ? 48 : 0), paddingBottom: GESTURE_INSET }}>
          <ControllerPanel layout={layout} controls={controls} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end", padding: space.md, paddingBottom: GESTURE_INSET }}
          keyboardShouldPersistTaps="handled"
        >
          <ControllerPanel layout={layout} controls={controls} />
        </ScrollView>
      )}
    </View>
  );
}

/** Everything that is not playing. Present only while it is being used. */
function Sheet({ visible, theme, onClose, children }: { visible: boolean; theme: Theme; onClose(): void; children: React.ReactNode }) {
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close settings" onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} />
      <SafeAreaView style={{ backgroundColor: theme.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }}>
        <View style={{ padding: space.lg, gap: space.lg }}>
          <View style={{ alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: theme.line }} />
          {children}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function Section({ theme, label, children }: { theme: Theme; label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text style={[type.label, { color: theme.faint }]}>{label.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function Chip({ theme, label, selected, onPress }: { theme: Theme; label: string; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radius.pill,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: selected ? theme.solid : theme.line,
        backgroundColor: selected ? theme.solid : pressed ? theme.surfacePressed : theme.surface,
      })}
    >
      <Text style={[type.action, { fontSize: 14, color: selected ? theme.onSolid : theme.text }]}>{label}</Text>
    </Pressable>
  );
}

/** Raw numbers for tuning motion. Values only — the labels are already the units. */
function Readout({ theme, readout, calibration }: {
  theme: Theme;
  readout: MotionReadout;
  calibration: { sensitivity: number; deadZone: number; smoothing: number };
}) {
  const degrees = (value: number) => `${Math.round((value * 180) / Math.PI)}°`;
  const rows: Array<[string, string]> = [
    ["Rate", `${Math.round(readout.sampleRate)} Hz`],
    ["Pitch", degrees(readout.angles.pitch)],
    ["Roll", degrees(readout.angles.roll)],
    ["Sensitivity", calibration.sensitivity.toFixed(2)],
  ];
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      {rows.map(([key, value]) => (
        <View key={key} style={{ minWidth: 76, gap: 2 }}>
          <Text style={[type.label, { color: theme.faint }]}>{key.toUpperCase()}</Text>
          <Text style={[type.title, { color: theme.text }]}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Pairing persistence, which must never be able to fail a connection.
 *
 * `expo-secure-store` is keychain-backed on iOS and throws `KeyChainException: A required
 * entitlement isn't present` wherever the app has no keychain entitlement — including any build
 * made with signing disabled, which is how simulator builds are produced here. Convenience is not
 * worth a working link, so storage failures do not fail the live session. Expired or malformed
 * saved tickets are rejected and removed at the next read when the keychain permits removal.
 */
async function rememberPairing(ticket: string) {
  await savedPairing.remember(ticket);
}

async function forgetPairing() {
  await savedPairing.forget();
}

async function readSavedPairing() {
  return savedPairing.read();
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}
