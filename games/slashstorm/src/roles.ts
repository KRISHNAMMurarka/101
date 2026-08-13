import type { SessionRole } from "@101/session";

const swordLayout = (title: string, accent: string) => ({
  title,
  accent,
  motion: { action: "aim", mode: "wand" as const, label: "Phone orientation", gestures: { swing: "slash" } },
  layout: [
    { type: "touch-surface" as const, action: "aim", label: "BLADE" },
    { type: "button" as const, action: "trigger", label: "SLASH", emphasis: "danger" as const },
  ],
});

export const SLASHSTORM_ROLES = [
  {
    id: "sword-one",
    label: "Sword One",
    playerId: "player-1",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["gyroscope", "haptics"],
    layout: swordLayout("Sword One", "#ff5c35"),
  },
  {
    id: "sword-two",
    label: "Sword Two",
    playerId: "player-2",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["gyroscope", "haptics"],
    layout: swordLayout("Sword Two", "#50e3ff"),
  },
] as const satisfies readonly SessionRole[];
