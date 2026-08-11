import type { SessionRole } from "@101/session";

export const ECHO_MAZE_ROLES: readonly SessionRole[] = [
  {
    id: "scanner",
    label: "Echo Scanner",
    playerId: "role-scanner",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["gyroscope", "haptics"],
    layout: {
      title: "Echo Scanner",
      accent: "#80a8ff",
      motion: { action: "maze.scanDirection", mode: "tilt", label: "Rotate to sweep the dark" },
      layout: [
        { type: "dpad", action: "maze.move", label: "NAVIGATE" },
        { type: "touch-surface", action: "maze.scanDirection", label: "SCANNER BEARING" },
        { type: "button", action: "maze.scan", label: "PING", emphasis: "primary" },
        { type: "button", action: "maze.flashlight", label: "LIGHT" },
        { type: "button", action: "maze.mark", label: "MARK" }
      ]
    }
  }
];
