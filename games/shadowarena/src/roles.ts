import type { SessionRole } from "@101/session";

export const SHADOW_ARENA_ROLES: readonly SessionRole[] = [
  {
    id: "fighter",
    label: "Arena Fighter",
    playerId: "role-fighter",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["haptics"],
    layout: {
      title: "Shadow Fighter",
      accent: "#f98b70",
      layout: [
        { type: "dpad", action: "combat.move", label: "MOVE / EVADE" },
        { type: "button", action: "combat.punchLeft", label: "LEFT PUNCH" },
        { type: "button", action: "combat.punchRight", label: "RIGHT PUNCH", emphasis: "primary" },
        { type: "button", action: "combat.block", label: "BLOCK" },
        { type: "button", action: "combat.jump", label: "JUMP" },
        { type: "button", action: "combat.duck", label: "DUCK" },
        { type: "button", action: "combat.special", label: "SHADOW BURST", emphasis: "danger" }
      ]
    }
  }
];
