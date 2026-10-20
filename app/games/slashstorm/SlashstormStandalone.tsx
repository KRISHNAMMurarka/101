"use client";

import { useSessionId } from "@/app/lib/session-id";
import SlashstormGame from "@/app/components/SlashstormGame";

export default function SlashstormStandalone() {
  const sessionId = useSessionId() ?? "";
  return (
    <main className="site-shell" aria-busy={!sessionId}>
      <SlashstormGame
        sessionId={sessionId}
        onExit={() => { window.location.href = "/games/slashstorm"; }}
        onConnect={() => sessionId && window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")}
      />
    </main>
  );
}
