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

import { radius, space, type, useLayout, useTheme, type Theme } from "./theme.ts";

/**
 * Sticks are sized in points rather than percentages.
 *
 * A percentage width inside a flex row stretched them into tall ovals on a tablet and on an
 * unfolded phone, which both looks wrong and moves the travel limits somewhere the thumb does not
 * expect. A stick is a physical object: it should be the same comfortable size on every device,
 * and the extra space on a larger screen belongs to the margins.
 */
function useStickSize() {
  const { landscape, compact } = useLayout();
  return compact || landscape ? 168 : 208;
}

export interface ControllerActions {
  action(name: string, active: boolean | number): void;
  axis(name: string, value: number): void;
  vector(name: string, x: number, y: number): void;
  localHaptic(): void;
}

/**
 * Renders whatever panel the game asked for.
 *
 * Layouts may carry an `accent` colour. 101 Link deliberately ignores it: ten games each picking
 * their own hue turns one controller into ten unrelated ones, and a saturated fill under the
 * player's thumb is exactly where you least want attention. Emphasis is expressed with fill weight
 * and edge contrast instead, so a primary action still reads instantly in a dark room and remains
 * distinguishable to a colour-blind player.
 */
export function ControllerPanel({ layout, controls }: { layout: ControllerLayout; controls: ControllerActions }) {
  const t = useTheme();
  const { landscape } = useLayout();

  /**
   * A gamepad has a shape, so the panel is not a wrap grid.
   *
   * Reflowing every element through one `flexWrap` put a face button between the two sticks the
   * moment the screen got wide, which is not a controller any more. Sticks and pads are therefore
   * grouped on one side and pressable controls on the other: side by side when there is width for
   * it, stacked when there is not. The game still describes only *what* its controls are; where a
   * thumb expects to find them is the controller's problem to solve.
   */
  const isPad = (element: ControllerElement) =>
    element.type === "joystick" || element.type === "dpad" || element.type === "touch-surface";
  const entries = layout.layout.map((element, index) => ({ element, index }));
  const pads = entries.filter(({ element }) => isPad(element));
  const rest = entries.filter(({ element }) => !isPad(element));
  const wide = landscape && pads.length > 0 && rest.length > 0;

  const render = ({ element, index }: { element: ControllerElement; index: number }) => (
    <Control key={`${element.type}-${element.action}-${index}`} element={element} theme={t} controls={controls} />
  );

  return (
    <View style={{ gap: space.md }}>
      {layout.motion ? (
        <Text style={[type.label, { color: t.faint }]}>
          {(layout.motion.label ?? layout.motion.mode).toUpperCase()} · MOTION ACTIVE
        </Text>
      ) : null}
      <View style={wide ? styles.split : undefined}>
        {pads.length ? <View style={[styles.padGroup, wide && styles.splitSide, wide && styles.splitLeft]}>{pads.map(render)}</View> : null}
        {rest.length ? <View style={[styles.grid, wide && styles.splitSide, wide && styles.splitRight]}>{rest.map(render)}</View> : null}
      </View>
    </View>
  );
}

function Control({ element, theme, controls }: { element: ControllerElement; theme: Theme; controls: ControllerActions }) {
  if (element.type === "button") {
    const primary = element.emphasis === "primary";
    const danger = element.emphasis === "danger";
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
          {
            // Emphasis is carried by the edge, never by an inverted fill. A, B, X and Y are peers
            // on a gamepad, so a solid white A would shout over its own siblings; the one inverted
            // block in the app stays reserved for the single app action worth taking next.
            backgroundColor: pressed ? theme.surfacePressed : theme.surface,
            borderColor: primary || danger ? theme.lineStrong : theme.line,
            borderWidth: primary || danger ? 2 : StyleSheet.hairlineWidth * 2,
          },
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.buttonText, { color: theme.text }]}>{element.label}</Text>
      </Pressable>
    );
  }
  if (element.type === "slider") {
    return <SliderControl element={element} theme={theme} update={controls.axis} />;
  }
  return (
    <VectorControl
      action={element.action}
      label={element.label ?? element.type.toUpperCase()}
      mode={element.type}
      theme={theme}
      update={controls.vector}
    />
  );
}

