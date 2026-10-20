"use client";

import { useSessionId } from "@/app/lib/session-id";
import BodyDodgeGame from "@/app/components/BodyDodgeGame";

export default function BodyDodgeStandalone() {
  const sessionId = useSessionId() ?? "";
  return <main className="site-shell" aria-busy={!sessionId}><BodyDodgeGame sessionId={sessionId} onConnect={() => sessionId && window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/games/bodydodge"; }} /></main>;
}
