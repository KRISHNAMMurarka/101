import { useState } from "react";
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";

import type { ControllerElement, ControllerLayout } from "@101/protocol";

export interface ControllerActions {
  action(name: string, active: boolean | number): void;
  axis(name: string, value: number): void;
  vector(name: string, x: number, y: number): void;
  localHaptic(): void;
}

export function ControllerPanel({ layout, controls }: { layout: ControllerLayout; controls: ControllerActions }) {
  const accent = layout.accent ?? "#54F0C3";
  return (
    <View style={styles.panel}>
      {layout.motion ? (
        <View style={[styles.motionBadge, { borderColor: accent }]}>
          <Text style={[styles.motionBadgeText, { color: accent }]}>{layout.motion.label ?? layout.motion.mode.toUpperCase()}</Text>
          <Text style={styles.motionHint}>PHONE MOTION ACTIVE</Text>
        </View>
      ) : null}
      <View style={styles.grid}>
        {layout.layout.map((element, index) => (
          <Control key={`${element.type}-${element.action}-${index}`} element={element} accent={accent} controls={controls} />
        ))}
      </View>
    </View>
  );
}

function Control({ element, accent, controls }: { element: ControllerElement; accent: string; controls: ControllerActions }) {
  if (element.type === "button") {
    const danger = element.emphasis === "danger";
    const primary = element.emphasis === "primary";
    const color = danger ? "#FF526D" : primary ? accent : "#25334B";
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={element.label}
        onPressIn={() => {
          controls.localHaptic();
          controls.action(element.action, true);
        }}
        onPressOut={() => controls.action(element.action, false)}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: color, borderColor: primary || danger ? color : "#3B4A64" },
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.buttonText, (primary || danger) && styles.buttonTextDark]}>{element.label}</Text>
      </Pressable>
    );
  }
  if (element.type === "slider") {
    return <SliderControl element={element} accent={accent} update={controls.axis} />;
  }
  return (
    <VectorControl
      action={element.action}
      label={element.label ?? element.type.toUpperCase()}
      mode={element.type}
      accent={accent}
      update={controls.vector}
    />
  );
}

function VectorControl({
  action,
  label,
  mode,
  accent,
  update,
}: {
  action: string;
  label: string;
  mode: "joystick" | "dpad" | "touch-surface";
  accent: string;
  update(name: string, x: number, y: number): void;
}) {
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const move = (x: number, y: number) => {
    let nextX = clamp((x / size.width) * 2 - 1);
    let nextY = clamp(-((y / size.height) * 2 - 1));
    if (mode === "dpad") {
      if (Math.abs(nextX) > Math.abs(nextY)) nextY = 0;
      else nextX = 0;
      nextX = Math.abs(nextX) < 0.25 ? 0 : Math.sign(nextX);
      nextY = Math.abs(nextY) < 0.25 ? 0 : Math.sign(nextY);
    }
    setPosition({ x: nextX, y: nextY });
    update(action, nextX, nextY);
  };
  const release = () => {
    setPosition({ x: 0, y: 0 });
    update(action, 0, 0);
  };
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => move(event.nativeEvent.locationX, event.nativeEvent.locationY),
    onPanResponderMove: (event) => move(event.nativeEvent.locationX, event.nativeEvent.locationY),
    onPanResponderRelease: release,
    onPanResponderTerminate: release,
  });
  const onLayout = (event: LayoutChangeEvent) => setSize(event.nativeEvent.layout);
  return (
    <View style={[styles.vectorWrap, mode === "touch-surface" && styles.touchWrap]}>
      <Text style={styles.controlLabel}>{label}</Text>
      <View
        accessibilityLabel={label}
        accessibilityRole="adjustable"
        onLayout={onLayout}
        style={[styles.vectorPad, mode === "touch-surface" && styles.touchPad]}
        {...responder.panHandlers}
      >
        {mode === "dpad" ? (
          <>
            <View style={[styles.dpadVertical, { backgroundColor: `${accent}22` }]} />
            <View style={[styles.dpadHorizontal, { backgroundColor: `${accent}22` }]} />
          </>
        ) : null}
        <View
          style={[
            styles.knob,
            { borderColor: accent, backgroundColor: `${accent}33` },
            {
              transform: [
                { translateX: position.x * Math.min(56, size.width * 0.3) },
                { translateY: -position.y * Math.min(56, size.height * 0.3) },
              ],
            },
          ]}
        />
      </View>
    </View>
  );
}

