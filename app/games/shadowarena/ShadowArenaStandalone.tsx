"use client";

import { useSessionId } from "@/app/lib/session-id";

import ShadowArenaGame from "@/app/components/ShadowArenaGame";

export default function ShadowArenaStandalone() {
  const sessionId = useSessionId() ?? "";
  return <main className="site-shell" aria-busy={!sessionId}><ShadowArenaGame sessionId={sessionId} onConnect={() => sessionId && window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/games/shadowarena"; }} /></main>;
}
