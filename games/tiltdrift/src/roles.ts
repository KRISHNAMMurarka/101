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
      handedness: "right",
      motion: { action: "steer", mode: "tilt", label: "Phone tilt" },
      layout: [
        { type: "joystick", action: "steer", label: "WHEEL", side: "left", zone: "thumb", size: "large", span: 2, priority: 100, deadZone: .14, responseCurve: 1.35 },
        { type: "trigger", action: "boost", label: "BOOST", side: "right", zone: "index", size: "large", priority: 100 },
        { type: "analog-button", action: "brake", label: "BRAKE", side: "right", zone: "thumb", size: "large", priority: 90 },
        { type: "shoulder", action: "drift", label: "DRIFT", side: "right", zone: "shoulder", size: "medium", priority: 80 },
      ],
    },
  },
] as const satisfies readonly SessionRole[];