function SliderControl({
  element,
  accent,
  update,
}: {
  element: Extract<ControllerElement, { type: "slider" }>;
  accent: string;
  update(name: string, value: number): void;
}) {
  const min = element.min ?? -1;
  const max = element.max ?? 1;
  const step = element.step ?? 0.01;
  const [width, setWidth] = useState(1);
  const [value, setValue] = useState((min + max) / 2);
  const setFromX = (x: number) => {
    const raw = min + clamp01(x / width) * (max - min);
    const next = Math.max(min, Math.min(max, Math.round(raw / step) * step));
    setValue(next);
    update(element.action, next);
  };
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => setFromX(event.nativeEvent.locationX),
    onPanResponderMove: (event) => setFromX(event.nativeEvent.locationX),
  });
  const ratio = (value - min) / (max - min);
  return (
    <View style={styles.sliderWrap}>
      <View style={styles.sliderLabelRow}>
        <Text style={styles.controlLabel}>{element.label}</Text>
        <Text style={[styles.sliderValue, { color: accent }]}>{value.toFixed(2)}</Text>
      </View>
      <View
        accessibilityLabel={element.label}
        accessibilityRole="adjustable"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={styles.slider}
        {...responder.panHandlers}
      >
        <View style={[styles.sliderFill, { backgroundColor: accent, width: `${ratio * 100}%` }]} />
        <View style={[styles.sliderKnob, { borderColor: accent, left: `${ratio * 100}%` }]} />
      </View>
    </View>
  );
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

const styles = StyleSheet.create({
  panel: { gap: 14 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  motionBadge: { width: "100%", borderWidth: 1, borderRadius: 12, padding: 12, backgroundColor: "#111B2D" },
  motionBadgeText: { fontSize: 13, fontWeight: "900", letterSpacing: 1.2 },
  motionHint: { color: "#8290A8", fontSize: 10, fontWeight: "700", marginTop: 3 },
  button: { minWidth: "46%", flexGrow: 1, minHeight: 92, borderRadius: 18, borderWidth: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  pressed: { transform: [{ scale: 0.96 }], opacity: 0.82 },
  buttonText: { color: "#ECF3FF", fontSize: 18, fontWeight: "900", letterSpacing: 0.8 },
  buttonTextDark: { color: "#08101F" },
  vectorWrap: { width: "48%", minWidth: 150, flexGrow: 1, gap: 8 },
  touchWrap: { width: "100%" },
  controlLabel: { color: "#A9B5C9", fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  vectorPad: { height: 186, borderRadius: 93, borderWidth: 1, borderColor: "#33425C", backgroundColor: "#101A2B", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  touchPad: { height: 230, borderRadius: 18 },
  knob: { width: 58, height: 58, borderRadius: 29, borderWidth: 2 },
  dpadVertical: { position: "absolute", width: 58, height: 160, borderRadius: 12 },
  dpadHorizontal: { position: "absolute", width: 160, height: 58, borderRadius: 12 },
  sliderWrap: { width: "100%", paddingVertical: 12, gap: 10 },
  sliderLabelRow: { flexDirection: "row", justifyContent: "space-between" },
  sliderValue: { fontSize: 12, fontWeight: "900" },
  slider: { height: 34, justifyContent: "center", backgroundColor: "#152139", borderRadius: 17, overflow: "visible" },
  sliderFill: { height: 8, borderRadius: 4 },
  sliderKnob: { position: "absolute", width: 28, height: 28, borderRadius: 14, borderWidth: 3, backgroundColor: "#0A1220", marginLeft: -14 },
});
