#!/usr/bin/env node
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createDeviceScaffold } from '../packages/devkit/src/device-scaffold.ts';

const [id, destination] = process.argv.slice(2);
if (!id || process.argv.length > 4) {
  console.error('Usage: npm run create:device -- <project-id> [destination]');
  process.exitCode = 1;
} else {
  let temporary;
  try {
    const files = createDeviceScaffold({ id });
    const target = resolve(destination ?? id);
    try { await stat(target); throw new Error(`Target already exists: ${target}`); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    temporary = await mkdtemp(join(dirname(target), '.101-device-'));
    for (const [path, contents] of Object.entries(files)) {
      const full = join(temporary, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents, { encoding: 'utf8', flag: 'wx' });
    }
    await rename(temporary, target);
    temporary = undefined;
    console.log(`Created device project at ${target}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
