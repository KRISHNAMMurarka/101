"use client";

import SpellcasterGame from "@/app/components/SpellcasterGame";

const SESSION = "SPELL1";

export default function SpellcasterStandalone() {
  return <main className="site-shell"><SpellcasterGame sessionId={SESSION} onConnect={() => window.open(`/controller?session=${SESSION}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/"; }} /></main>;
}
