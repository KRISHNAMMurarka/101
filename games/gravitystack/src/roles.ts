import type { SessionRole } from "@101/session";

export const GRAVITYSTACK_ROLES: readonly SessionRole[] = [
  {
    id: "gravity",
    label: "Gravity Controller",
    playerId: "role-gravity",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["gyroscope"],
    layout: {
      title: "Gravity Vector",
      accent: "#9e8cff",
      motion: { action: "gravity", mode: "tilt", label: "Phone tilt" },
      layout: [{ type: "touch-surface", action: "gravity", label: "DOWN VECTOR" }],
    },
  },
  {
    id: "builder",
    label: "Shape Builder",
    playerId: "role-builder",
    requiredCapabilities: ["touch"],
    layout: {
      title: "Builder Crane",
      accent: "#f8d96a",
      layout: [
        { type: "slider", action: "placeX", label: "DROP POSITION", min: -1, max: 1, step: .01 },
        { type: "button", action: "drop", label: "DROP SHAPE", emphasis: "primary" },
      ],
    },
  },
];
