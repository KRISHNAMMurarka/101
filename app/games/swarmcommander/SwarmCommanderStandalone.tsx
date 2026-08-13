"use client";

import SwarmCommanderGame from "@/app/components/SwarmCommanderGame";

const SESSION = "SWRM01";
export default function SwarmCommanderStandalone() { return <main className="site-shell"><SwarmCommanderGame sessionId={SESSION} onConnect={() => window.open(`/controller?session=${SESSION}`, "_blank", "noopener,noreferrer")} onExit={() => { window.location.href = "/"; }} /></main>; }
