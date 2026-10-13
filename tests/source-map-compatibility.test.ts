import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

type Position = { line: number; column: number };
type Original = { source: string | null; line: number | null; column: number | null; name: string | null };
type Mapping = { source: string | null; generatedLine: number; generatedColumn: number; originalLine: number | null; originalColumn: number | null; name: string | null };
interface Consumer {
  originalPositionFor(position: Position): Original;
  generatedPositionFor(position: Position & { source: string }): { line: number | null; column: number | null };
  eachMapping(callback: (mapping: Mapping) => void): void;
  sourceContentFor(source: string): string;
}
interface Generator {
  addMapping(mapping: { generated: Position; original?: Position; source?: string; name?: string }): void;
  setSourceContent(source: string, content: string): void;
  toJSON(): object;
}
const require = createRequire(import.meta.url);
const { SourceMapConsumer, SourceMapGenerator } = require('source-map-js') as {
  SourceMapConsumer: new (map: object | string) => Consumer;
  SourceMapGenerator: { new (options?: object): Generator; fromSourceMap(consumer: Consumer): Generator };
};
const postcss = require('postcss') as (plugins: unknown[]) => {
  process(css: string, options: object): Promise<{ map: Generator }>;
};
const tailwind = require('@tailwindcss/postcss') as () => unknown;

function basic(source = 'original.css', generated: Position = { line: 1, column: 0 }, original: Position = { line: 1, column: 0 }) {
  const generator = new SourceMapGenerator();
  generator.addMapping({ generated, original, source });
  generator.setSourceContent(source, 'a{color:red}');
  return generator.toJSON();
}
function indexed(line: unknown, column: unknown = 0, map: object = basic()): object {
  return { version: 3, sections: [{ offset: { line, column }, map }] };
}

test('indexed conversion preserves content when sourceRoot is absent', () => {
  const output = SourceMapGenerator.fromSourceMap(new SourceMapConsumer(JSON.stringify(indexed(3))));
  const consumer = new SourceMapConsumer(output.toJSON());
  assert.equal(consumer.sourceContentFor('original.css'), 'a{color:red}');
  assert.deepEqual(consumer.originalPositionFor({ line: 4, column: 0 }), {
    source: 'original.css', line: 1, column: 0, name: null,
  });
});

test('indexed first-column lookup agrees with the emitted mapping', () => {
  const consumer = new SourceMapConsumer(JSON.stringify(indexed(3)));
  const mappings: Mapping[] = []; consumer.eachMapping(mapping => mappings.push(mapping));
  assert.equal(mappings[0]?.generatedLine, 4); assert.equal(mappings[0]?.generatedColumn, 0);
  assert.deepEqual(consumer.originalPositionFor({ line: 4, column: 0 }), {
    source: 'original.css', line: 1, column: 0, name: null,
  });
});

test('first local line receives its section column in reverse and flattened mappings', () => {
  const consumer = new SourceMapConsumer(indexed(3, 5, basic('first.css', { line: 1, column: 2 })));
  assert.deepEqual(consumer.generatedPositionFor({ source: 'first.css', line: 1, column: 0 }), { line: 4, column: 7 });
  const mappings: Mapping[] = []; consumer.eachMapping(mapping => mappings.push(mapping));
  assert.equal(mappings[0]?.generatedLine, 4); assert.equal(mappings[0]?.generatedColumn, 7);
  assert.deepEqual(consumer.originalPositionFor({ line: 4, column: 7 }), { source: 'first.css', line: 1, column: 0, name: null });
});

test('later local lines do not receive a section column offset', () => {
  const consumer = new SourceMapConsumer(indexed(3, 5, basic('later.css', { line: 2, column: 2 }, { line: 2, column: 0 })));
  assert.deepEqual(consumer.generatedPositionFor({ source: 'later.css', line: 2, column: 0 }), { line: 5, column: 2 });
  const mappings: Mapping[] = []; consumer.eachMapping(mapping => mappings.push(mapping));
  assert.equal(mappings[0]?.generatedLine, 5); assert.equal(mappings[0]?.generatedColumn, 2);
});

test('a same-line section boundary selects that section at column zero', () => {
  const consumer = new SourceMapConsumer({ version: 3, sections: [
    { offset: { line: 0, column: 0 }, map: basic('left.css') },
    { offset: { line: 0, column: 5 }, map: basic('right.css', { line: 1, column: 0 }, { line: 2, column: 0 }) },
  ] });
  assert.deepEqual(consumer.originalPositionFor({ line: 1, column: 5 }), { source: 'right.css', line: 2, column: 0, name: null });
});

test('nested indexed sections preserve first-line columns in both directions', () => {
  const consumer = new SourceMapConsumer(indexed(3, 5, indexed(0, 2, basic('nested.css', { line: 1, column: 1 }))));
  assert.deepEqual(consumer.generatedPositionFor({ source: 'nested.css', line: 1, column: 0 }), { line: 4, column: 8 });
  assert.deepEqual(consumer.originalPositionFor({ line: 4, column: 8 }), { source: 'nested.css', line: 1, column: 0, name: null });
  const mappings: Mapping[] = []; consumer.eachMapping(mapping => mappings.push(mapping));
  assert.equal(mappings[0]?.generatedLine, 4); assert.equal(mappings[0]?.generatedColumn, 8);
  assert.deepEqual(consumer.generatedPositionFor({ source: 'absent.css', line: 1, column: 0 }), { line: null, column: null });
});

