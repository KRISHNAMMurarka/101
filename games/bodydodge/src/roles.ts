import type { SessionRole } from "@101/session";

export const BODYDODGE_ROLES = [
  {
    id: "mover",
    label: "Movement Panel",
    playerId: "player-1",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["haptics"],
    layout: {
      title: "Body Movement",
      accent: "#b5ff66",
      layout: [
        { type: "dpad", action: "body.move", label: "STEP / LEAN" },
        { type: "button", action: "duck", label: "DUCK" },
        { type: "button", action: "jump", label: "JUMP", emphasis: "primary" },
        { type: "button", action: "armsRaised", label: "ARMS UP" },
      ],
    },
  },
] as const satisfies readonly SessionRole[];
