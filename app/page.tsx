import Launcher from "./Launcher";
import { gameCatalog } from "./gameCatalog";

export default function Home() {
  return <Launcher games={gameCatalog} />;
}
