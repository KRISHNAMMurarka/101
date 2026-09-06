import type { Metadata } from "next";
import NetworkLab from "./NetworkLab";

export const metadata: Metadata = {
  title: "101 Network Lab — Offline WebRTC pairing",
  description: "Pair two browsers without a signaling server and measure the 101 realtime path.",
};

export default function NetworkPage() {
  return <NetworkLab />;
}
