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
import { radius, space, type, useLayout, useTheme, type Theme } from "./src/theme";
import { Button, Label, StateDot } from "./src/ui";

const DEVICE_ID_KEY = "101-link-device-id-v1";
const LAST_PAIRING_KEY = "101-link-last-pairing-v1";

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
  const t = useTheme();
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
  const [sheetOpen, setSheetOpen] = useState(false);
  const [codeEntryOpen, setCodeEntryOpen] = useState(false);
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
      setError("Paste a pairing code, or scan the code on your game screen.");
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
        await forgetPairing();
      } else {
        await sessionRef.current.connect(input);
        // Remembering the pairing is a convenience for next launch. It used to sit inside this
        // try block, so a keychain write failing *after* a successful connection reported the
        // whole pairing as failed — the player was connected and being told they were not.
        await rememberPairing(input);
      }
      setPairingInput(input);
      setCodeEntryOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reach that 101 Hub.");
      setLinkState("failed");
    }
  }, []);

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
      // This line used to be an unguarded keychain read directly after the launch URL was
      // retrieved. Where the keychain is unavailable it threw, the surrounding `void`-ed async
      // function rejected, and `connect` below never ran — so a deep link that had arrived
      // perfectly well was dropped one line after it was read, on iOS only.
      const saved = await readSavedPairing();
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
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (permission.granted) setScannerOpen(true);
    else setError("101 Link needs the camera only to read the pairing code on your game screen.");
  };

  const disconnect = async () => {
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
          onOpenCodeEntry={() => { setCodeEntryOpen(true); setError(undefined); }}
          onCancelCodeEntry={() => setCodeEntryOpen(false)}
          onChangeCode={setPairingInput}
          onConnect={() => void connect(pairingInput)}
          onCopyAnswer={() => { void Clipboard.setStringAsync(manualAnswer); void haptic("tap"); }}
        />
      )}

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

      <Modal animationType="fade" visible={scannerOpen} onRequestClose={() => setScannerOpen(false)}>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
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
          <SafeAreaView style={{ flex: 1, justifyContent: "space-between", padding: space.lg }}>
            <View />
            <View style={{ alignSelf: "center", width: 232, height: 232, borderRadius: radius.card, borderWidth: 2, borderColor: "rgba(255,255,255,0.9)" }} />
            <View style={{ gap: space.md }}>
              <Text style={[type.body, { color: "rgba(255,255,255,0.8)", textAlign: "center" }]}>
                Point at the code on your game screen
              </Text>
              <Button label="Cancel" wide onPress={() => setScannerOpen(false)} />
            </View>
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
function ConnectScreen({ theme, state, error, codeEntryOpen, pairingInput, manualAnswer, onScan, onOpenCodeEntry, onCancelCodeEntry, onChangeCode, onConnect, onCopyAnswer }: {
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
            placeholder="Paste the pairing code"
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
          <Button label="Connect" wide tone="strong" onPress={onConnect} />
          <Button label="Back" wide tone="bare" onPress={onCancelCodeEntry} />
        </View>
      ) : (
        <View style={{ gap: space.sm, width: "100%", maxWidth }}>
          <Button label="Scan code" wide tone="strong" onPress={onScan} />
          <Button label="Enter code instead" wide onPress={onOpenCodeEntry} />
        </View>
      )}

      {error ? <Text style={[type.body, { color: theme.text, width: "100%", maxWidth }]}>{error}</Text> : null}

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
        <View style={{ flex: 1, justifyContent: "flex-end", paddingHorizontal: space.lg, paddingBottom: GESTURE_INSET }}>
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
 * worth a working link, so both writes swallow their failure.
 */
async function rememberPairing(ticket: string) {
  try {
    await SecureStore.setItemAsync(LAST_PAIRING_KEY, ticket);
  } catch {
    // Nothing to do: the session is already up, and the next launch simply starts fresh.
  }
}

async function forgetPairing() {
  try {
    await SecureStore.deleteItemAsync(LAST_PAIRING_KEY);
  } catch {
    // Same reasoning: failing to forget must not fail the thing the player asked for.
  }
}

async function readSavedPairing() {
  try {
    return await SecureStore.getItemAsync(LAST_PAIRING_KEY);
  } catch {
    return null;
  }
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}
