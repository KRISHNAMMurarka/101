"use client";

import OrbitalCrewGame from "@/app/components/OrbitalCrewGame";

const SESSION = "ORBIT1";

export default function OrbitalCrewStandalone() {
  return (
    <main className="site-shell">
      <OrbitalCrewGame
        sessionId={SESSION}
        onConnect={() => window.open(`/controller?session=${SESSION}`, "_blank", "noopener,noreferrer")}
        onExit={() => { window.location.href = "/"; }}
      />
    </main>
  );
}
