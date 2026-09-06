import Link from "next/link";

import { Icon } from "../components/Icon";
import { STUDIO_TOOLS } from "./tools";

export default function StudioIndex() {
  return (
    <main className="studio-index">
      <header className="page-head">
        <p className="eyebrow">Studio</p>
        <h1>Build on 101</h1>
        <p className="page-intro">
          Six tools for working on the platform itself: watch input resolve, calibrate a sensor, author a controller panel,
          and pair a device by hand when discovery is not available.
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
