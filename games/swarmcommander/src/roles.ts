import type { SessionRole } from "@101/session";

export const SWARM_COMMANDER_ROLES = [
  {
    id: "navigator", label: "Swarm Navigator", playerId: "role-navigator", requiredCapabilities: ["touch"], preferredCapabilities: ["gyroscope", "haptics"],
    layout: { title: "Swarm Vector", accent: "#f6c15c", motion: { action: "swarm.direction", mode: "tilt", label: "Tilt collective direction" }, layout: [
      { type: "joystick", action: "swarm.direction", label: "COLLECTIVE VECTOR" },
      { type: "button", action: "swarm.ability.recall", label: "INSTANT RECALL", emphasis: "danger" },
      { type: "button", action: "swarm.ability.shield", label: "EMERGENCY SHIELD", emphasis: "primary" },
    ] },
  },
  {
    id: "tactician", label: "Formation Tactician", playerId: "role-tactician", requiredCapabilities: ["touch"], preferredCapabilities: ["haptics"],
    layout: { title: "Formation Command", accent: "#50e3ff", layout: [
      { type: "touch-surface", action: "swarm.command", label: "COMMAND TARGET" },
      { type: "button", action: "swarm.select", label: "SELECT REGION" },
      { type: "button", action: "swarm.formation.cluster", label: "CLUSTER" },
      { type: "button", action: "swarm.formation.line", label: "LINE" },
      { type: "button", action: "swarm.formation.wedge", label: "WEDGE", emphasis: "primary" },
      { type: "button", action: "swarm.formation.ring", label: "RING" },
      { type: "button", action: "swarm.formation.grid", label: "GRID" },
      { type: "button", action: "swarm.ability.pulse", label: "ION PULSE", emphasis: "danger" },
    ] },
  },
] as const satisfies readonly SessionRole[];