function VectorControl({
  action,
  label,
  mode,
  theme,
  update,
}: {
  action: string;
  label: string;
  mode: "joystick" | "dpad" | "touch-surface";
  theme: Theme;
  update(name: string, x: number, y: number): void;
}) {
  const stick = useStickSize();
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [held, setHeld] = useState(false);
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
    setHeld(false);
    setPosition({ x: 0, y: 0 });
    update(action, 0, 0);
  };
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      setHeld(true);
      move(event.nativeEvent.locationX, event.nativeEvent.locationY);
    },
    onPanResponderMove: (event) => move(event.nativeEvent.locationX, event.nativeEvent.locationY),
    onPanResponderRelease: release,
    onPanResponderTerminate: release,
  });
  const onLayout = (event: LayoutChangeEvent) => setSize(event.nativeEvent.layout);
  return (
    <View style={[styles.vectorWrap, mode === "touch-surface" && styles.touchWrap]}>
      <Text style={[type.label, { color: theme.faint }]}>{label.toUpperCase()}</Text>
      <View
        accessibilityLabel={label}
        accessibilityRole="adjustable"
        onLayout={onLayout}
        style={[
          styles.vectorPad,
          mode === "touch-surface" ? styles.touchPad : { width: stick, height: stick },
          { backgroundColor: theme.surface, borderColor: held ? theme.lineStrong : theme.line },
        ]}
        {...responder.panHandlers}
      >
        {mode === "dpad" ? (
          <>
            <View style={[styles.dpadVertical, { backgroundColor: theme.surface }]} />
            <View style={[styles.dpadHorizontal, { backgroundColor: theme.surface }]} />
          </>
        ) : null}
        <View
          style={[
            styles.knob,
            {
              borderColor: theme.text,
              backgroundColor: held ? theme.solid : theme.surfacePressed,
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
  theme,
  update,
}: {
  element: Extract<ControllerElement, { type: "slider" }>;
  theme: Theme;
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
        <Text style={[type.label, { color: theme.faint }]}>{element.label.toUpperCase()}</Text>
        <Text style={[type.label, { color: theme.text }]}>{value.toFixed(2)}</Text>
      </View>
      <View
        accessibilityLabel={element.label}
        accessibilityRole="adjustable"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={[styles.slider, { backgroundColor: theme.surface, borderColor: theme.line }]}
        {...responder.panHandlers}
      >
        <View style={[styles.sliderFill, { backgroundColor: theme.text, width: `${ratio * 100}%` }]} />
        <View style={[styles.sliderKnob, { borderColor: theme.text, backgroundColor: theme.solid, left: `${ratio * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignContent: "center" },
  /**
   * Pads left, pressables right, both hugging the outside edges where thumbs actually rest.
   * Centring each group in its half looked tidier and put every control further from the hand.
   */
  split: { flexDirection: "row", gap: space.lg, alignItems: "flex-end" },
  splitSide: { flex: 1 },
  splitLeft: { justifyContent: "flex-start" },
  splitRight: { justifyContent: "flex-end" },
  padGroup: { flexDirection: "row", flexWrap: "wrap", gap: space.md, justifyContent: "center", alignItems: "center" },
  button: {
    // Two per row, then grow to share whatever is left. `minWidth` alone let a single button
    // swallow the whole row, stacking four face buttons into a column on a wide screen.
    flexBasis: "47%",
    flexGrow: 1,
    minWidth: 120,
    minHeight: 96,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
    padding: space.md,
  },
  pressed: { transform: [{ scale: 0.97 }] },
  buttonText: { fontSize: 17, fontWeight: "700", letterSpacing: 0.2, textAlign: "center" },
  vectorWrap: { gap: space.xs, alignItems: "center", flexGrow: 1 },
  touchWrap: { width: "100%", alignItems: "stretch" },
  vectorPad: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  touchPad: { width: "100%", height: 220, borderRadius: radius.control },
  knob: { width: 60, height: 60, borderRadius: 30, borderWidth: 2 },
  dpadVertical: { position: "absolute", width: 58, height: 162, borderRadius: 10 },
  dpadHorizontal: { position: "absolute", width: 162, height: 58, borderRadius: 10 },
  sliderWrap: { width: "100%", paddingVertical: space.sm, gap: space.sm },
  sliderLabelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  slider: {
    height: 36,
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: "visible",
  },
  sliderFill: { height: 8, borderRadius: 4, marginHorizontal: 4 },
  sliderKnob: { position: "absolute", width: 28, height: 28, borderRadius: 14, borderWidth: 2, marginLeft: -14 },
});

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
