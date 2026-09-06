import type { IconName } from "../components/Icon";

/**
 * The studio's tools, in one place.
 *
 * Plain data, not a client module: the rail is interactive and the index is a server component, and
 * both need this list. Exporting it from the "use client" rail meant the index pulled a value across
 * the RSC boundary and the route 500'd.
 */
export type StudioTool = { href: string; label: string; icon: IconName; blurb: string };

export const STUDIO_TOOLS: readonly StudioTool[] = [
  { href: "/studio/input", label: "Input", icon: "touch", blurb: "Every source resolving into one frame, live" },
  { href: "/studio/motion", label: "Motion", icon: "phone-motion", blurb: "Calibrated orientation, acceleration and gestures" },
  { href: "/studio/vision", label: "Vision", icon: "camera-face", blurb: "Landmarks, inference cost and the simulated fallback" },
  { href: "/studio/network", label: "Network", icon: "bluetooth", blurb: "Manual peer pairing with no discovery service" },
  { href: "/studio/controller", label: "Controller", icon: "gamepad", blurb: "Author a panel in JSON and watch the frames it emits" },
  { href: "/studio/hardware", label: "Hardware", icon: "custom", blurb: "HID, Bluetooth and serial device profiles" },
  { href: "/studio/catalog-bench", label: "Catalog", icon: "play", blurb: "The library under a synthetic catalog, on the real server render" },
];
