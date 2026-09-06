"use client";

import { useId } from "react";
import SlashstormGame from "@/app/components/SlashstormGame";

export default function SlashstormStandalone() {
  const instance = useId().replace(/[^a-z0-9]/gi, "").toUpperCase();
  const generated = `S1${instance}101`.slice(0, 6).padEnd(6, "X");
  const requested = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("session")?.trim();
  const sessionId = requested && /^[A-Z0-9-]{4,128}$/i.test(requested) ? requested : generated;
  return (
    <main className="site-shell">
      <SlashstormGame
        sessionId={sessionId}
        onExit={() => { window.location.href = "/games/slashstorm"; }}
        onConnect={() => window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")}
      />
    </main>
  );
}
