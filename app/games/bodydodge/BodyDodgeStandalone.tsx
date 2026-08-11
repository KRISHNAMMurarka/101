"use client";

import BodyDodgeGame from "@/app/components/BodyDodgeGame";

export default function BodyDodgeStandalone() {
  return <main className="site-shell"><BodyDodgeGame onExit={() => { window.location.href = "/"; }} /></main>;
}
