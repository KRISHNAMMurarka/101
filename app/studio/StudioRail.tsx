"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon } from "../components/Icon";
import { STUDIO_TOOLS } from "./tools";

/**
 * The studio's own navigation.
 *
 * These six pages were in the player's rail, and one of them held a thumb-reachable slot in the
 * phone tab bar — so a tap opened a page whose first screen reads `INPUT 0 Hz / FRAME AGE 0 ms /
 * DROPPED 0%`. They are diagnostics: raw SDP textareas, GATT UUIDs, quaternion tables, a JSON layout
 * editor. Useful, and not a destination anybody arrives at to play.
 *
 * Separating them by URL rather than by a mode toggle or a build flag means each audience gets its
 * own layout and its own code-split boundary, the pages stay linkable and testable in one build, and
 * a future auth check can gate this prefix without touching a player route.
 */

export default function StudioRail() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="studio-rail" aria-label="Studio">
      <Link href="/studio" className="studio-mark">
        <b>101</b>
        <span>Studio</span>
      </Link>
      <div className="studio-links">
        {STUDIO_TOOLS.map((tool) => {
          const active = pathname === tool.href || pathname.startsWith(`${tool.href}/`);
          return (
            <Link key={tool.href} href={tool.href} className={`studio-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
              <Icon name={tool.icon} size={18} />
              <span>{tool.label}</span>
            </Link>
          );
        })}
      </div>
      {/* The way back is explicit. A developer who lands here from a deep link should not have to
          guess that the product lives at the root. */}
      <Link href="/" className="studio-exit">
        <Icon name="back" size={16} />
        <span>Back to 101</span>
      </Link>
    </nav>
  );
}
