"use client";

import ShadowArenaGame from "@/app/components/ShadowArenaGame";

const SESSION = "SHDW01";

export default function ShadowArenaStandalone() {
  return <main className="site-shell"><ShadowArenaGame sessionId={SESSION} onConnect={() => window.open(`/controller?session=${SESSION}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/"; }} /></main>;
}
