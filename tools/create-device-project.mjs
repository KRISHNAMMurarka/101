#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createDeviceScaffold } from '../packages/devkit/src/device-scaffold.ts';

const [id, destination] = process.argv.slice(2);
if (!id || process.argv.length > 4) {
  console.error('Usage: npm run create:device -- <project-id> [destination]');
  process.exitCode = 1;
} else {
  try {
    const files = createDeviceScaffold({ id });
    const target = resolve(destination ?? id);
    // Claim this new directory atomically. Never rename over a racing caller's
    // directory, and preserve any partial or unknown files on a later failure.
    await mkdir(target, { mode: 0o700 });
    for (const [path, contents] of Object.entries(files)) {
      const full = join(target, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents, { encoding: 'utf8', flag: 'wx' });
    }
    console.log(`Created device project at ${target}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
