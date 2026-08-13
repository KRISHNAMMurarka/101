import type { Metadata } from "next";
import Controller from "./Controller";

export const metadata: Metadata = {
  title: "101 Link — Browser controller",
  description: "A local browser controller for the 101 Input Lab.",
  applicationName: "101 Link",
  manifest: "/link.webmanifest",
  appleWebApp: { capable: true, title: "101 Link", statusBarStyle: "black-translucent" },
};

export default async function ControllerPage({ searchParams }: { searchParams: Promise<{ session?: string; pair?: string }> }) {
  const params = await searchParams;
  const session = params.session?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "101LAB";
  return <Controller session={session} pairCode={params.pair} />;
}
