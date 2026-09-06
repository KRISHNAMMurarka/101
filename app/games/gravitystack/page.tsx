import type { Metadata } from "next";
import GravityStackStandalone from "./GravityStackStandalone";

export const metadata: Metadata = {
  title: "GravityStack 101",
  description: "Stack a tower upward while gravity keeps changing which way down is.",
};

export default function GravityStackPage() {
  return <GravityStackStandalone />;
}
