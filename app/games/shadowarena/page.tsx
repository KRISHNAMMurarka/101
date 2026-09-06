import type { Metadata } from "next";
import ShadowArenaStandalone from "./ShadowArenaStandalone";

export const metadata: Metadata = {
  title: "Shadow Arena 101",
  description: "Your silhouette steps into the arena. Fight with your body, or with a controller.",
};

export default function ShadowArenaPage() {
  return <ShadowArenaStandalone />;
}
