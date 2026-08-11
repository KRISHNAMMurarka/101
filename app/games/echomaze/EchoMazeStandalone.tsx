"use client";

import EchoMazeGame from "@/app/components/EchoMazeGame";

const SESSION = "ECHO01";

export default function EchoMazeStandalone() {
  return <main className="site-shell"><EchoMazeGame sessionId={SESSION} onConnect={() => window.open(`/controller?session=${SESSION}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/"; }} /></main>;
}
