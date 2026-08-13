import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";

import type { ControllerLayout, LinkState } from "@101/protocol";

import { ControllerPanel, type ControllerActions } from "./src/controls";
import { ControllerSession, type ControllerAssignment } from "./src/controller-session";
import { NativeMotionController, type MotionReadout } from "./src/motion-controller";
import { CONTROLLER_PRESETS, DEFAULT_PRESET } from "./src/presets";

const DEVICE_ID_KEY = "101-link-device-id-v1";
const LAST_PAIRING_KEY = "101-link-last-pairing-v1";

export default function App() {
  const [deviceId, setDeviceId] = useState("");
  const [pairingInput, setPairingInput] = useState("");
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
  const [latency, setLatency] = useState<number>();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [motionReadout, setMotionReadout] = useState<MotionReadout>();
  const [calibration, setCalibration] = useState({ sensitivity: 1, deadZone: 0.04, smoothing: 0.22 });
  const sessionRef = useRef<ControllerSession | undefined>(undefined);
  const motionRef = useRef<NativeMotionController | undefined>(undefined);
  const readoutRenderedAt = useRef(0);

  const haptic = useCallback(async (pattern: "tap" | "impact" | "warning") => {
    if (pattern === "tap") await Haptics.selectionAsync();
    else if (pattern === "impact") await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    else await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, []);

  const connect = useCallback(async (value: string) => {
    const input = value.trim();
    // Returning silently here made Connect look like a dead button: nothing moved, nothing
    // explained itself, and the only way to tell an empty field from a broken app was a debugger.
    if (!input) {
      setError("Paste a 101 pairing ticket or scan the host's QR code first.");
      return;
    }
    if (!sessionRef.current) {
      setError("101 Link is still starting up. Try again in a moment.");
      return;
    }
    setError(undefined);
    setManualAnswer("");
    setLinkState("connecting");
    try {
      if (input.startsWith("101C2.") || input.startsWith("101J2.")) {
        const answer = await sessionRef.current.connectManual(input);
        setManualAnswer(answer);
        await SecureStore.deleteItemAsync(LAST_PAIRING_KEY);
      } else {
        await sessionRef.current.connect(input);
        await SecureStore.setItemAsync(LAST_PAIRING_KEY, input);
      }
      setPairingInput(input);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to connect to 101 Hub");
      setLinkState("failed");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
      const id = existing ?? `link-${Crypto.randomUUID()}`;
      if (!existing) await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
      if (!cancelled) setDeviceId(id);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    const motion = new NativeMotionController((readout) => {
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
      state: setLinkState,
      layout: (next, fromHost) => {
        layoutRef.current = next;
        setLayout(next);
        setHostControlled(fromHost);
      },
      assignment: setAssignment,
      hostState: (values, message, tone) => {
        setHostValues(values);
        setHostMessage(message);
        setHostTone(tone ?? "normal");
      },
      haptic: (pattern) => void haptic(pattern),
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
    void (async () => {
      const initialUrl = await Linking.getInitialURL();
      const saved = await SecureStore.getItemAsync(LAST_PAIRING_KEY);
      const candidate = initialUrl?.includes("pair") ? initialUrl : saved;
      if (active && candidate) {
        setPairingInput(candidate);
        await connect(candidate);
      }
    })();
    const link = Linking.addEventListener("url", ({ url }) => {
      setPairingInput(url);
      void connect(url);
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") session.releaseAll();
    });
    return () => {
      active = false;
      link.remove();
      appState.remove();
      motion.stop();
      void session.disconnect();
      sessionRef.current = undefined;
      motionRef.current = undefined;
    };
  }, [connect, deviceId, haptic]);

  const controls = useMemo<ControllerActions>(() => ({
    action: (name, value) => sessionRef.current?.setAction(name, value),
    axis: (name, value) => sessionRef.current?.setAxis(name, value),
    vector: (name, x, y) => sessionRef.current?.setVector(name, x, y),
    localHaptic: () => void haptic("tap"),
  }), [haptic]);

  const enableMotion = async () => {
    try {
      await motionRef.current?.start();
      setMotionEnabled(true);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Motion sensors could not start");
    }
  };

  const calibrate = () => {
    try {
      motionRef.current?.calibrateNeutral();
      if (motionRef.current) setCalibration(motionRef.current.calibration);
      void haptic("impact");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Start motion sensing before calibration");
    }
  };

  const choosePreset = (preset: (typeof CONTROLLER_PRESETS)[number]) => {
    if (hostControlled && linkState === "connected") return;
    layoutRef.current = preset.layout;
    setLayout(preset.layout);
    sessionRef.current?.useLocalLayout(preset.layout);
  };

  const openScanner = async () => {
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (permission.granted) setScannerOpen(true);
    else setError("Camera permission is needed only to scan the local pairing QR");
  };

  const disconnect = async () => {
    await sessionRef.current?.disconnect();
    await SecureStore.deleteItemAsync(LAST_PAIRING_KEY);
    setHostControlled(false);
    setManualAnswer("");
    setLinkState("disconnected");
    setAssignment(undefined);
  };

  const activePreset = CONTROLLER_PRESETS.find((preset) => preset.layout.title === layout.title);
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>LOCAL CONTROLLER</Text>
            <Text style={styles.brand}>101 <Text style={styles.brandAccent}>LINK</Text></Text>
          </View>
          <StatePill state={linkState} />
        </View>

        <View style={styles.privacyBar}>
          <Text style={styles.privacyTitle}>PRIVATE BY DEFAULT</Text>
          <Text style={styles.privacyCopy}>No account, telemetry, cloud relay, microphone, or camera recording.</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>Connect to 101 Hub</Text>
            {latency !== undefined ? <Text style={styles.latency}>{latency} ms</Text> : null}
          </View>
          <TextInput
            accessibilityLabel="101 pairing code or URL"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={setPairingInput}
            placeholder="Scan QR, paste 101L2 ticket, or paste a manual 101C2/101J2 offer"
            placeholderTextColor="#63708A"
            style={styles.input}
            value={pairingInput}
          />
          <View style={styles.actionRow}>
            <ActionButton label="SCAN QR" onPress={() => void openScanner()} primary />
            <ActionButton label="CONNECT" onPress={() => void connect(pairingInput)} />
            {linkState === "connected" || linkState === "connecting" ? (
              <ActionButton label="DISCONNECT" onPress={() => void disconnect()} danger />
            ) : null}
          </View>
          {manualAnswer ? (
            <View style={styles.manualAnswer}>
              <Text style={styles.manualAnswerTitle}>RETURN THIS ANSWER TO THE HOST</Text>
              <TextInput
                accessibilityLabel="Manual WebRTC answer"
                editable={false}
                multiline
                selectTextOnFocus
                style={styles.answerInput}
                value={manualAnswer}
              />
              <ActionButton
                label="COPY ANSWER"
                onPress={() => {
                  void Clipboard.setStringAsync(manualAnswer);
                  void haptic("tap");
                }}
                primary
              />
            </View>
          ) : null}
          {assignment ? (
            <View style={styles.assignment}>
              <Text style={styles.assignmentGame}>{assignment.gameId.toUpperCase()}</Text>
              <Text style={styles.assignmentRole}>{assignment.role} · {assignment.playerId}</Text>
            </View>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>

        {!hostControlled || linkState !== "connected" ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>CONTROLLER MODES</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>
              {CONTROLLER_PRESETS.map((preset) => (
                <Pressable
                  key={preset.id}
                  onPress={() => choosePreset(preset)}
                  style={[styles.preset, activePreset?.id === preset.id && styles.presetActive]}
                >
                  <Text style={styles.presetName}>{preset.name}</Text>
                  <Text style={styles.presetDescription}>{preset.description}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : (
          <View style={styles.hostLayoutNotice}>
            <Text style={styles.sectionTitle}>HOST-ASSIGNED CONTROLLER</Text>
            <Text style={styles.hostLayoutCopy}>This reusable panel was sent by {assignment?.gameId ?? "the game"}. It will change automatically when the host changes games.</Text>
          </View>
        )}

        {layout.motion ? (
          <View style={styles.motionActions}>
            <ActionButton label={motionEnabled ? "MOTION ON" : "ENABLE MOTION"} onPress={() => void enableMotion()} primary={!motionEnabled} />
            <ActionButton label="SET NEUTRAL" onPress={calibrate} />
          </View>
        ) : null}

        <View style={styles.controllerHeader}>
          <Text style={styles.controllerTitle}>{layout.title ?? "101 Controller"}</Text>
          <Text style={styles.controllerSub}>{hostControlled ? "DYNAMIC JSON LAYOUT" : "LOCAL PRESET"}</Text>
        </View>
        <ControllerPanel layout={layout} controls={controls} />

        {hostMessage || Object.keys(hostValues).length ? (
          <HostState values={hostValues} message={hostMessage} tone={hostTone} />
        ) : null}

        {activePreset?.sensorLab ? (
          <SensorLab
            readout={motionReadout}
            calibration={calibration}
            update={(field, value) => {
              if (field === "sensitivity") motionRef.current?.setSensitivity(value);
              if (field === "deadZone") motionRef.current?.setDeadZone(value);
              if (field === "smoothing") motionRef.current?.setSmoothing(value);
              if (motionRef.current) setCalibration(motionRef.current.calibration);
            }}
          />
        ) : null}

        <Text style={styles.deviceId}>DEVICE {deviceId || "INITIALIZING"}</Text>
      </ScrollView>

      <Modal animationType="slide" visible={scannerOpen} onRequestClose={() => setScannerOpen(false)}>
        <View style={styles.scanner}>
          <CameraView
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            facing="back"
            onBarcodeScanned={({ data }) => {
              setScannerOpen(false);
              setPairingInput(data);
              void connect(data);
            }}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.scanFrame} />
          <Text style={styles.scanText}>Point at the QR shown by your private 101 Hub</Text>
          <Pressable onPress={() => setScannerOpen(false)} style={styles.scanClose}>
            <Text style={styles.scanCloseText}>CANCEL</Text>
          </Pressable>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function StatePill({ state }: { state: LinkState }) {
  const connected = state === "connected";
  return (
    <View style={[styles.statePill, connected && styles.statePillConnected]}>
      <View style={[styles.stateDot, connected && styles.stateDotConnected]} />
      <Text style={[styles.stateText, connected && styles.stateTextConnected]}>{state.toUpperCase()}</Text>
    </View>
  );
}

function ActionButton({ label, onPress, primary, danger }: { label: string; onPress(): void; primary?: boolean; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.actionButton, primary && styles.actionButtonPrimary, danger && styles.actionButtonDanger, pressed && styles.actionPressed]}>
      <Text style={[styles.actionButtonText, primary && styles.actionButtonTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

function HostState({ values, message, tone }: { values: Record<string, string | number | boolean>; message?: string; tone: "normal" | "warning" | "critical" }) {
  return (
    <View style={[styles.hostState, tone === "warning" && styles.hostStateWarning, tone === "critical" && styles.hostStateCritical]}>
      <Text style={styles.hostStateLabel}>HOST STATE</Text>
      {message ? <Text style={styles.hostStateMessage}>{message}</Text> : null}
      <View style={styles.valueGrid}>
        {Object.entries(values).map(([name, value]) => (
          <View key={name} style={styles.valueItem}>
            <Text style={styles.valueName}>{name}</Text>
            <Text style={styles.valueText}>{String(value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function SensorLab({
  readout,
  calibration,
  update,
}: {
  readout?: MotionReadout;
  calibration?: { sensitivity: number; deadZone: number; smoothing: number };
  update(field: "sensitivity" | "deadZone" | "smoothing", value: number): void;
}) {
  return (
    <View style={styles.lab}>
      <Text style={styles.sectionTitle}>101 MOTION LAB</Text>
      <View style={styles.labGrid}>
        <Metric label="SAMPLE" value={`${Math.round(readout?.sampleRate ?? 0)} Hz`} />
        <Metric label="PITCH" value={formatDegrees(readout?.angles.pitch)} />
        <Metric label="ROLL" value={formatDegrees(readout?.angles.roll)} />
        <Metric label="YAW" value={formatDegrees(readout?.angles.yaw)} />
        <Metric label="ACCEL" value={formatVector(readout?.filtered.acceleration)} />
        <Metric label="GYRO" value={formatVector(readout?.filtered.angularVelocity)} />
      </View>
      {(["sensitivity", "deadZone", "smoothing"] as const).map((field) => {
        const value = calibration?.[field] ?? 0;
        const step = field === "sensitivity" ? 0.1 : 0.02;
        return (
          <View key={field} style={styles.tuneRow}>
            <Text style={styles.tuneName}>{field.toUpperCase()}</Text>
            <ActionButton label="−" onPress={() => update(field, value - step)} />
            <Text style={styles.tuneValue}>{value.toFixed(2)}</Text>
            <ActionButton label="+" onPress={() => update(field, value + step)} />
          </View>
        );
      })}
      <Text style={styles.labPrivacy}>Filtering, calibration and gesture recognition run on this device. Only normalized numbers and actions are sent to the paired game.</Text>
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function formatDegrees(value?: number) {
  return `${((value ?? 0) * 180 / Math.PI).toFixed(1)}°`;
}

function formatVector(value?: readonly number[]) {
  return (value ?? [0, 0, 0]).map((component) => component.toFixed(1)).join("  ");
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#070C15" },
  content: { padding: 18, paddingBottom: 52, gap: 18, maxWidth: 920, width: "100%", alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 },
  eyebrow: { color: "#7E8BA2", fontSize: 10, fontWeight: "900", letterSpacing: 2 },
  brand: { color: "#F2F6FF", fontSize: 34, fontWeight: "900", letterSpacing: -1.5 },
  brandAccent: { color: "#54F0C3" },
  statePill: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 99, backgroundColor: "#161F31", borderWidth: 1, borderColor: "#2A354A" },
  statePillConnected: { backgroundColor: "#0F2B25", borderColor: "#1E6A55" },
  stateDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#758198" },
  stateDotConnected: { backgroundColor: "#54F0C3" },
  stateText: { color: "#A9B4C6", fontSize: 10, fontWeight: "900" },
  stateTextConnected: { color: "#7EF5D2" },
  privacyBar: { backgroundColor: "#0D211E", borderColor: "#1A4B40", borderWidth: 1, borderRadius: 14, padding: 13 },
  privacyTitle: { color: "#54F0C3", fontSize: 10, fontWeight: "900", letterSpacing: 1.4 },
  privacyCopy: { color: "#9AC3B7", marginTop: 3, fontSize: 12, lineHeight: 17 },
  card: { backgroundColor: "#0E1625", borderRadius: 18, borderWidth: 1, borderColor: "#202B3F", padding: 15, gap: 12 },
  cardTitleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { color: "#F0F5FF", fontSize: 17, fontWeight: "800" },
  latency: { color: "#54F0C3", fontSize: 12, fontWeight: "800" },
  input: { minHeight: 70, borderRadius: 12, backgroundColor: "#09111F", borderWidth: 1, borderColor: "#28344B", color: "#DDE7F8", padding: 12, fontSize: 12, textAlignVertical: "top" },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  actionButton: { minHeight: 42, paddingHorizontal: 14, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#1B2840", borderWidth: 1, borderColor: "#31405B" },
  actionButtonPrimary: { backgroundColor: "#54F0C3", borderColor: "#54F0C3" },
  actionButtonDanger: { backgroundColor: "#351822", borderColor: "#6B283B" },
  actionButtonText: { color: "#D8E2F2", fontSize: 11, fontWeight: "900", letterSpacing: 0.7 },
  actionButtonTextPrimary: { color: "#061510" },
  actionPressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  assignment: { backgroundColor: "#101E33", borderRadius: 10, padding: 11 },
  manualAnswer: { gap: 8, backgroundColor: "#141D2D", borderRadius: 11, padding: 10 },
  manualAnswerTitle: { color: "#FFD166", fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  answerInput: { maxHeight: 90, borderRadius: 8, backgroundColor: "#070E19", color: "#AAB8CE", padding: 9, fontSize: 9 },
  assignmentGame: { color: "#62A8FF", fontSize: 10, fontWeight: "900", letterSpacing: 1.2 },
  assignmentRole: { color: "#E7EEFA", fontSize: 14, fontWeight: "700", marginTop: 2 },
  error: { color: "#FF8094", lineHeight: 18, fontSize: 12 },
  section: { gap: 10 },
  sectionTitle: { color: "#8290A8", fontSize: 11, fontWeight: "900", letterSpacing: 1.4 },
  presetRow: { gap: 10, paddingRight: 18 },
  preset: { width: 190, minHeight: 112, padding: 13, borderRadius: 14, borderWidth: 1, borderColor: "#28344A", backgroundColor: "#0E1727" },
  presetActive: { borderColor: "#54F0C3", backgroundColor: "#112822" },
  presetName: { color: "#EDF3FF", fontSize: 14, fontWeight: "800" },
  presetDescription: { color: "#8D9AB0", fontSize: 11, lineHeight: 16, marginTop: 6 },
  hostLayoutNotice: { borderLeftWidth: 3, borderLeftColor: "#62A8FF", paddingLeft: 12, gap: 5 },
  hostLayoutCopy: { color: "#9BA8BC", lineHeight: 18, fontSize: 12 },
  motionActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  controllerHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", borderBottomWidth: 1, borderBottomColor: "#1F2A3C", paddingBottom: 10 },
  controllerTitle: { color: "#F0F5FF", fontSize: 24, fontWeight: "900" },
  controllerSub: { color: "#6F7D94", fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  hostState: { backgroundColor: "#111D2F", borderWidth: 1, borderColor: "#2E405B", borderRadius: 15, padding: 14 },
  hostStateWarning: { backgroundColor: "#2B2411", borderColor: "#66531D" },
  hostStateCritical: { backgroundColor: "#32131C", borderColor: "#7A293E" },
  hostStateLabel: { color: "#7F8FA9", fontSize: 9, fontWeight: "900", letterSpacing: 1.3 },
  hostStateMessage: { color: "#F1F5FC", fontSize: 15, fontWeight: "700", marginTop: 5 },
  valueGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  valueItem: { minWidth: 100, backgroundColor: "#0C1422", borderRadius: 9, padding: 9 },
  valueName: { color: "#7A899F", fontSize: 9, textTransform: "uppercase" },
  valueText: { color: "#DCE6F6", fontWeight: "800", marginTop: 2 },
  lab: { backgroundColor: "#0D1726", borderRadius: 16, borderWidth: 1, borderColor: "#233047", padding: 14, gap: 12 },
  labGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  metric: { minWidth: "31%", flexGrow: 1, backgroundColor: "#09111E", borderRadius: 10, padding: 10 },
  metricLabel: { color: "#6F7D92", fontSize: 8, fontWeight: "900", letterSpacing: 1 },
  metricValue: { color: "#54F0C3", fontSize: 13, fontWeight: "800", marginTop: 4 },
  tuneRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  tuneName: { color: "#9DA9BA", flex: 1, fontSize: 10, fontWeight: "800" },
  tuneValue: { color: "#EDF4FF", width: 46, textAlign: "center", fontVariant: ["tabular-nums"] },
  labPrivacy: { color: "#74839A", fontSize: 10, lineHeight: 15 },
  deviceId: { color: "#46536A", textAlign: "center", fontSize: 8, fontWeight: "800", letterSpacing: 1 },
  scanner: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  scanFrame: { width: 260, height: 260, borderRadius: 24, borderWidth: 3, borderColor: "#54F0C3" },
  scanText: { position: "absolute", bottom: 120, left: 30, right: 30, textAlign: "center", color: "white", fontSize: 15, fontWeight: "700" },
  scanClose: { position: "absolute", top: 58, right: 22, backgroundColor: "#101927CC", paddingHorizontal: 16, paddingVertical: 11, borderRadius: 99 },
  scanCloseText: { color: "white", fontWeight: "900", fontSize: 11 },
});
