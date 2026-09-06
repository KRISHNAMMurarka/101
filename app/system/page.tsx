import type { Metadata } from "next";

import SystemView from "./SystemView";

export const metadata: Metadata = {
  title: "101 System — Games speak actions, adapters speak hardware",
  description: "The boundary that is the product: a device is added once, and every compatible 101 game can use it.",
};

export default function SystemPage() {
  return <SystemView />;
}
