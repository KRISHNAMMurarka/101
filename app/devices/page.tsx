import type { Metadata } from "next";

import DevicesView from "./DevicesView";

export const metadata: Metadata = {
  title: "101 Devices — What is connected, and how to add one",
  description: "See what this screen can do on its own, what is linked to it right now, and how to connect another device.",
};

export default function DevicesPage() {
  return <DevicesView />;
}
