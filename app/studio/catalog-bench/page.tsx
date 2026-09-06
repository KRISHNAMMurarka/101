import type { Metadata } from "next";

import Launcher from "../../Launcher";
import { gameCatalog } from "../../gameCatalog";
import { createSyntheticCatalog } from "../../lib/catalog";

export const metadata: Metadata = {
  title: "101 Studio — Catalog benchmark",
  robots: { index: false, follow: false },
};

const DEFAULT_COUNT = 1_000;
const MAX_COUNT = 10_000;

/**
 * The catalog under load.
 *
 * This exercises the real production server render with a large manifest-derived catalog, so paging
 * and windowing performance is measured rather than inferred from a helper benchmark — which is why
 * it is not gated on NODE_ENV.
 *
 * It used to live on `/`, reachable from the player's home page as `?catalog=1000`. Two problems
 * with that: a benchmark harness could reach player copy (it is what made the library heading say
 * "benchmark entries"), and `createSyntheticCatalog` throws for a non-integer or out-of-range count,
 * so `?catalog=abc` was an uncaught server exception on the product's front door.
 */
export default async function CatalogBenchmark({
  searchParams,
}: {
  searchParams: Promise<{ count?: string | string[] }>;
}) {
  const { count } = await searchParams;
  const requested = Number.parseInt(Array.isArray(count) ? (count[0] ?? "") : (count ?? ""), 10);
  const size = Number.isInteger(requested) ? Math.min(Math.max(requested, 0), MAX_COUNT) : DEFAULT_COUNT;

  return <Launcher games={createSyntheticCatalog(gameCatalog, size)} benchmarkMode />;
}
