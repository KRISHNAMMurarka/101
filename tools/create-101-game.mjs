#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createGameScaffold } from "../packages/devkit/src/index.ts";

const [id, suppliedName, suppliedRenderer] = process.argv.slice(2);
if (!id) {
  console.error("Usage: npm run create:game -- <game-id> [\"Game Name\"] [2d|3d]");
  process.exitCode = 1;
} else {
  const renderer = suppliedRenderer === "3d" ? "3d" : "2d";
  const name = suppliedName || id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
  const target = resolve("games", id);
  try {
    await stat(target);
    throw new Error(`Target already exists: ${target}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const files = createGameScaffold({ id, name, renderer });
      for (const [relativePath, contents] of Object.entries(files)) {
        const destination = resolve(target, relativePath);
        await mkdir(resolve(destination, ".."), { recursive: true });
        await writeFile(destination, contents, { encoding: "utf8", flag: "wx" });
      }
      console.log(`Created ${name} at ${target}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
