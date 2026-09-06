import type { Metadata } from "next";

import StudioRail from "./StudioRail";

export const metadata: Metadata = {
  title: "101 — Developer tools",
  // Tooling, not a product page. Keeping it out of search results also keeps a player from
  // arriving at a frame inspector through a link they did not know was for developers.
  robots: { index: false, follow: false },
};

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="studio-shell">
      <StudioRail />
      <div className="studio-stage">{children}</div>
    </div>
  );
}
