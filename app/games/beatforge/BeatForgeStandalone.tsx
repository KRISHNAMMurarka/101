"use client";

import BeatForgeGame from "@/app/components/BeatForgeGame";

const SESSION = "BEAT01";

export default function BeatForgeStandalone() {
  return <main className="site-shell"><BeatForgeGame sessionId={SESSION} onConnect={() => window.open(`/controller?session=${SESSION}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/"; }} /></main>;
}
