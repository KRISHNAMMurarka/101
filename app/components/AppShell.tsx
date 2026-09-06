"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import FullscreenToggle from "./FullscreenToggle";
import { Icon, type IconName } from "./Icon";
import { setRailOpen, useRailOpen } from "../lib/rail-preference";

/**
 * The navigation shell.
 *
 * `app/layout.tsx` used to return `<html><body>{children}</body></html>` and nothing else, so every
 * piece of orientation the product had was JSX inside Launcher.tsx — present on exactly one of
 * seventeen routes. That single fact produced most of the complaints about the interface: five labs
 * each re-declaring their own topbar because there was nothing to inherit, three incompatible ways
 * to navigate, and — below 760px — `.topbar .nav { display: none }` deleting primary navigation
 * outright, leaving eight of ten destinations unreachable on a phone with nothing in their place.
 *
 * A rail rather than a header, for reasons that come from these surfaces and not from taste. Every
 * content surface in 101 is a wide, short stage — the game canvases are `clamp(560px, 62vw, 780px)`
 * tall inside layouts capped at 1540px — so vertical pixels are the scarce ones and horizontal
 * pixels are the spare ones. A 72px rail costs the product room it has; a 76px header costs the
 * room the canvas is starved of, and would sit over a running game. The header also already failed
 * at this destination count: a comment in Launcher.tsx records the row reaching seventeen items,
 * which is why six labs ended up behind a popover. A rail does not run out of room the way a row does.
 */

type Destination = { href: string; label: string; icon: IconName };

/**
 * The player's destinations. Two, and the bar grows with this array rather than with a comment.
 *
 * The six diagnostics that used to sit here now live behind /studio. One of them also held a slot in
 * the three-item phone tab bar, so a thumb tap on a player's home screen opened a page reading
 * "INPUT 0 Hz / FRAME AGE 0 ms / DROPPED 0%".
 */
const PRIMARY: Destination[] = [
  { href: "/", label: "Play", icon: "play" },
  { href: "/devices", label: "Devices", icon: "devices" },
];


/**
 * Surfaces that supply their own chrome, or need none.
 *
 * The controller is a device you hold and do not look at — chrome on it would be chrome on a thing
 * in your hand. The studio is a different product for a different audience, and renders its own rail.
 */
const BARE = ["/controller", "/studio"];

/**
 * Prefix matching, but only on a path boundary. A bare `startsWith` makes "/controller-lab" match
 * "/controller", which silently stripped the shell off the Controller Lab — that route then
 * rendered with no navigation at all, which is the exact failure the shell exists to prevent.
 */
function within(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const open = useRailOpen();

  if (BARE.some((href) => within(pathname, href))) return <>{children}</>;

  const item = (destination: Destination) => (
    <Link
      key={destination.href}
      href={destination.href}
      className={`rail-item${within(pathname, destination.href) ? " active" : ""}`}
      aria-current={within(pathname, destination.href) ? "page" : undefined}
      data-label={destination.label}
    >
      <Icon name={destination.icon} size={20} />
      <span>{destination.label}</span>
    </Link>
  );

  return (
    <div className={`app-shell${open ? " rail-open" : ""}`}>
      <nav className="rail" aria-label="Primary">
        <Link href="/" className="rail-mark" aria-label="101 home">
          <b>101</b>
        </Link>

        <div className="rail-group">{PRIMARY.map(item)}</div>

        {/* A door, not a destination. It sits at the foot with the rail's own controls rather than
            beside Play and Devices, because it leads somewhere a player has no reason to go — but
            leaving it out entirely means a developer's only route in is a footer link. */}
        <Link href="/studio" className="rail-door" data-label="Developer tools">
          <Icon name="labs" size={18} />
          <span>Developer tools</span>
        </Link>

        <button className="rail-toggle" onClick={() => setRailOpen(!open)} aria-expanded={open} title={open ? "Collapse" : "Expand"}>
          <Icon name="chevron" size={16} />
          <span>{open ? "Collapse" : "Expand"}</span>
        </button>
      </nav>

      {/* Below 760px the rail becomes a bottom tab bar. This is what replaces the breakpoint that
          used to delete the nav outright: the player's destinations, thumb-height. */}
      <nav className="tabbar" aria-label="Primary">
        {PRIMARY.map((destination) => (
          <Link
            key={destination.href}
            href={destination.href}
            className={`tab${within(pathname, destination.href) ? " active" : ""}`}
            aria-current={within(pathname, destination.href) ? "page" : undefined}
          >
            <Icon name={destination.icon} size={22} />
            <span>{destination.label}</span>
          </Link>
        ))}
      </nav>

      {/* A div, not a <main>: sixteen routes already declare their own main landmark, and nesting
          one inside another is invalid and confuses assistive navigation. The shell owns the
          regions around the content, not the content’s landmark. */}
      <div className="stage">{children}</div>

      {/* Offered where there is a game to fill the screen with, and nowhere else. */}
      {pathname.startsWith("/games/") && <FullscreenToggle />}
    </div>
  );
}
