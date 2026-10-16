import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('native desktop implementation fences permission, target identity, release and selection races',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, () => {
    const output = execFileSync(process.execPath, ['tools/qa-native-desktop-input.mjs', '--source'],
      { encoding: 'utf8', timeout: 45000, maxBuffer: 262144 });
    const result = JSON.parse(output);
    assert.equal(result.status, 'pass');
    assert.deepEqual(result.checks.map((check: { name: string; count: number }) => [check.name, check.count]),
      [['backend', 17], ['controller', 11]]);
  });
