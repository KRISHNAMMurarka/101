"use client";

import { useId } from "react";
import TiltDriftGame from "@/app/components/TiltDriftGame";

export default function TiltDriftStandalone() {
  const instance = useId().replace(/[^a-z0-9]/gi, "").toUpperCase();
  const sessionId = `T1${instance}101`.slice(0, 6).padEnd(6, "X");
  return <main className="site-shell"><TiltDriftGame sessionId={sessionId} onExit={() => { window.location.href = "/"; }} onConnect={() => window.open(`/controller?session=${sessionId}`, "_blank", "noopener,noreferrer")} /></main>;
}
