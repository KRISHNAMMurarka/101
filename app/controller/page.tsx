import type { Metadata } from "next";
import Controller from "./Controller";

export const metadata: Metadata = {
  title: "101 Link — Browser controller",
  description: "A local browser controller for the 101 Input Lab.",
};

export default async function ControllerPage({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  const params = await searchParams;
  const session = params.session?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "101LAB";
  return <Controller session={session} />;
}
