"use client";

import { useEffect } from "react";

/**
 * Without this file a client-side throw anywhere in the product drops the player onto Next's stock
 * error page — a stack trace in development, a bare "Application error" in production.
 *
 * The error itself goes to the console, never to the screen: its text is written for whoever wrote
 * the code, and a player can act on exactly one thing, which is trying again.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="route-state">
      <p className="eyebrow">Something went wrong</p>
      <h1>That didn&apos;t load.</h1>
      <p>Try again, and if it keeps happening, reload the page.</p>
      <button className="primary-button" onClick={reset}>Try again</button>
    </main>
  );
}
