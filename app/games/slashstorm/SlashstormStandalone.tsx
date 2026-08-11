"use client";

import { useId } from "react";
import SlashstormGame from "@/app/components/SlashstormGame";

export default function SlashstormStandalone() {
  const instance = useId().replace(/[^a-z0-9]/gi, "").toUpperCase();
  const sessionId = `S1${instance}101`.slice(0, 6).padEnd(6, "X");
  return (
    <main className="site-shell">
      <SlashstormGame
        sessionId={sessionId}
        onExit={() => { window.location.href = "/"; }}
        onConnect={() => window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")}
      />
    </main>
  );
}
