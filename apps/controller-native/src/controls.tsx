import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";

import {
  ControllerActionGesture,
  normalizeJoystick,
  resolveControllerSide,
} from "@101/link-controller";
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
  action(name: string, active: boolean | number, owner?: string): void;
  actions(values: Record<string, boolean | number>, owner: string): void;
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
  const authoredHandedness = layout.handedness ?? "right";
  const [handednessOverride, setHandednessOverride] = useState<{
    layout: ControllerLayout;
    value: "left" | "right";
  }>();
  // Layout objects are replaced atomically on every role/configuration change. Tying the override
  // to that identity resets it synchronously, before the new controls paint, without an effect
  // that would briefly show the previous game's arrangement.
  const playerHandedness = handednessOverride?.layout === layout
    ? handednessOverride.value
    : authoredHandedness;
  const swapTouchActive = useRef(false);

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
  const entries = layout.layout
    .map((element, index) => {
      // Optional placement hints must not make every existing layout collapse into the centre.
      // Legacy layouts keep the proven gamepad heuristic: pads left, actions right,
      // and sliders centered so handedness does not move a shared range control.
      const inferredSide = element.side ?? (element.type === "slider" ? "center" : isPad(element) ? "left" : "right");
      return {
        element,
        index,
        side: resolveControllerSide(inferredSide, authoredHandedness, playerHandedness),
      };
    })
    .sort((a, b) => zoneRank(a.element.zone) - zoneRank(b.element.zone)
      || (b.element.priority ?? 50) - (a.element.priority ?? 50)
      || a.index - b.index);
  const left = entries.filter((entry) => entry.side === "left");
  const center = entries.filter((entry) => entry.side === "center");
  const right = entries.filter((entry) => entry.side === "right");
  const wide = landscape && left.length > 0 && right.length > 0;

  type Entry = (typeof entries)[number];
  const render = ({ element, index }: Entry, style?: ViewStyle) => (
    <View key={`${element.type}-${element.action}-${index}`} style={style ?? slotStyle(element)}>
      <Control element={element} theme={t} controls={controls} />
    </View>
  );

  const renderSide = (sideEntries: Entry[], side: "left" | "right") => {
    const upper = sideEntries.filter(({ element }) => element.zone === "shoulder" || element.zone === "index");
    const thumb = sideEntries.filter(({ element }) => element.zone !== "shoulder" && element.zone !== "index");
    const thumbPads = thumb.filter(({ element }) => isPad(element));
    const thumbActions = thumb.filter(({ element }) => !isPad(element));
    const nestedThumbs = landscape && thumbPads.length > 0 && thumbActions.length > 0;
    const compactActionGrid = nestedThumbs
      && thumbActions.length > 1
      && thumbActions.every(({ element }) => (element.span ?? 2) <= 2);
    const actionContent = compactActionGrid ? (
      <View style={styles.actionColumns}>
        <View style={styles.actionColumn}>{thumbActions.filter((_, index) => index % 2 === 0).map((entry) => render(entry, styles.actionSlot))}</View>
        <View style={styles.actionColumn}>{thumbActions.filter((_, index) => index % 2 === 1).map((entry) => render(entry, styles.actionSlot))}</View>
      </View>
    ) : <View style={[styles.grid, styles.thumbActions]}>{thumbActions.map((entry) => render(entry))}</View>;
    const thumbContent = nestedThumbs ? (
      <View style={styles.thumbSplit}>
        <View style={styles.thumbPads}>{thumbPads.map((entry) => render(entry, styles.naturalSlot))}</View>
        {actionContent}
      </View>
    ) : thumb.length ? <View style={styles.grid}>{thumb.map((entry) => render(entry))}</View> : null;
    if (landscape && upper.length && thumbContent) {
      const upperContent = <View style={styles.upperColumn}>{upper.map((entry) => render(entry, styles.upperSlot))}</View>;
      return (
        <View style={styles.landscapeSideRow}>
          {side === "left" ? upperContent : null}
          <View style={styles.thumbBody}>{thumbContent}</View>
          {side === "right" ? upperContent : null}
        </View>
      );
    }
    return (
      <>
        {upper.length ? <View style={styles.grid}>{upper.map((entry) => render(entry))}</View> : null}
        {thumbContent}
      </>
    );
  };

  const swapSides = () => {
    if (!swapTouchActive.current) return;
    swapTouchActive.current = false;
    controls.localHaptic();
    setHandednessOverride({
      layout,
      value: playerHandedness === "left" ? "right" : "left",
    });
  };

  return (
    <View style={{ gap: space.md }}>
      <View style={styles.panelMeta}>
        {layout.motion ? (
          <Text style={[type.label, { color: t.faint }]}>
            {(layout.motion.label ?? layout.motion.mode).toUpperCase()} · MOTION ACTIVE
          </Text>
        ) : <View />}
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Use ${playerHandedness === "left" ? "right" : "left"}-handed control layout`}
          onTouchStart={() => { swapTouchActive.current = true; }}
          onTouchEnd={swapSides}
          onTouchCancel={() => { swapTouchActive.current = false; }}
          style={[styles.handedness, { borderColor: t.line, backgroundColor: t.surface }]}
        >
          <Text style={[type.label, { color: t.muted }]}>
            {playerHandedness.toUpperCase()}-HANDED · SWAP SIDES
          </Text>
        </View>
      </View>
      {center.length ? <View style={styles.centerGroup}>{center.map((entry) => render(entry))}</View> : null}
      <View style={wide ? styles.split : styles.stack}>
        {left.length ? <View style={[styles.sideGroup, wide && { flex: sideWeight(left.length) }, styles.splitLeft]}>{renderSide(left, "left")}</View> : null}
        {right.length ? <View style={[styles.sideGroup, wide && { flex: sideWeight(right.length) }, styles.splitRight]}>{renderSide(right, "right")}</View> : null}
      </View>
    </View>
  );
}

function Control({ element, theme, controls }: { element: ControllerElement; theme: Theme; controls: ControllerActions }) {
  if (element.type === "button" || element.type === "shoulder") {
    return <DigitalActionControl element={element} theme={theme} controls={controls} />;
  }
  if (element.type === "trigger" || element.type === "analog-button") {
    return <AnalogActionControl element={element} theme={theme} controls={controls} />;
  }
  if (element.type === "slider") {
    return <SliderControl element={element} theme={theme} update={controls.axis} />;
  }
  return (
    <VectorControl
      element={element}
      theme={theme}
      update={controls.vector}
    />
  );
}

// Buttons deliberately avoid Pressable. Pressable joins React Native's responder system, and there
// is only ever one responder: pressing a button while a stick was held made the stick's
// PanResponder receive onPanResponderTerminate, which snapped the vector to neutral. Two-thumb play
// — the entire point of the landscape layout — was impossible. Raw touch events are delivered to
// the view under the finger without any responder negotiation, so a button press now cannot
// disturb a stick that another thumb is holding.
function DigitalActionControl({
  element,
  theme,
  controls,
}: {
  element: Extract<ControllerElement, { type: "button" | "shoulder" }>;
  theme: Theme;
  controls: ControllerActions;
}) {
  const { landscape } = useLayout();
  const owner = `${element.type}:${element.action}:${useId()}`;
  const [pressed, setPressed] = useState(false);
  const primary = element.type === "button" && element.emphasis === "primary";
  const danger = element.type === "button" && element.emphasis === "danger";
  const gesture = useMemo(() => new ControllerActionGesture(element, {
    emit: (values) => controls.actions(values, owner),
    onActiveChange: setPressed,
  }), [controls, element, owner]);
  useEffect(() => () => gesture.cancel(), [gesture]);
  const press = () => {
    controls.localHaptic();
    gesture.press();
  };
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={element.label}
      accessibilityState={{ selected: pressed }}
      onTouchStart={press}
      onTouchEnd={() => gesture.release()}
      onTouchCancel={() => gesture.cancel()}
      style={[
        styles.button,
        element.type === "shoulder" && styles.shoulder,
        actionSizeStyle(element.size, landscape),
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
      {element.interaction ? (
        <Text style={[styles.interactionText, { color: theme.faint }]}>{element.interaction.type.toUpperCase()}</Text>
      ) : null}
    </View>
  );
}

/**
 * Triggers and analog buttons use raw touch events for the same two-thumb reason as digital
 * actions. Vertical travel is deterministic on every phone: bottom is 0, top is 1. Native touch
 * force is deliberately not the primary signal because many current phones report no useful
 * pressure value at all.
 */
function AnalogActionControl({
  element,
  theme,
  controls,
}: {
  element: Extract<ControllerElement, { type: "trigger" | "analog-button" }>;
  theme: Theme;
  controls: ControllerActions;
}) {
  const { landscape } = useLayout();
  const owner = `${element.type}:${element.action}:${useId()}`;
  const [height, setHeight] = useState(1);
  const [value, setValue] = useState(0);
  const update = (event: GestureResponderEvent) => {
    const next = clamp01(1 - event.nativeEvent.locationY / height);
    setValue(next);
    controls.action(element.action, next, owner);
  };
  const release = () => {
    setValue(0);
    controls.action(element.action, 0, owner);
  };
  return (
    <View style={styles.analogWrap}>
      <View style={styles.sliderLabelRow}>
        <Text style={[type.label, { color: theme.faint }]}>{element.label.toUpperCase()}</Text>
        <Text style={[type.label, { color: theme.text }]}>{value.toFixed(2)}</Text>
      </View>
      <View
        accessible
        accessibilityLabel={element.label}
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 0, max: 1, now: value }}
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        onTouchStart={(event) => {
          controls.localHaptic();
          update(event);
        }}
        onTouchMove={update}
        onTouchEnd={release}
        onTouchCancel={release}
        style={[
          styles.analog,
          element.type === "analog-button" && styles.analogButton,
          analogSizeStyle(element.size, landscape),
          { backgroundColor: theme.surface, borderColor: value > 0 ? theme.lineStrong : theme.line },
        ]}
      >
        <View style={[styles.analogFill, { backgroundColor: theme.text, height: `${value * 100}%` }]} />
        <Text style={[styles.analogKind, { color: value > .55 ? theme.onSolid : theme.muted }]}>
          {element.type === "trigger" ? "TRIGGER" : "PRESSURE"}
        </Text>
      </View>
    </View>
  );
}

function VectorControl({
  element,
  theme,
  update,
}: {
  element: Extract<ControllerElement, { type: "joystick" | "dpad" | "touch-surface" }>;
  theme: Theme;
  update(name: string, x: number, y: number): void;
}) {
  const mode = element.type;
  const label = element.label ?? element.type.toUpperCase();
  const stick = useStickSize();
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [held, setHeld] = useState(false);
  const move = (x: number, y: number) => {
    let nextX = clamp((x / size.width) * 2 - 1);
    let nextY = clamp((y / size.height) * 2 - 1);
    if (mode === "joystick") {
      ({ x: nextX, y: nextY } = normalizeJoystick(
        nextX,
        nextY,
        element.deadZone ?? .12,
        element.responseCurve ?? 1,
      ));
    }
    if (mode === "dpad") {
      if (Math.abs(nextX) > Math.abs(nextY)) nextY = 0;
      else nextX = 0;
      nextX = Math.abs(nextX) < 0.25 ? 0 : Math.sign(nextX);
      nextY = Math.abs(nextY) < 0.25 ? 0 : Math.sign(nextY);
    }
    setPosition({ x: nextX, y: nextY });
    update(element.action, nextX, nextY);
  };
  const release = () => {
    setHeld(false);
    setPosition({ x: 0, y: 0 });
    update(element.action, 0, 0);
  };
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // A stick keeps the responder until the thumb holding it lifts. Without this, React Native's
    // default answer is "yes, take it", so any other control claiming the single global responder
    // terminated this one and dropped the vector to neutral mid-movement.
    onPanResponderTerminationRequest: () => false,
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
          mode === "touch-surface"
            ? [styles.touchPad, surfaceSizeStyle(element.size)]
            : stickDimensions(stick, element.size),
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
                { translateY: position.y * Math.min(56, size.height * 0.3) },
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
    // Same rule as a stick: a slider under a thumb is not surrendered to another control.
    onPanResponderTerminationRequest: () => false,
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
  stack: { gap: space.md },
  panelMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  handedness: {
    minHeight: 32,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  centerGroup: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, justifyContent: "center", alignItems: "center" },
  sideGroup: { gap: space.sm },
  landscapeSideRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  upperColumn: { width: 104, gap: space.sm, justifyContent: "flex-end" },
  upperSlot: { width: "100%" },
  thumbBody: { flex: 1 },
  thumbSplit: { flexDirection: "row", gap: space.sm, alignItems: "flex-end" },
  thumbPads: { alignItems: "center", justifyContent: "flex-end" },
  thumbActions: { flex: 1, alignSelf: "stretch", alignContent: "flex-end" },
  actionColumns: { flex: 1, flexDirection: "row", gap: space.xs, alignItems: "flex-end" },
  actionColumn: { flex: 1, gap: space.xs, justifyContent: "flex-end" },
  actionSlot: { width: "100%" },
  naturalSlot: { alignItems: "center" },
  /**
   * Pads left, pressables right, both hugging the outside edges where thumbs actually rest.
   * Centring each group in its half looked tidier and put every control further from the hand.
   */
  split: { flexDirection: "row", gap: space.lg, alignItems: "flex-end" },
  splitLeft: { justifyContent: "flex-start" },
  splitRight: { justifyContent: "flex-end" },
  button: {
    width: "100%",
    minHeight: 96,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
    padding: space.md,
    gap: space.xs,
  },
  shoulder: { minHeight: 64, borderRadius: 12 },
  pressed: { transform: [{ scale: 0.97 }] },
  buttonText: { fontSize: 17, fontWeight: "700", letterSpacing: 0.2, textAlign: "center" },
  interactionText: { fontSize: 9, fontWeight: "700", letterSpacing: 1.1 },
  analogWrap: { width: "100%", gap: space.xs },
  analog: {
    width: "100%",
    height: 144,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  analogButton: { height: 112, borderRadius: radius.pill },
  analogFill: { position: "absolute", left: 0, right: 0, bottom: 0 },
  analogKind: { fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  vectorWrap: { gap: space.xs, alignItems: "center" },
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

function zoneRank(zone: ControllerElement["zone"]) {
  if (zone === "shoulder") return 0;
  if (zone === "index") return 1;
  if (zone === "edge") return 2;
  if (zone === "thumb") return 3;
  return 2;
}

function slotStyle(element: ControllerElement): ViewStyle {
  const span = element.span === undefined ? undefined : Math.max(1, Math.min(4, element.span));
  if (span !== undefined) {
    const track = (["22%", "46%", "70%", "100%"] as const)[span - 1];
    return {
      // Leave room for the row gap. Exact 25/50/75% tracks wrap at narrow widths because the gap
      // is added on top of the percentage; 22/46/70% keeps the intended columns on small phones.
      flexBasis: track,
      width: track,
      flexGrow: span === 4 ? 1 : 0,
      alignItems: element.type === "joystick" || element.type === "dpad" ? "center" : "stretch",
    };
  }
  if (element.type === "touch-surface" || element.type === "slider") return { width: "100%" };
  if (element.type === "joystick" || element.type === "dpad") return { alignItems: "center" };
  return {
    flexBasis: "47%",
    flexGrow: 1,
    minWidth: element.size === "small" ? 88 : element.size === "large" ? 148 : 120,
  };
}

function actionSizeStyle(size: ControllerElement["size"], landscape: boolean): ViewStyle | undefined {
  if (landscape) return { minHeight: size === "large" ? 80 : size === "medium" ? 70 : 58 };
  if (size === "small") return { minHeight: 64 };
  if (size === "medium") return { minHeight: 96 };
  if (size === "large") return { minHeight: 128 };
  return undefined;
}

function analogSizeStyle(size: ControllerElement["size"], landscape: boolean): ViewStyle | undefined {
  if (landscape) return { height: size === "large" ? 96 : size === "medium" ? 78 : 64 };
  if (size === "small") return { height: 96 };
  if (size === "medium") return { height: 144 };
  if (size === "large") return { height: 184 };
  return undefined;
}

function surfaceSizeStyle(size: ControllerElement["size"]): ViewStyle | undefined {
  if (size === "small") return { height: 160 };
  if (size === "medium") return { height: 220 };
  if (size === "large") return { height: 280 };
  return undefined;
}

function stickDimensions(stick: number, size: ControllerElement["size"]): ViewStyle {
  const scale = size === "small" ? .7 : size === "large" ? 1.18 : 1;
  return { width: Math.round(stick * scale), height: Math.round(stick * scale) };
}

function sideWeight(elementCount: number) {
  // A side with a face-button cluster needs materially more width than a side with one stick.
  // Count-weighted halves keep sparse legacy panels balanced while letting a full gamepad place
  // four face controls in two columns instead of growing beyond the no-scroll landscape height.
  return Math.max(.8, Math.min(1.8, .2 + elementCount * .22));
}
