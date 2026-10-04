import type { NextConfig } from "next";

import { sourceId } from "./tools/source-id.mjs";

/**
 * Both of these default to a fresh `randomUUID()` per build inside vinext, and both are baked into
 * the client bundle. One random string changes a chunk's content hash, and the 22 chunks that import
 * it change with it — so two builds of identical source emitted different filenames, every release
 * invalidated every user's cache, and no build could be verified against its source.
 *
 * Deriving them from the source keeps exactly the property they exist for. The RSC compatibility id
 * must differ when the deployed app differs, so a browser holding an old client rejects a mismatched
 * payload and hard-navigates; a source hash does that faithfully, where a fresh UUID only ever did it
 * by accident — it also differed when nothing had changed at all.
 */
const id = await sourceId();

const nextConfig: NextConfig = {
  deploymentId: id,
  generateBuildId: () => id,
  headers: async () => [{
    source: "/:path*",
    headers: [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
    ],
  }],
};

export default nextConfig;
