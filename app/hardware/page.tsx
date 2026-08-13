import type { Metadata } from "next";
import HardwareLab from "./HardwareLab";

export const metadata: Metadata = {
  title: "101 Hardware Lab — HID, Bluetooth and Serial",
  description: "Connect optional WebHID, Web Bluetooth, and Web Serial controllers through the normalized 101 Input Bus.",
};

export default function HardwarePage() { return <HardwareLab />; }
