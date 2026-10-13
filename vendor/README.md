# Local source map compatibility build

`source-map-js-1.2.2+101.1.tgz` is a private local build of the existing
`source-map-js` dependency. Its source is in `source-map-js/`; the original BSD
license and copyright notices are retained. The package metadata records the
upstream 1.2.2 archive URL and integrity. This is not an upstream release.

The patch keeps an absent `sourceRoot` valid during indexed conversion, selects
the first generated column correctly, applies a section column only on its first
local line, and delegates nested reverse lookup through the public consumer API.
The first mapping name also survives index zero, and omitted original source content remains optional. Generated-only mappings retain `null` sources, including through PostCSS conversion. Missing positions remain `null`. Upstream 1.2.2's malformed and accumulated section
offset checks remain intact.

Rebuild the archive with `python3 tools/build-local-source-map.py`. The producer
uses ordinary bounded source files, fixed tar metadata and a fixed gzip timestamp.
The npm override installs that archive as ordinary files. The direct and actual
PostCSS regressions are in `tests/source-map-compatibility.test.ts`; unchanged
security controls also remain in `tests/dependency-security.test.ts`.

Keep the local version and source/archive provenance explicit when updating or
retiring this patch. A future upstream replacement must pass the same valid
mapping and malformed-offset controls before changing the override. This build
does not establish a stable support window or whole release acceptance.
