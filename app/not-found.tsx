import Link from "next/link";

import { Icon } from "./components/Icon";

/**
 * Without this file a mistyped or retired game URL renders Next's stock 404 — which in production is
 * a bare, unstyled page with no way back into the product.
 */
export default function NotFound() {
  return (
    <main className="route-state">
      <p className="eyebrow">Not found</p>
      <h1>That page isn&apos;t here.</h1>
      <p>It may have moved, or the link may be wrong.</p>
      <Link className="primary-button" href="/">Browse the games <Icon name="arrow" size={16} /></Link>
    </main>
  );
}
