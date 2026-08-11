import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

const description = "An open, local-first gaming runtime that turns keyboards, phones, cameras, watches and future hardware into one universal input language.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const image = new URL("/og.png", base).toString();

  return {
    metadataBase: base,
    title: "101 — Anything can be a controller",
    description,
    applicationName: "101",
    manifest: "/manifest.webmanifest",
    keywords: ["local multiplayer", "browser games", "game controller", "open source"],
    openGraph: { title: "101 — Anything can be a controller", description, images: [{ url: image, width: 1731, height: 909 }] },
    twitter: { card: "summary_large_image", title: "101 — Anything can be a controller", description, images: [image] },
  };
}

export const viewport: Viewport = {
  themeColor: "#090b0b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
