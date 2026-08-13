import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { radius, space, type, useTheme, type Theme } from "./theme.ts";

/**
 * The app's whole component vocabulary. Four pieces, reused everywhere.
 *
 * Keeping it this small is the point: every button in 101 Link is the same button, so a player
 * learns the interface once. It also removes the drift that produced nine different card styles
 * and a dozen near-identical greys in the previous layout.
 */

export function Button({ label, onPress, tone = "quiet", wide, disabled }: {
  label: string;
  onPress(): void;
  /** `strong` is the inverted block. At most one is visible at a time, on purpose. */
  tone?: "strong" | "quiet" | "bare";
  wide?: boolean;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: 48,
          paddingHorizontal: space.lg,
          justifyContent: "center",
          alignItems: "center",
          borderRadius: radius.pill,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: tone === "strong" ? t.solid : tone === "bare" ? "transparent" : t.line,
          backgroundColor: tone === "strong" ? t.solid : tone === "bare" ? "transparent" : t.surface,
          opacity: disabled ? 0.4 : 1,
        },
        wide && { alignSelf: "stretch" },
        pressed && !disabled && (tone === "strong" ? { opacity: 0.82 } : { backgroundColor: t.surfacePressed }),
      ]}
    >
      <Text style={[type.action, { color: tone === "strong" ? t.onSolid : t.text }]}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return (
    <View style={[{
      backgroundColor: t.surface,
      borderColor: t.line,
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderRadius: radius.card,
      padding: space.md,
      gap: space.sm,
    }, style]}>
      {children}
    </View>
  );
}

export function Label({ children, tone = "faint" }: { children: React.ReactNode; tone?: "faint" | "muted" | "text" }) {
  const t = useTheme();
  return <Text style={[type.label, { color: t[tone] }]}>{children}</Text>;
}

/**
 * Link state, drawn rather than coloured.
 *
 * Empty ring → nothing connected. Ringed dot → negotiating. Filled disc → live. The word beside it
 * says the same thing, so the indicator never carries meaning on its own.
 */
export function StateDot({ state, theme }: { state: "idle" | "connecting" | "connected" | "failed"; theme: Theme }) {
  const filled = state === "connected";
  const active = state === "connecting";
  return (
    <View style={{
      width: 9,
      height: 9,
      borderRadius: 5,
      borderWidth: 1.5,
      borderColor: filled || active ? theme.text : theme.faint,
      backgroundColor: filled ? theme.text : "transparent",
    }} />
  );
}
