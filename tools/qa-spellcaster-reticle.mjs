import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

/** Observe actual neutral ring pixels; rectangles are measured DOM overlays. */
export function measureReticle(bytes, exclusions) {
  const png = PNG.sync.read(bytes);
  assert.ok(Array.isArray(exclusions) && exclusions.every(rectangle => ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(rectangle[key]))));
  let x = 0, y = 0, count = 0;
  for (let row = Math.floor(png.height * .23); row < Math.floor(png.height * .8); row++) {
    for (let column = Math.floor(png.width * .03); column < Math.floor(png.width * .97); column++) {
      if (exclusions.some(rectangle => column >= rectangle.left - 1 && column <= rectangle.right + 1 && row >= rectangle.top - 1 && row <= rectangle.bottom + 1)) continue;
      const pixel = (row * png.width + column) * 4;
      const rgb = [...png.data.subarray(pixel, pixel + 3)];
      if (Math.min(...rgb) > 80 && Math.max(...rgb) - Math.min(...rgb) < 28) {
        x += column; y += row; count++;
      }
    }
  }
  assert.ok(count >= 3 && count < 2500, `Rendered ring mask contains ${count} pixels`);
  return { x: x / count, y: y / count, pixels: count, width: png.width, height: png.height };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['--offline']);
  // Hand-annotated overlay bounds from the retained 1104x552 native screenshots.
  // The live caller measures current DOM boxes instead of using these coordinates.
  const overlays = [{ left: 18, top: 22, right: 245, bottom: 108 },
    { left: 18, top: 488, right: 618, bottom: 536 },
    { left: 730, top: 438, right: 1086, bottom: 478 }];
  for (const engine of ['chromium', 'webkit']) {
    const observe = key => measureReticle(readFileSync(new URL(`../outputs/controllers/2026-10-18-spellcaster-control-followthrough/${engine}-run1-keyboard-${key}.png`, import.meta.url)), overlays);
    const up = observe('ArrowUp'), down = observe('ArrowDown');
    console.log(JSON.stringify({ engine, up, down }));
    assert.ok(up.y > 320 && up.y < 338 && up.x > 540 && up.x < 565, 'Retained ArrowUp image has its visible ring near (552,329)');
    assert.ok(down.y > 218 && down.y < 235 && down.x > 540 && down.x < 565, 'Retained ArrowDown image has its visible ring near (552,226)');
    assert.ok(up.y - down.y > 8, 'Vertical consumer movement survives overlay exclusion');
  }
}
