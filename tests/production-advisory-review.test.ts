import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewCoversAdvisories } from '../tools/production-advisory-policy.mjs';

test('named advisory coverage retains known findings and rejects unidentified or unlisted ones', () => {
  const report = JSON.parse(readFileSync(new URL('./fixtures/production-advisory-review/braces-3.0.2-audit.json', import.meta.url), 'utf8'));
  const entry = report.vulnerabilities.braces;
  const record = { advisoryIds: ['GHSA-vfj7-8cjw-p6xm'] };
  const known = entry.via.filter((via: { url: string }) => via.url.endsWith(record.advisoryIds[0]));
  assert.equal(known.length, 1);
  assert.equal(reviewCoversAdvisories(record, { ...entry, via: known }), true);
  assert.equal(reviewCoversAdvisories(record, entry), false);
  assert.equal(reviewCoversAdvisories(record, { ...entry, via: [{ ...known[0], url: undefined }] }), false);
  assert.equal(reviewCoversAdvisories({}, entry), false, 'a package name alone does not review its advisories');
});

test('the production gate rejects a package-wide review without named advisory identifiers', () => {
  const directory = mkdtempSync(join(tmpdir(), '101-advisory-review-'));
  try {
    for (const name of ['tools', 'security', 'bin']) mkdirSync(join(directory, name));
    for (const name of ['audit-production.mjs', 'production-advisory-policy.mjs']) {
      copyFileSync(new URL(`../tools/${name}`, import.meta.url), join(directory, 'tools', name));
    }
    const { reviewed } = JSON.parse(readFileSync(new URL('../security/build-tooling-advisories.json', import.meta.url), 'utf8'));
    const record = { ...reviewed.find((value: { package: string }) => value.package === 'braces') };
    delete record.advisoryIds;
    writeFileSync(join(directory, 'security/build-tooling-advisories.json'), JSON.stringify({ reviewed: [record] }));
    copyFileSync(new URL('./fixtures/production-advisory-review/braces-3.0.2-audit.json', import.meta.url), join(directory, 'audit.json'));
    // Preserve the authentic producer's complete report and advisory identifiers.
    writeFileSync(join(directory, 'bin/npm'), "#!/usr/bin/env node\nconst fs = require('node:fs'); process.stdout.write(fs.readFileSync(process.env.ONE01_AUDIT_FIXTURE)); process.exit(1);\n", { mode: 0o700 });
    const result = spawnSync(process.execPath, [join(directory, 'tools/audit-production.mjs')], {
      env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, ONE01_AUDIT_FIXTURE: join(directory, 'audit.json') },
      encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, `a review without identifiers must fail the gate: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /invalid advisoryIds/);
  } finally {
    rmSync(directory, { recursive: true });
    assert.equal(existsSync(directory), false);
  }
});

test('an advisory-specific review cannot accept another actual advisory on the same package', () => {
  const directory = mkdtempSync(join(tmpdir(), '101-advisory-review-'));
  try {
    for (const name of ['tools', 'security', 'bin']) mkdirSync(join(directory, name));
    copyFileSync(new URL('../tools/audit-production.mjs', import.meta.url), join(directory, 'tools/audit-production.mjs'));
    const helper = new URL('../tools/production-advisory-policy.mjs', import.meta.url);
    if (existsSync(helper)) copyFileSync(helper, join(directory, 'tools/production-advisory-policy.mjs'));
    const { reviewed } = JSON.parse(readFileSync(new URL('../security/build-tooling-advisories.json', import.meta.url), 'utf8'));
    const record = reviewed.find((value: { package: string }) => value.package === 'braces');
    assert.ok(record);
    writeFileSync(join(directory, 'security/build-tooling-advisories.json'), JSON.stringify({ reviewed: [record] }));
    copyFileSync(new URL('./fixtures/production-advisory-review/braces-3.0.2-audit.json', import.meta.url), join(directory, 'audit.json'));
    // Replay exact npm producer bytes without querying a changing database.
    writeFileSync(join(directory, 'bin/npm'), "#!/usr/bin/env node\nconst fs = require('node:fs'); process.stdout.write(fs.readFileSync(process.env.ONE01_AUDIT_FIXTURE)); process.exit(1);\n", { mode: 0o700 });
    const result = spawnSync(process.execPath, [join(directory, 'tools/audit-production.mjs')], {
      env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, ONE01_AUDIT_FIXTURE: join(directory, 'audit.json') },
      encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, `another advisory must fail the gate: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /UNREVIEWED.*braces/);
  } finally {
    rmSync(directory, { recursive: true });
    assert.equal(existsSync(directory), false);
  }
});
