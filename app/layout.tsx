import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import AppShell from "./components/AppShell";
import "./globals.css";

const description = "Turn the devices you already own into game controllers, and play together on one screen.";

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
    icons: { icon: "/icons/101-link.svg" },
    keywords: ["party games", "couch multiplayer", "phone controller", "motion games"],
    openGraph: { title: "101 — Anything can be a controller", description, images: [{ url: image, width: 1731, height: 909 }] },
    twitter: { card: "summary_large_image", title: "101 — Anything can be a controller", description, images: [image] },
  };
}

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  // Both, now that the light palette resolves. It previously declared dark only, which was accurate
  // in the sense that light mode did not work — the two palettes referenced each other in a cycle,
  // so every core token was invalid and the page rendered with no background and no button fills.
  colorScheme: "dark light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      {/* Written here rather than through the `viewport` export because this framework's metadata
          shim builds the content string from a fixed list of keys — width, height, the scales,
          userScalable — and has no branch for `viewportFit`, so the key is accepted and silently
          dropped. Without `viewport-fit=cover` every `env(safe-area-inset-*)` in the stylesheet
          computes to 0, which is why the controller deck sat under the home indicator. */}
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
