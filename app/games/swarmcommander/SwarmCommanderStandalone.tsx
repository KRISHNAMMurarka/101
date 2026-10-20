"use client";

import { useSessionId } from "@/app/lib/session-id";

import SwarmCommanderGame from "@/app/components/SwarmCommanderGame";

export default function SwarmCommanderStandalone() {
  const sessionId = useSessionId() ?? "";
  return <main className="site-shell" aria-busy={!sessionId}><SwarmCommanderGame sessionId={sessionId} onConnect={() => sessionId && window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/games/swarmcommander"; }} /></main>;
}
