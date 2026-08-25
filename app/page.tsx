import Launcher from "./Launcher";
import { gameCatalog } from "./gameCatalog";
import { createSyntheticCatalog } from "./lib/catalog";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ catalog?: string | string[] }>;
}) {
  const { catalog } = await searchParams;
  // This route is deliberately local and undocumented in the player UI. It exercises the real
  // server render with a thousand manifest-derived entries, so catalog performance is measured
  // rather than inferred from a helper benchmark.
  if (catalog === "1000") {
    const benchmarkCatalog = createSyntheticCatalog(gameCatalog, 1_000);
    return <Launcher games={benchmarkCatalog} benchmarkMode />;
  }
  return <Launcher games={gameCatalog} />;
}
