"use client";

import { useState } from "react";

import EchoMazeGame from "@/app/components/EchoMazeGame";

const SESSION = "ECHO01";

/** Prefer the code the chooser handed over; fall back to this game's own, so the route still renders
 *  identically when opened directly. */
function readSession() {
  if (typeof window === "undefined") return SESSION;
  const requested = new URLSearchParams(window.location.search).get("session")?.trim();
  return requested && /^[A-Z0-9-]{4,128}$/i.test(requested) ? requested : SESSION;
}

export default function EchoMazeStandalone() {
  const [SESSION_ID] = useState(readSession);
  return <main className="site-shell"><EchoMazeGame sessionId={SESSION_ID} onConnect={() => window.open(`/controller?session=${SESSION_ID}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/games/echomaze"; }} /></main>;
}