test('the first indexed mapping name survives iteration and conversion', () => {
  const section = new SourceMapGenerator();
  section.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: 'named.css', name: 'rule' });
  const consumer = new SourceMapConsumer(indexed(3, 0, section.toJSON()));
  const mappings: Mapping[] = []; consumer.eachMapping(mapping => mappings.push(mapping));
  assert.equal(mappings[0]?.name, 'rule');
  const output = new SourceMapConsumer(SourceMapGenerator.fromSourceMap(consumer).toJSON());
  assert.equal(output.originalPositionFor({ line: 4, column: 0 }).name, 'rule');
});

function generatedOnly(mixed: boolean) {
  const section = new SourceMapGenerator();
  section.addMapping({ generated: { line: 1, column: 0 } });
  if (mixed) section.addMapping({ generated: { line: 1, column: 5 }, original: { line: 1, column: 0 }, source: 'original.css' });
  return section.toJSON();
}

for (const shape of ['empty-sources', 'mixed', 'nested'] as const) {
  test(`generated-only indexed ${shape} preserves null sources in iteration and conversion`, () => {
    const section = generatedOnly(shape !== 'empty-sources');
    const map = shape === 'nested' ? indexed(3, 5, indexed(0, 2, section)) : indexed(3, 0, section);
    const column = shape === 'nested' ? 7 : 0;
    const consumer = new SourceMapConsumer(JSON.stringify(map)), rows: Mapping[] = [];
    consumer.eachMapping(mapping => rows.push(mapping));
    assert.deepEqual(rows[0], { source: null, generatedLine: 4, generatedColumn: column, originalLine: null, originalColumn: null, name: null });
    const output = new SourceMapConsumer(SourceMapGenerator.fromSourceMap(consumer).toJSON()), converted: Mapping[] = [];
    output.eachMapping(mapping => converted.push(mapping));
    assert.deepEqual(converted, rows);
    assert.deepEqual(output.originalPositionFor({ line: 4, column }), { source: null, line: null, column: null, name: null });
    if (shape !== 'empty-sources') assert.deepEqual(output.originalPositionFor({ line: 4, column: column + 5 }), { source: 'original.css', line: 1, column: 0, name: null });
  });
}

test('actual no-root PostCSS retains generated-only segments through inline and local maps', async () => {
  const directory = await mkdtemp(join(tmpdir(), '101-unmapped-compat-'));
  try {
    const raw = JSON.stringify(indexed(3, 0, generatedOnly(true)));
    await writeFile(join(directory, 'input.map'), raw, { flag: 'wx' });
    for (const annotation of ['data:application/json;base64,' + Buffer.from(raw).toString('base64'), 'input.map']) {
      const css = '\n\n\na{color:red}\n/*# sourceMappingURL=' + annotation + ' */';
      const result = await postcss([]).process(css, { from: join(directory, 'input.css'), map: { inline: false, annotation: false } });
      const rows: Mapping[] = []; new SourceMapConsumer(result.map.toJSON()).eachMapping(mapping => rows.push(mapping));
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[0], { source: null, generatedLine: 4, generatedColumn: 0, originalLine: null, originalColumn: null, name: null });
      assert.equal(rows[1]?.generatedColumn, 5); assert.match(rows[1]?.source ?? '', /original\.css$/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const mode of ['no-root', 'project-plugin'] as const) {
  test(`actual PostCSS ${mode} preserves valid indexed JSON through inline and local maps`, async () => {
    const directory = await mkdtemp(join(tmpdir(), '101-map-compat-'));
    try {
      const raw = JSON.stringify(indexed(3));
      await writeFile(join(directory, 'input.map'), raw, { flag: 'wx' });
      for (const annotation of ['data:application/json;base64,' + Buffer.from(raw).toString('base64'), 'input.map']) {
        const css = '\n\n\na{color:red}\n/*# sourceMappingURL=' + annotation + ' */';
        const result = await postcss(mode === 'project-plugin' ? [tailwind()] : []).process(css, {
          from: join(directory, 'input.css'), map: { inline: false, annotation: false },
        });
        const position = new SourceMapConsumer(result.map.toJSON()).originalPositionFor({ line: 4, column: 0 });
        assert.match(position.source ?? '', /original\.css$/); assert.equal(position.line, 1); assert.equal(position.column, 0);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('real JSON consumers retain excessive and malformed offset rejection', async () => {
  const bad = [indexed(10_000_001), indexed(6_000_000, 0, indexed(6_000_000)), indexed(0.5),
    indexed(0, 0.5), indexed('1'), indexed(-1)];
  for (const map of bad) {
    const raw = JSON.stringify(map);
    assert.throws(() => new SourceMapConsumer(raw), /[Ss]ection offset/);
    const css = 'a{color:red}\n/*# sourceMappingURL=data:application/json;base64,' + Buffer.from(raw).toString('base64') + ' */';
    await assert.rejects(async () => { await postcss([tailwind()]).process(css, { from: 'input.css', map: { inline: false, annotation: false } }); }, /[Ss]ection offset/);
  }
});
