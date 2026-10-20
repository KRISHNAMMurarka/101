"use client";

import { useSessionId } from "@/app/lib/session-id";
import TiltDriftGame from "@/app/components/TiltDriftGame";

export default function TiltDriftStandalone() {
  const sessionId = useSessionId() ?? "";
  return <main className="site-shell" aria-busy={!sessionId}><TiltDriftGame sessionId={sessionId} onExit={() => { window.location.href = "/games/tiltdrift"; }} onConnect={() => sessionId && window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")} /></main>;
}
