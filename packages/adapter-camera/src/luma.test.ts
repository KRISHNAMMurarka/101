import assert from "node:assert/strict";
import test from "node:test";
import { PLACEMENT_LIMITS, readHandPlacement } from "@101/vision";
import { LUMA_LIMITS, meanLuma, sampleVideoLuma } from "./index.ts";

function pixels(width: number, height: number, value: (x: number) => number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([value(i % width), value(i % width), value(i % width), 255], i * 4);
  }
  return { width, height, data, colorSpace: "srgb" } satisfies ImageData;
}

test("mean luma is normalized perceptual brightness and ignores alpha", () => {
  assert.equal(meanLuma(pixels(2, 2, () => 0)), 0);
  assert.ok(Math.abs(meanLuma(pixels(2, 2, () => 255)) - 1) < 1e-10);
  assert.ok(Math.abs(meanLuma({ data: new Uint8ClampedArray([255, 0, 0, 0]) }) - .2126) < 1e-10);
  assert.equal(meanLuma({ data: new Uint8ClampedArray() }), 0);
});

test("the tiny video sample separates a dim centre from a bright background", () => {
  let draws = 0;
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({
      drawImage: () => { draws++; },
      getImageData: (x: number, _y: number, width: number, height: number) => pixels(width, height, (col) => col + x >= 11 && col + x < 21 ? 0 : 255),
    }),
  } as unknown as HTMLCanvasElement;
  const video = { readyState: 2, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
  const light = sampleVideoLuma(video, canvas)!;
  assert.equal(canvas.width, 32);
  assert.equal(canvas.height, 24);
  assert.equal(draws, 1);
  assert.ok(light.luma > .6);
  assert.equal(light.subjectLuma, 0);
  assert.ok(readHandPlacement([], 16 / 9, light).issues.includes("backlit"));
  assert.equal(LUMA_LIMITS.minLuma, PLACEMENT_LIMITS.minLuma);
  assert.equal(LUMA_LIMITS.maxBacklight, PLACEMENT_LIMITS.maxBacklight);
});

test("a video without an image does not become a false dark-room reading", () => {
  assert.equal(sampleVideoLuma({ readyState: 0 } as HTMLVideoElement, {} as HTMLCanvasElement), undefined);
  assert.equal(sampleVideoLuma({ readyState: 2, videoWidth: 1, videoHeight: 1 } as HTMLVideoElement, { getContext: () => null } as unknown as HTMLCanvasElement), undefined);
});
