"use client";

import GravityStackGame from "@/app/components/GravityStackGame";

const SESSION = "GRAV01";

export default function GravityStackStandalone() {
  return <main className="site-shell"><GravityStackGame sessionId={SESSION} onConnect={() => window.open(`/controller?session=${SESSION}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/"; }} /></main>;
}
