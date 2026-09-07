import type { CameraKind } from "../../lib/camera-plan";

/**
 * Where to put the camera and where to stand, drawn from the side.
 *
 * A side elevation rather than a plan or a perspective, and that is the whole argument of the
 * picture. Seen from above, a camera is a dot with a wedge and every placement looks equally
 * correct. Seen from the side, the thing that actually goes wrong is visible: a laptop camera sits
 * about half a metre up and looks slightly upward, so a lid tilted back aims its vertical field of
 * view at the ceiling and the player's legs fall out of shot no matter how far away they stand.
 * That is the most common bad setup there is, and it cannot be drawn in plan.
 *
 * Inline SVG rather than an image: it is a dozen shapes, it must respond to what the check is
 * currently saying, and it has to take its colours from the theme like everything else. `currentColor`
 * throughout, so the figure inherits whatever the surrounding text is.
 */
export function CameraPlacementFigure({
  kind,
  nudge,
}: {
  kind: CameraKind;
  /** What the check wants changed, so the drawing shows the correction rather than only naming it. */
  nudge?: "closer" | "back" | "left" | "right" | "lower-lid";
}) {
  return kind === "hands" ? <HandsFigure nudge={nudge} /> : <BodyFigure nudge={nudge} />;
}

const GROUND = 168;

/** A standing figure, drawn at a height that reads as a person rather than a pictogram. */
function Person({ x, height, dim = false }: { x: number; height: number; dim?: boolean }) {
  const head = GROUND - height;
  const shoulder = head + height * 0.18;
  const hip = head + height * 0.52;
  return (
    <g opacity={dim ? 0.28 : 1}>
      <circle cx={x} cy={head + height * 0.07} r={height * 0.07} />
      <path d={`M${x} ${shoulder} L${x} ${hip}`} />
      <path d={`M${x - height * 0.11} ${shoulder + height * 0.12} L${x} ${shoulder + height * 0.02} L${x + height * 0.11} ${shoulder + height * 0.12}`} />
      <path d={`M${x - height * 0.09} ${GROUND} L${x} ${hip} L${x + height * 0.09} ${GROUND}`} />
    </g>
  );
}

function BodyFigure({ nudge }: { nudge?: "closer" | "back" | "left" | "right" | "lower-lid" }) {
  const lensX = 56;
  const lensY = 96;
  // Where the person should be, and where the drawing shows them when the check wants them moved.
  const idealX = 224;
  const personX = nudge === "closer" ? 268 : nudge === "back" ? 172 : idealX;
  const tiltedBack = nudge === "lower-lid";

  return (
    <svg
      className="placement-figure"
      viewBox="0 0 320 200"
      preserveAspectRatio="xMidYMid meet"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      role="img"
      aria-label="Seen from the side: a camera on a desk, its view widening across the room, and a person standing in it a few steps back."
    >
      {/* The floor, and the desk the camera stands on. */}
      <path d={`M8 ${GROUND} H312`} />
      <path d={`M20 ${GROUND} V120 H96 V${GROUND}`} />

      {/* The screen, and the lens at the top of it. A lid tilted too far back is drawn leaning. */}
      <g transform={tiltedBack ? `rotate(-26 ${lensX} 120)` : undefined}>
        <path d={`M${lensX - 22} 120 V${lensY - 2} H${lensX + 22} V120 Z`} />
        <circle cx={lensX} cy={lensY + 6} r={2.5} fill="currentColor" stroke="none" />
      </g>

      {/*
        What the camera can see. Dashed because it is not a thing in the room — it is the argument
        the picture is making, and drawing it solid would read as a wall.
      */}
      <g strokeDasharray="5 5" opacity={0.55}>
        <path d={tiltedBack ? `M${lensX} ${lensY} L300 6` : `M${lensX} ${lensY} L300 26`} />
        <path d={tiltedBack ? `M${lensX} ${lensY} L300 110` : `M${lensX} ${lensY} L300 ${GROUND}`} />
      </g>

      {/* Where they are now, faint, when the check is asking them to move. */}
      {(nudge === "closer" || nudge === "back") && <Person x={idealX} height={104} dim />}
      <Person x={personX} height={104} />

      {/* The floor mark: a place to stand is easier to follow than a distance to estimate. */}
      <path d={`M${idealX - 20} ${GROUND + 8} H${idealX + 20}`} opacity={0.55} strokeDasharray="4 4" />
    </svg>
  );
}

function HandsFigure({ nudge }: { nudge?: "closer" | "back" | "left" | "right" | "lower-lid" }) {
  const lensX = 60;
  const lensY = 92;
  const handX = nudge === "closer" ? 176 : nudge === "back" ? 118 : 148;

  return (
    <svg
      className="placement-figure"
      viewBox="0 0 320 200"
      preserveAspectRatio="xMidYMid meet"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      role="img"
      aria-label="Seen from the side: someone sitting at a desk with a hand raised in front of the screen."
    >
      <path d={`M8 ${GROUND} H312`} />
      <path d={`M20 ${GROUND} V124 H120 V${GROUND}`} />

      <path d={`M${lensX - 24} 124 V${lensY - 4} H${lensX + 24} V124 Z`} />
      <circle cx={lensX} cy={lensY + 4} r={2.5} fill="currentColor" stroke="none" />

      <g strokeDasharray="5 5" opacity={0.55}>
        <path d={`M${lensX} ${lensY} L280 40`} />
        <path d={`M${lensX} ${lensY} L280 150`} />
      </g>

      {/* Seated: shoulders above the desk, one arm forward, hand open towards the lens. */}
      <circle cx={248} cy={78} r={13} />
      <path d="M248 91 V128" />
      <path d="M248 128 H286 V168" />
      <path d={`M244 104 L${handX + 16} 104`} />
      <g transform={`translate(${handX} 104)`}>
        <path d="M0 0 v-16 M6 0 v-20 M12 0 v-18 M18 -2 v-14" />
        <path d="M-4 0 h26 v10 a13 13 0 01-26 0 Z" />
      </g>
    </svg>
  );
}

/**
 * The rectangle a body should fill, over the live picture.
 *
 * Separate from the figure because it means something different: the figure teaches a placement in
 * the room, this marks a target in the image. Drawn in the DOM rather than on the canvas so it can
 * take a border from the same tokens as everything else and cannot be lost when the canvas clears.
 */
export function FramingInset({ settled, kind }: { settled: boolean; kind: CameraKind }) {
  return (
    <div className={settled ? "framing-inset settled" : "framing-inset"} aria-hidden="true" data-kind={kind} />
  );
}
