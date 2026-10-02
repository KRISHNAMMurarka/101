import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from immutable repository source, never the generated app project or an
// ignored local module. Installed dependencies supply the unchanged Expo resolver.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const revision = process.argv[2] ?? 'HEAD';
const tree = execFileSync('git', ['rev-parse', `${revision}^{tree}`], { cwd: root, encoding: 'utf8' }).trim();
const snapshot = mkdtempSync(join(tmpdir(), '101-native-source-'));
try {
  const archive = execFileSync('git', ['archive', tree, 'apps/controller-native'], { cwd: root });
  execFileSync('tar', ['-xf', '-', '-C', snapshot], { input: archive });
  symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'));
  const project = realpathSync(join(snapshot, 'apps/controller-native'));
  const moduleRoot = join(project, 'modules');
  const declarations = readdirSync(moduleRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => ({
      name: entry.name,
      config: JSON.parse(readFileSync(join(moduleRoot, entry.name, 'expo-module.config.json'), 'utf8')),
    }));
  const results = [];
  for (const platform of ['apple', 'android']) {
    const output = execFileSync(process.execPath, [
      join(root, 'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking'),
      'resolve', '--json', '--platform', platform, '--project-root', project,
    ], { encoding: 'utf8' });
    const resolved = JSON.parse(output).modules;
    const configuration = platform === 'apple' ? 'ios' : 'android';
    for (const declaration of declarations.filter(entry => entry.config.platforms.includes(configuration))) {
      const matches = resolved.filter(entry => entry.packageName === declaration.name);
      assert.equal(matches.length, 1, `${declaration.name}: ${platform} source is absent from ${tree}`);
      const resolvedModule = matches[0];
      const sourceDir = platform === 'apple' ? resolvedModule.pods[0].podspecDir : resolvedModule.projects[0].sourceDir;
      assert.equal(realpathSync(sourceDir), join(moduleRoot, declaration.name, configuration), 'resolver must consume snapshot source');
      const classes = platform === 'apple' ? resolvedModule.modules.map(entry => entry.class)
        : resolvedModule.projects.flatMap(project => project.modules.map(entry => entry.classifier));
      assert.deepEqual(classes, declaration.config[configuration].modules);
      const files = readdirSync(sourceDir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name)).sort();
      assert.ok(files.some(path => /\.(swift|m|mm|kt|java)$/.test(path)), 'resolved module must include implementation');
      results.push({ platform, module: declaration.name, files: files.map(path => ({
        path: relative(project, path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      })) });
    }
  }
  console.log(JSON.stringify({ tree, node: process.version, results }, null, 2));
} finally {
  rmSync(snapshot, { recursive: true, force: true });
}
