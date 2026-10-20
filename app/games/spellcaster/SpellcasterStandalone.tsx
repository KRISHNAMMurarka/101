"use client";

import { useSessionId } from "@/app/lib/session-id";

import SpellcasterGame from "@/app/components/SpellcasterGame";

export default function SpellcasterStandalone() {
  const sessionId = useSessionId() ?? "";
  return <main className="site-shell" aria-busy={!sessionId}><SpellcasterGame sessionId={sessionId} onConnect={() => sessionId && window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/games/spellcaster"; }} /></main>;
}
