import Link from "next/link";

import { Icon } from "../components/Icon";
import { STUDIO_TOOLS } from "./tools";

export default function StudioIndex() {
  return (
    <main className="studio-index">
      <header className="page-head">
        <p className="eyebrow">Developer tools</p>
        <h1>Build on 101</h1>
        <p className="page-intro">
          A game asks 101 for controls — move, aim, fire — and 101 works out which of the player&apos;s devices can
          provide them. These tools let you see that happening, and try a device before you write anything.
        </p>
      </header>

      <div className="studio-grid">
        {STUDIO_TOOLS.map((tool) => (
          <Link key={tool.href} href={tool.href} className="studio-card">
            <Icon name={tool.icon} size={24} />
            <h2>{tool.label}</h2>
            <p>{tool.blurb}</p>
            <Icon name="arrow" size={16} />
          </Link>
        ))}
      </div>
    </main>
  );
}
