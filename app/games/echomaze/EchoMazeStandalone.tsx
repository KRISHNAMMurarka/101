"use client";

import { useSessionId } from "@/app/lib/session-id";

import EchoMazeGame from "@/app/components/EchoMazeGame";

export default function EchoMazeStandalone() {
  const sessionId = useSessionId() ?? "";
  return <main className="site-shell" aria-busy={!sessionId}><EchoMazeGame sessionId={sessionId} onConnect={() => sessionId && window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/games/echomaze"; }} /></main>;
}
