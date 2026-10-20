import type { SessionRole } from "../../../packages/game-host/src/game-session.ts";

export const BEATFORGE_ROLES: readonly SessionRole[] = [
  {
    id: "performer",
    label: "Movement Performer",
    playerId: "role-performer",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["gyroscope", "haptics"],
    layout: {
      title: "Beat Performer",
      accent: "#ff73c9",
      motion: { action: "gesture", mode: "wand", label: "Swing direction", gestures: { swing: "beat.swing" } },
      layout: [
        { type: "touch-surface", action: "gesture", pressAction: "beat.swing", label: "SWING DIRECTION" },
        { type: "button", action: "beat.left", label: "LEFT SLASH" },
        { type: "button", action: "beat.right", label: "RIGHT SLASH" },
        { type: "button", action: "beat.punch", label: "PUNCH", emphasis: "primary" },
        { type: "button", action: "beat.raise", label: "RAISE" },
        { type: "button", action: "beat.duck", label: "DUCK" },
      ],
    },
  },
];
