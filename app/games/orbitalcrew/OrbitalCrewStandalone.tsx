"use client";

import { useSessionId } from "@/app/lib/session-id";

import OrbitalCrewGame from "@/app/components/OrbitalCrewGame";

export default function OrbitalCrewStandalone() {
  const sessionId = useSessionId() ?? "";
  return (
    <main className="site-shell" aria-busy={!sessionId}>
      <OrbitalCrewGame
        sessionId={sessionId}
        onConnect={() => sessionId && window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")}
        onExit={() => { window.location.href = "/games/orbitalcrew"; }}
      />
    </main>
  );
}
