import type { SessionRole } from "@101/session";

export const TILTDRIFT_ROLES = [
  {
    id: "driver",
    label: "Driver",
    playerId: "player-1",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["gyroscope", "haptics"],
    layout: {
      title: "Steering Wheel",
      accent: "#50e3ff",
      motion: { action: "steer", mode: "tilt", label: "Phone tilt" },
      layout: [
        { type: "joystick", action: "steer", label: "WHEEL" },
        { type: "button", action: "brake", label: "BRAKE" },
        { type: "button", action: "drift", label: "DRIFT" },
        { type: "button", action: "boost", label: "BOOST", emphasis: "primary" },
      ],
    },
  },
] as const satisfies readonly SessionRole[];
