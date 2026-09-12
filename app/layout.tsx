import type { Viewport } from "next";
import { headers } from "next/headers";
import AppShell from "./components/AppShell";
import "./globals.css";

const TITLE = "101 — Anything can be a controller";
const description = "Turn the devices you already own into game controllers, and play together on one screen.";

/**
 * The head is written here rather than through a `metadata` export.
 *
 * This framework's metadata shim renders its tags as a fragment inside the streamed part of the
 * tree and relies on React hoisting them into `<head>`. It does not happen: every tag the export
 * produced — title, description, keywords, the Open Graph and Twitter sets, the icon, and the web
 * app manifest — was left in a `<div hidden>` in the body, before and after hydration.
 *
 * That is not cosmetic. A browser only honours `<link rel="manifest">` in the head, so the manifest
 * was never fetched at all: twenty-six resources on the controller route and not one request for
 * `/manifest.webmanifest`. The controller could not be installed, which is the first step of the
 * offline-update case in the acceptance runbook. Nothing that unfurls a link could see a
 * description or an image either.
 *
 * Tags written in the layout's own JSX land in the static shell, which is how the `viewport-fit`
 * meta already reached the head. Verified by measurement, not by assumption: see
 * docs/LIGHTHOUSE-2026-09-12.md.
 *
 * No <title> here, deliberately. A page-level `metadata` export DOES reach the head — only the root
 * layout's is stranded — and every route sets its own. A title here as well won out at runtime over
 * the page's, so the controller tab read "101 — Anything can be a controller" instead of "101 Link".
 * The two routes that had no title of their own now have one.
 */
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  // Both, now that the light palette resolves. It previously declared dark only, which was accurate
  // in the sense that light mode did not work — the two palettes referenced each other in a cycle,
  // so every core token was invalid and the page rendered with no background and no button fills.
  colorScheme: "dark light",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = new URL("/og.png", `${protocol}://${host}`).toString();

  return (
    <html lang="en">
      {/* `viewport-fit=cover` is what makes env(safe-area-inset-*) resolve to anything but 0, which
          is what keeps the bottom-anchored controller deck clear of the home indicator. */}
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="description" content={description} />
      <meta name="application-name" content="101" />
      <meta name="keywords" content="party games,couch multiplayer,phone controller,motion games" />
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="icon" href="/icons/101-link.svg" />
      <meta property="og:title" content={TITLE} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={image} />
      <meta property="og:image:width" content="1731" />
      <meta property="og:image:height" content="909" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={TITLE} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
