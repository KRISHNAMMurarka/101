import Launcher from "./Launcher";
import { gameCatalog } from "./gameCatalog";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "101 — Anything can be a controller" };

export default function Home() {
  return <Launcher games={gameCatalog} />;
}
