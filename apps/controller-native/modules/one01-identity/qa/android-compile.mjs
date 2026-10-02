import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto, createHash } from 'node:crypto';
import { derToP1363 } from '../../../../../packages/device-web/src/identity-format.ts';

// Compile both real source files against installed Android + Expo APIs, without
// touching a generated app project or downloading a toolchain. Not runtime proof.
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../../../..');
const cache = join(homedir(), '.gradle/caches/modules-2/files-2.1');
function jar(group, artifact, version) {
  const base = join(cache, group, artifact, version);
  assert.ok(existsSync(base), `Installed ${artifact} ${version} is required`);
  const matches = readdirSync(base).flatMap(hash => readdirSync(join(base, hash))
    .filter(name => name.endsWith('.jar')).map(name => join(base, hash, name)));
  assert.equal(matches.length, 1, `One installed ${artifact} jar is required`);
  return matches[0];
}
const stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.21');
const compiler = [jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.21'), stdlib,
  jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'), jar('org.jetbrains', 'annotations', '23.0.0'),
  jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.10.2')];
const sdk = process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk');
const android = join(sdk, 'platforms/android-36/android.jar');
const expo = join(root, 'node_modules/expo-modules-core/android/build/intermediates/compile_library_classes_jar/debug/bundleLibCompileToJarDebug/classes.jar');
assert.ok(existsSync(android) && existsSync(expo), 'Installed Android 36 SDK and compiled ExpoModulesCore are required');
const temporary = mkdtempSync(join(tmpdir(), '101-identity-kotlin-'));
const runtime = process.argv[2] === 'runtime';
const adb = join(sdk, 'platform-tools/adb');
const application = 'com.oneohone.link.identityqa';
let emulator;
let installed = false;
try {
  const sources = [join(directory, '../android/src/main/java/com/oneohone/link/identity/One01IdentityStore.kt'),
    join(directory, runtime ? 'AndroidIdentityFixture.kt' : '../android/src/main/java/com/oneohone/link/identity/One01IdentityModule.kt')];
  const classes = join(temporary, 'identity.jar');
  execFileSync('java', ['-cp', compiler.join(':'), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
    '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', [android, stdlib, expo, compiler[4]].join(':'),
    '-d', classes, ...sources],
  { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
  if (!runtime) {
    console.log(JSON.stringify({ result: 'Kotlin native core and Expo module compiled', kotlin: '2.1.21', androidApi: 36, runtime: 'unverified' }));
  } else {
    const devices = execFileSync(adb, ['devices'], { encoding: 'utf8' }).split('\n').map(line => line.trim().split(/\s+/))
      .filter(([name, state]) => name.startsWith('emulator-') && state === 'device');
    assert.equal(devices.length, 1, 'Boot exactly one Android emulator for the disposable fixture');
    emulator = devices[0][0];
    const device = (...args) => execFileSync(adb, ['-s', emulator, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(device('shell', 'getprop', 'sys.boot_completed').trim(), '1', 'Emulator must finish booting');
    assert.equal(device('shell', 'pm', 'list', 'packages', application).trim(), '', 'QA package must not already exist');
    const buildTools = join(sdk, 'build-tools/36.0.0');
    const apk = join(temporary, 'identity.apk');
    execFileSync(join(buildTools, 'aapt2'), ['link', '-o', apk, '--manifest', join(directory, 'AndroidManifest.xml'), '-I', android]);
    execFileSync('java', ['-cp', join(buildTools, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--lib', android, '--min-api', '26',
      '--output', temporary, classes, stdlib], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"a"); z.write(sys.argv[2],"classes.dex"); z.close()', apk, join(temporary, 'classes.dex')]);
    const aligned = join(temporary, 'aligned.apk');
    execFileSync(join(buildTools, 'zipalign'), ['-f', '4', apk, aligned]);
    const signingKey = join(temporary, 'fixture.jks');
    execFileSync('keytool', ['-genkeypair', '-keystore', signingKey, '-storepass', 'fixture-password', '-keypass', 'fixture-password',
      '-alias', 'fixture', '-dname', 'CN=101 Disposable Fixture', '-keyalg', 'RSA', '-validity', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync(join(buildTools, 'apksigner'), ['sign', '--ks', signingKey, '--ks-pass', 'pass:fixture-password', aligned], { stdio: ['ignore', 'pipe', 'pipe'] });
    device('install', aligned);
    installed = true;
    device('shell', 'am', 'start', '-W', '-n', `${application}/com.oneohone.link.identity.AndroidIdentityFixture`);
    let fixture;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { fixture = JSON.parse(device('exec-out', 'run-as', application, 'cat', 'files/result.json')); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    assert.equal(fixture?.result, 'passed', `Native fixture failed: ${fixture?.failureType ?? 'no result'}`);
    assert.notEqual(fixture.cleanup, 'failed');
    assert.equal(fixture.protection, 'os-keystore');
    const raw = new Uint8Array(Buffer.from(fixture.publicKey, 'base64'));
    const message = new Uint8Array(Buffer.from(fixture.message, 'base64'));
    const signature = derToP1363(new Uint8Array(Buffer.from(fixture.signature, 'base64')));
    const key = await webcrypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message), true);
    message[0] ^= 1;
    assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message), false);
    assert.equal(fixture.sha256, createHash('sha256').update(Buffer.from(fixture.message, 'base64')).digest('base64'));
    console.log(JSON.stringify({ result: 'AndroidKeyStore create/load/idempotence/remove/rotation and DER → P1363 → WebCrypto verified; bounds/tampering rejected',
      candidate: device('emu', 'avd', 'name').split('\n')[0].trim(), androidApi: device('shell', 'getprop', 'ro.build.version.sdk').trim(),
      hardwareProtection: 'unverified', expoBridgeRuntime: 'unverified' }));
  }
} finally {
  if (installed) execFileSync(adb, ['-s', emulator, 'uninstall', application], { stdio: ['ignore', 'pipe', 'pipe'] });
  rmSync(temporary, { recursive: true, force: true });
}
