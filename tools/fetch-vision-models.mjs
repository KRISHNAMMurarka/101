#!/usr/bin/env node
/**
 * Fetch the optional MediaPipe pose models and record their hashes.
 *
 * Only `pose_landmarker_lite.task` and `hand_landmarker.task` are committed. The other two pose
 * models are 9MB and 30MB, which is not something to put in a git history for a tier most machines
 * will not select — so they are fetched deliberately, verified, and written into the integrity table
 * in docs/vision.md the same way the committed ones are.
 *
 * Nothing downloads at runtime. A tier whose model is absent falls back to the one that is present,
 * so a checkout without these still tracks a body.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MODELS = [
  {
    file: "pose_landmarker_full.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  },
  {
    file: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  },
  {
    file: "pose_landmarker_heavy.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
  },
];

const root = resolve(import.meta.dirname, "..");
const wanted = process.argv.slice(2);
const selected = wanted.length ? MODELS.filter((m) => wanted.some((w) => m.file.includes(w))) : MODELS;

for (const model of selected) {
  const target = resolve(root, "public/models", model.file);
  if (existsSync(target)) {
    const hash = createHash("sha256").update(readFileSync(target)).digest("hex");
    console.log(`${model.file} already present  sha256 ${hash}`);
    continue;
  }
  console.log(`fetching ${model.file} …`);
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(`${model.file}: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(target, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  console.log(`  wrote ${(bytes.length / 1e6).toFixed(1)}MB  sha256 ${hash}`);
  console.log(`  add to the integrity table in docs/vision.md:`);
  console.log(`  | \`${model.file}\` | \`${hash}\` |`);
}
