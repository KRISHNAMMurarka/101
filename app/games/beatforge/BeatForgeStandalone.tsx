"use client";

import { useSessionId } from "@/app/lib/session-id";

import BeatForgeGame from "@/app/components/BeatForgeGame";

export default function BeatForgeStandalone() {
  const sessionId = useSessionId() ?? "";
  return <main className="site-shell" aria-busy={!sessionId}><BeatForgeGame sessionId={sessionId} onConnect={() => sessionId && window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/games/beatforge"; }} /></main>;
}
