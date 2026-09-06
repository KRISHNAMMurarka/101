import type { IconName } from "../components/Icon";

/**
 * The developer tools, in one place.
 *
 * Plain data, not a client module: the rail is interactive and the index is a server component, and
 * both need this list. Exporting it from the "use client" rail meant the index pulled a value across
 * the RSC boundary and the route 500'd.
 *
 * The blurbs say what each tool lets you do, not what it displays. "Landmarks, inference cost and
 * the simulated fallback" describes a screen; "check what the camera can see" describes a reason to
 * open it — and the audience here is a developer new to 101, not someone who already knows the
 * vocabulary.
 */
export type StudioTool = { href: string; label: string; icon: IconName; blurb: string };

export const STUDIO_TOOLS: readonly StudioTool[] = [
  { href: "/studio/input", label: "Input", icon: "touch", blurb: "Watch every control a device sends, as it sends it" },
  { href: "/studio/motion", label: "Motion", icon: "phone-motion", blurb: "Check and calibrate a phone's tilt and movement" },
  { href: "/studio/vision", label: "Camera", icon: "camera-face", blurb: "Check hand, body and face tracking, and how fast it runs" },
  { href: "/studio/network", label: "Pairing", icon: "bluetooth", blurb: "Connect two devices by hand, with no network discovery" },
  { href: "/studio/controller", label: "Controller", icon: "gamepad", blurb: "Design a controller layout and try it on a real phone" },
  { href: "/studio/hardware", label: "Hardware", icon: "custom", blurb: "Connect a USB, Bluetooth or serial device" },
  { href: "/studio/catalog-bench", label: "Catalog", icon: "play", blurb: "Load the library with a large catalog to see how it holds up" },
];
