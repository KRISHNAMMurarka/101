/**
 * The icon set.
 *
 * Before this file, `grep -l "<svg"` across app/, packages/, games/ and apps/controller-native/
 * returned zero files. The entire iconography was ~56 Unicode characters typed inline (22 ↗, 12 ←,
 * 11 →, and singles of ▲ ▼ ◀ ▶ ◆ ◇ ⌁ ↔ ∞) plus three empty tags — <span/> <i/> <b/> — that CSS bent
 * into the same rotated rectangle, circle and bar on every game card. Three primitives stood in for
 * eleven games and for a product whose actual subject is physical hardware. That is what reads as
 * generated: not the drawing, the absence of one.
 *
 * Rules, fixed here and not negotiable per icon:
 *
 *   - 24×24 grid, geometry on 1px increments.
 *   - 1.5 stroke units, fill none, stroke currentColor.
 *   - Butt caps, miter joins. Square terminals, never rounded: the product's language is 1px
 *     hairlines and hard `box-shadow: 14px 14px 0` offsets, and a rounded cap visibly fights it.
 *     This is the single reason not to drop in Lucide or Feather.
 *   - Size is set on the wrapper, so a 16px icon renders its 1.5 units as exactly 1.0 device px and
 *     a 24px icon as 1.5px. Both land on whole or half pixels; nothing lands on a third, which is
 *     the usual reason a scaled set looks hand-made.
 *
 * The thirteen device symbols are keyed to the canonical `InputSource` values in
 * packages/input/src/index.ts, so a game's declared inputs render directly as the answer to the
 * question a player is actually asking: what do I need to play this?
 */

/* Proportion is what makes a monochrome device legible at 24px, so each body is drawn to the real
   object's ratio: a phone is 1:2.25 with an off-centre lens, a watch is 1:1 with two strap stubs
   and a crown, custom hardware is a DIP outline with four pins a side rather than a chip glyph. */
import type { InputSource } from "@101/input";

export const ICONS = {
  // — input sources, matching InputSource in packages/input —
  keyboard: "M2 7h20v11H2z M6 11h1 M10 11h1 M14 11h1 M18 11h1 M7 15h10",
  mouse: "M12 3h0a5 5 0 015 5v8a5 5 0 01-10 0V8a5 5 0 015-5z M12 7v3",
  touch: "M9 12V5a2 2 0 014 0v7 M13 12v-1a2 2 0 014 0v6a5 5 0 01-5 5h-1a5 5 0 01-4-2l-3-4a2 2 0 013-2l2 2",
  gamepad: "M6 9h12a4 4 0 010 8H6a4 4 0 010-8z M9 11v4 M7 13h4 M16 12h1 M18 14h1",
  "phone-motion": "M8 3h8v18H8z M10 5h1 M10 19h4",
  "watch-motion": "M8 8h8v8H8z M10 8V5h4v3 M10 16v3h4v-3 M16 11h2",
  "camera-hand": "M7 13V9a1 1 0 012 0v4 M10 13V6a1 1 0 012 0v7 M13 13V7a1 1 0 012 0v6 M16 13v-3a1 1 0 012 0v7a5 5 0 01-5 5h-1a5 5 0 01-5-5v-4",
  "camera-pose": "M12 3a2 2 0 110 4 2 2 0 010-4z M12 7v8 M7 10h10 M12 15l-3 6 M12 15l3 6",
  "camera-face": "M6 11a6 7 0 1112 0 6 7 0 01-12 0z M10 11v1 M14 11v1 M10 15h4 M3 7V4h3 M21 7V4h-3 M3 17v3h3 M21 17v3h-3",
  hid: "M9 3v5 M15 3v5 M7 8h10v4a5 5 0 01-10 0z M12 17v4",
  bluetooth: "M8 8l8 8-4 4V4l4 4-8 8",
  serial: "M2 12h4V8h4v8h4v-4h8",
  custom: "M8 5h8v14H8z M10 5a2 2 0 004 0 M8 8H5 M8 11H5 M8 14H5 M8 17H5 M16 8h3 M16 11h3 M16 14h3 M16 17h3",

  // — interface verbs —
  play: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  devices: "M2 5h13v9H2z M6 18h5 M8 14v4 M17 8h5v12h-5z",
  labs: "M10 3v6L5 19h14L14 9V3 M8 3h8 M8 14h8",
  arrow: "M4 12h15 M13 6l6 6-6 6",
  back: "M20 12H5 M11 6l-6 6 6 6",
  external: "M8 16L18 6 M10 6h8v8",
  check: "M4 13l5 5L20 6",
  close: "M5 5l14 14 M19 5L5 19",
  search: "M11 5a6 6 0 110 12 6 6 0 010-12z M15.5 15.5L20 20",
  chevron: "M9 5l7 7-7 7",
  plus: "M12 5v14 M5 12h14",
} as const satisfies Record<InputSource, string> & Record<string, string>;

export type IconName = keyof typeof ICONS;

/**
 * One wrapper owns every svg attribute, so no icon can drift from the rules above.
 * Decorative by default; pass `label` for the rare icon that is the only content of a control.
 */
export function Icon({ name, size = 24, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
