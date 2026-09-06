"use client";

import { useId } from "react";
import BodyDodgeGame from "@/app/components/BodyDodgeGame";

export default function BodyDodgeStandalone() {
  const instance = useId().replace(/[^a-z0-9]/gi, "").toUpperCase();
  const generated = `B1${instance}101`.slice(0, 6).padEnd(6, "X");
  const requested = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("session")?.trim();
  const sessionId = requested && /^[A-Z0-9-]{4,128}$/i.test(requested) ? requested : generated;
  return <main className="site-shell"><BodyDodgeGame sessionId={sessionId} onConnect={() => window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/games/bodydodge"; }} /></main>;
}
