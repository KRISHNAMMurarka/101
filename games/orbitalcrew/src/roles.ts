import type { SessionRole } from "@101/session";

export const ORBITAL_CREW_ROLES = [
  {
    id: "pilot",
    label: "Pilot",
    playerId: "role-pilot",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["gyroscope"],
    layout: {
      title: "Flight Control",
      accent: "#50e3ff",
      motion: { action: "flight", mode: "tilt", label: "Phone tilt" },
      layout: [
        { type: "joystick", action: "flight", label: "FLIGHT VECTOR" },
        { type: "button", action: "overdrive", label: "EVASIVE BOOST", emphasis: "primary" },
      ],
    },
  },
  {
    id: "weapons",
    label: "Weapons",
    playerId: "role-weapons",
    requiredCapabilities: ["touch"],
    layout: {
      title: "Weapons Array",
      accent: "#ff5c35",
      layout: [
        { type: "touch-surface", action: "target", label: "TARGET VECTOR" },
        { type: "button", action: "fire", label: "FIRE", emphasis: "danger" },
      ],
    },
  },
  {
    id: "shields",
    label: "Shield Orientation",
    playerId: "role-shields",
    requiredCapabilities: ["touch"],
    layout: {
      title: "Shield Control",
      accent: "#b5ff66",
      layout: [
        { type: "slider", action: "shield", label: "ORIENTATION", min: -1, max: 1, step: 0.01 },
        { type: "button", action: "fortify", label: "FORTIFY", emphasis: "primary" },
      ],
    },
  },
  {
    id: "reactor",
    label: "Reactor",
    playerId: "role-reactor",
    requiredCapabilities: ["touch"],
    layout: {
      title: "Reactor Routing",
      accent: "#f8d96a",
      layout: [
        { type: "slider", action: "power", label: "OUTPUT", min: 0.2, max: 1, step: 0.01 },
        { type: "button", action: "vent", label: "VENT HEAT", emphasis: "normal" },
        { type: "button", action: "overdrive", label: "OVERDRIVE", emphasis: "danger" },
      ],
    },
  },
  {
    id: "emergency",
    label: "Emergency Response",
    playerId: "role-emergency",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["haptics"],
    layout: {
      title: "Emergency Station",
      accent: "#d368ff",
      layout: [
        { type: "button", action: "emergency", label: "RECALL + SHIELD", emphasis: "danger" },
      ],
    },
  },
] as const satisfies readonly SessionRole[];
