"use client";

import { useSessionId } from "@/app/lib/session-id";

import GravityStackGame from "@/app/components/GravityStackGame";

export default function GravityStackStandalone() {
  const sessionId = useSessionId() ?? "";
  return <main className="site-shell" aria-busy={!sessionId}><GravityStackGame sessionId={sessionId} onConnect={() => sessionId && window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/games/gravitystack"; }} /></main>;
}
