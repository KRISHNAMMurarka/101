import { parseControllerLayout, type ControllerLayout } from "@101/protocol";

export interface ControllerPreset {
  id: string;
  name: string;
  description: string;
  sensorLab?: boolean;
  layout: ControllerLayout;
}

const preset = (
  id: string,
  name: string,
  description: string,
  layout: unknown,
  sensorLab = false,
): ControllerPreset => ({ id, name, description, sensorLab, layout: parseControllerLayout(layout) });

export const CONTROLLER_PRESETS: readonly ControllerPreset[] = [
  preset("classic", "Classic Controller", "D-pad, aim stick and four action buttons.", {
    title: "Classic Controller",
    accent: "#54F0C3",
    layout: [
      { type: "dpad", action: "move", label: "MOVE" },
      { type: "joystick", action: "aim", label: "AIM" },
      { type: "button", action: "buttonA", label: "A", emphasis: "primary" },
      { type: "button", action: "buttonB", label: "B" },
      { type: "button", action: "buttonX", label: "X" },
      { type: "button", action: "buttonY", label: "Y" }
    ]
  }),
  preset("gamepad", "Pro Gamepad", "Analog triggers, shoulders, tuned sticks and advanced button gestures.", {
    title: "Pro Gamepad",
    handedness: "right",
    layout: [
      {
        type: "shoulder", action: "bumperL", label: "LB",
        side: "left", zone: "shoulder", size: "small", span: 2, priority: 90,
        interaction: { type: "hold", thresholdMs: 450 }
      },
      {
        type: "trigger", action: "triggerL", label: "LT",
        side: "left", zone: "index", size: "medium", span: 2, priority: 85
      },
      {
        type: "joystick", action: "move", label: "MOVE",
        side: "left", zone: "thumb", size: "small", span: 4, priority: 100,
        deadZone: 0.14, responseCurve: 1.35
      },
      {
        type: "shoulder", action: "bumperR", label: "RB",
        side: "right", zone: "shoulder", size: "small", span: 2, priority: 90,
        interaction: { type: "double-tap", intervalMs: 300 }
      },
      {
        type: "trigger", action: "triggerR", label: "RT",
        side: "right", zone: "index", size: "medium", span: 2, priority: 85
      },
      {
        type: "joystick", action: "aim", label: "AIM",
        side: "right", zone: "thumb", size: "small", span: 4, priority: 100,
        deadZone: 0.1, responseCurve: 1.2
      },
      {
        type: "analog-button", action: "buttonA", label: "A",
        side: "right", zone: "thumb", size: "medium", span: 2, priority: 95
      },
      {
        type: "button", action: "buttonB", label: "B",
        side: "right", zone: "thumb", size: "small", span: 2, priority: 80,
        interaction: { type: "toggle" }
      },
      {
        type: "button", action: "buttonX", label: "X",
        side: "right", zone: "thumb", size: "small", span: 2, priority: 75,
        interaction: { type: "chord", actions: ["bumperL", "bumperR"] }
      },
      {
        type: "button", action: "buttonY", label: "Y",
        side: "right", zone: "thumb", size: "small", span: 2, priority: 60
      }
    ]
  }),
  preset("wand", "Motion Wand", "Orientation, swing, shake and trigger controls.", {
    title: "Motion Wand",
    accent: "#FF6B8B",
    motion: {
      action: "aim",
      mode: "wand",
      label: "WAND",
      gestures: { swing: "slash", shake: "shake", spin: "spin" }
    },
    layout: [
      { type: "button", action: "trigger", label: "TRIGGER", emphasis: "primary" },
      { type: "button", action: "buttonB", label: "ALT" }
    ]
  }),
  preset("steering", "Steering Wheel", "Tilt to steer with boost, brake and drift.", {
    title: "Steering Wheel",
    accent: "#62A8FF",
    motion: { action: "steer", mode: "tilt", label: "STEERING" },
    layout: [
      { type: "button", action: "boost", label: "BOOST", emphasis: "primary" },
      { type: "button", action: "brake", label: "BRAKE", emphasis: "danger" },
      { type: "button", action: "drift", label: "DRIFT" }
    ]
  }),
  preset("tilt", "Tilt Board", "Pitch and roll become a two-dimensional vector.", {
    title: "Tilt Board",
    accent: "#CDA2FF",
    motion: { action: "tilt", mode: "tilt", label: "GRAVITY" },
    layout: [
      { type: "button", action: "drop", label: "DROP", emphasis: "primary" },
      { type: "button", action: "reset", label: "RESET" }
    ]
  }),
  preset("touch", "Touch Surface", "A large normalized touchpad and two triggers.", {
    title: "Touch Surface",
    accent: "#FFD166",
    layout: [
      { type: "touch-surface", action: "pointer", label: "TOUCH" },
      { type: "button", action: "trigger", label: "TRIGGER", emphasis: "primary" },
      { type: "button", action: "secondary", label: "SECONDARY" }
    ]
  }),
  preset("trigger", "Trigger Controller", "Large low-latency buttons with haptic feedback.", {
    title: "Trigger Controller",
    accent: "#FF9F43",
    layout: [
      { type: "button", action: "trigger", label: "TRIGGER", emphasis: "primary" },
      { type: "button", action: "buttonA", label: "A" },
      { type: "button", action: "buttonB", label: "B" },
      { type: "button", action: "pause", label: "PAUSE" }
    ]
  }),
  preset("detector", "Motion Detector", "Recognizes swing, shake and spin gestures.", {
    title: "Motion Detector",
    accent: "#00D4FF",
    motion: {
      action: "motion",
      mode: "wand",
      label: "GESTURE",
      gestures: { swing: "swing", shake: "shake", spin: "spin" }
    },
    layout: [
      { type: "button", action: "calibrate", label: "MARK", emphasis: "primary" }
    ]
  }),
  preset("sensor-lab", "Sensor Lab", "Inspect raw and filtered motion while tuning it.", {
    title: "Sensor Lab",
    accent: "#54F0C3",
    motion: { action: "tilt", mode: "tilt", label: "SENSOR" },
    layout: [
      { type: "button", action: "sample", label: "SAMPLE", emphasis: "primary" }
    ]
  }, true)
];

export const DEFAULT_PRESET = CONTROLLER_PRESETS[0]!;
