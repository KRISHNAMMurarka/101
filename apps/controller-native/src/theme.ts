import { useColorScheme, useWindowDimensions } from "react-native";

/**
 * 101 Link design tokens.
 *
 * The palette carries no hue at all: black, white, and grey between them. That is a constraint,
 * not a shortage. A controller is held at arm's length in a dark room while the player looks at a
 * television, so the screen's job is to be legible and quiet, never to compete with the game.
 *
 * State is therefore expressed through *weight* rather than colour — a hollow ring becomes a solid
 * dot as the link comes up — which stays readable for colour-blind players and in direct sunlight,
 * where a green/amber/red indicator does not.
 *
 * Surfaces are glass: a low-opacity white (or black) fill over the ground with a hairline of the
 * same colour at higher opacity. Values follow edilec.com — a 0.06 fill under a 0.14 edge — which
 * reads as depth without shadow, and needs no blur, so it renders identically on both platforms.
 */
export interface Theme {
  scheme: "dark" | "light";
  /** Page ground. */
  bg: string;
  /** Slightly lifted ground for the play surface, so controls sit on their own plane. */
  bgLift: string;
  /** Glass fill. */
  surface: string;
  /** Glass fill, pressed. */
  surfacePressed: string;
  /** Hairline edge. */
  line: string;
  /** Stronger edge, for the focused or active element. */
  lineStrong: string;
  /** Primary text. */
  text: string;
  /** Secondary text: still readable, clearly subordinate. */
  muted: string;
  /** Tertiary text: labels and units. */
  faint: string;
  /** Inverted block — the one high-contrast move, reserved for the single primary action. */
  solid: string;
  onSolid: string;
}

const DARK: Theme = {
  scheme: "dark",
  bg: "#0A0A0A",
  bgLift: "#101010",
  surface: "rgba(255,255,255,0.06)",
  surfacePressed: "rgba(255,255,255,0.13)",
  line: "rgba(255,255,255,0.14)",
  lineStrong: "rgba(255,255,255,0.34)",
  text: "#F2F2F2",
  muted: "rgba(242,242,242,0.56)",
  faint: "rgba(242,242,242,0.32)",
  solid: "#F2F2F2",
  onSolid: "#0A0A0A",
};

const LIGHT: Theme = {
  scheme: "light",
  bg: "#FFFFFF",
  bgLift: "#F7F7F7",
  surface: "rgba(0,0,0,0.045)",
  surfacePressed: "rgba(0,0,0,0.10)",
  line: "rgba(0,0,0,0.12)",
  lineStrong: "rgba(0,0,0,0.32)",
  text: "#0A0A0A",
  muted: "rgba(10,10,10,0.58)",
  faint: "rgba(10,10,10,0.34)",
  solid: "#0A0A0A",
  onSolid: "#FFFFFF",
};

export function useTheme(): Theme {
  return useColorScheme() === "light" ? LIGHT : DARK;
}

/**
 * One spacing scale, used everywhere. Alignment problems are usually spacing problems: when every
 * gap is drawn from four steps, edges line up on their own.
 */
export const space = { xs: 6, sm: 10, md: 16, lg: 24, xl: 40 } as const;

export const radius = { control: 18, card: 22, pill: 999 } as const;

/**
 * Three type roles and no more.
 *
 * `display` is tight and heavy so a short phrase reads as a statement rather than a heading.
 * `body` is quiet. `label` is the only uppercase in the app — wide-tracked, small, and reserved for
 * machine facts like state and units, which is what makes those facts scannable without shouting.
 */
/**
 * One measure for every screen 101 Link runs on: a phone upright, the same phone rotated, a
 * tablet, and a foldable opened flat.
 *
 * Text is capped at a readable measure and centred rather than stretched, because a line running
 * the full width of a tablet is genuinely harder to read than the same line on a phone. Display
 * type grows with the screen so a statement still reads as one on a large device, and the play
 * surface is exempt from the cap entirely — controls should use every pixel they are given.
 */
export function useLayout() {
  const { width, height } = useWindowDimensions();
  const shortest = Math.min(width, height);
  return {
    /** Reading measure. Wide screens get whitespace at the margins, not longer lines. */
    maxWidth: 520,
    /** Scales the statement with the device without a second type scale to maintain. */
    displayScale: shortest >= 600 ? 1.3 : shortest >= 380 ? 1.1 : 1,
    /** True when the screen is wider than tall, which changes how controls should be grouped. */
    landscape: width > height,
    compact: height < 620,
  };
}

export const type = {
  display: { fontSize: 34, fontWeight: "800", letterSpacing: -1.1, lineHeight: 38 },
  title: { fontSize: 19, fontWeight: "700", letterSpacing: -0.3 },
  body: { fontSize: 15, fontWeight: "500", lineHeight: 21 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.6 },
  action: { fontSize: 15, fontWeight: "700", letterSpacing: 0.2 },
} as const;
