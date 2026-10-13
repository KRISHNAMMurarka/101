import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

export const SSH_HOST_LIMITS = Object.freeze({ lifetimeMs: 15000, commandMs: 2500, stdoutBytes: 1024,
  stderrBytes: 4096, nativePending: 1, attempts: 64, activeFixtures: 2 });
const hosts = new WeakMap(), credentials = new WeakMap();
let activeFixtures = 0;
const sha = value => createHash('sha256').update(value).digest('hex');
const safePath = value => typeof value === 'string' && value.length <= 256 && /^\/[A-Za-z0-9_./-]+$/.test(value);
const keyPattern = /^ssh-ed25519 [A-Za-z0-9+/]{68}=?$/;

// Fixed inert software metadata producer. SSH_ORIGINAL_COMMAND is compared,
// never evaluated. No input can select a program, path, shell or operation.
const metadataSource = `import { platform, arch } from 'node:os';import {randomBytes} from 'node:crypto';
if(process.env.SSH_ORIGINAL_COMMAND!=='metadata')process.exit(64);
await new Promise(resolve=>setTimeout(resolve,100));
process.stdout.write(JSON.stringify({profile:'loopback-openssh-metadata/1',platform:platform(),arch:arch(),sourceTime:performance.now(),clockId:process.env.METADATA_CLOCK+':'+process.pid+':'+randomBytes(6).toString('hex')}));
`;
export const SSH_METADATA_SOURCE_SHA256 = sha(metadataSource);
function fingerprint(key) { return 'SHA256:' + createHash('sha256').update(Buffer.from(key.split(' ')[1], 'base64')).digest('base64').replace(/=+$/, ''); }
function end(child) { return new Promise(resolve => child.once('close', resolve)); }
function kill(child, group = false) { try { if (group) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already settled. */ } }
function unavailable() { throw Error('Owned SSH host unavailable'); }
const safeErrorCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(value) ? value : null;
function startupProbe(kind, result) {
  return Object.freeze({ kind, status: result.status, signal: result.signal, errorCode: safeErrorCode(result.error?.code) });
}
function current(record) { return !record.closing && record.daemon.exitCode === null && record.daemon.signalCode === null && performance.now() < record.expiresAt; }
function sameFile(path, previous, mode) {
  try { const value = lstatSync(path); return value.isFile() && !value.isSymbolicLink() && value.uid === process.getuid() &&
    (value.mode & 0o777) === mode && value.nlink === 1 && value.dev === previous.dev && value.ino === previous.ino && realpathSync(path) === path; }
  catch { return false; }
}
function sourceCurrent(record) {
  let descriptor;
  try {
    if (!sameFile(record.metadataFile, record.metadataStat, 0o600)) return false;
    descriptor = openSync(record.metadataFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor); if (stat.dev !== record.metadataStat.dev || stat.ino !== record.metadataStat.ino || stat.size !== Buffer.byteLength(metadataSource)) return false;
    const bytes = Buffer.alloc(Buffer.byteLength(metadataSource) + 1), size = readSync(descriptor, bytes, 0, bytes.byteLength, 0);
    return size === Buffer.byteLength(metadataSource) && sha(bytes.subarray(0, size)) === SSH_METADATA_SOURCE_SHA256;
  } catch { return false; } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Explicit owned macOS fixture; importing is inert. The native daemon has the
 * current user's authority. This is a cooperative fixed-operation fixture,
 * not a filesystem/account sandbox or a remote SSH deployment helper. */
export async function createDisposableLoopbackSshHost() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.getuid() === 0 || activeFixtures >= SSH_HOST_LIMITS.activeFixtures) unavailable();
  // OpenSSH invokes the account's login shell. Refuse ambient startup hooks;
  // scratch ZDOTDIR/HOME prevents reading any user shell or SSH startup files.
  const account = userInfo();
  if (account.shell !== '/bin/zsh' || !/^[a-z][a-z0-9_-]{0,31}$/.test(account.username) || !safePath(process.execPath)) unavailable();
  for (const path of ['/etc/zshenv', '/etc/zshenv.zwc', '/etc/ssh/sshrc']) {
    try { await lstat(path); unavailable(); } catch (error) { if (error.code !== 'ENOENT') throw Error('Owned SSH ambient startup unsupported'); }
  }
  const home = await lstat(homedir());
  if (!home.isDirectory() || home.uid !== process.getuid() || (home.mode & 0o022) !== 0 || realpathSync(homedir()) !== homedir()) unavailable();
  const version = spawnSync('/usr/sbin/sshd', ['-V'], { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 });
  if (version.status !== 0 || version.stderr.trim() !== 'OpenSSH_10.2p1, LibreSSL 3.3.6') unavailable();
  activeFixtures++;
  let root, daemon, daemonDone, record, lifetime, nativeProbe, stopOwned;
  let stage = 'owned-root', listenerOutcome = 'not-started', daemonErrorCode = null;
  try {
    root = await mkdtemp(join(homedir(), '.101-owned-ssh-')); await chmod(root, 0o700);
    if (!safePath(root) || realpathSync(root) !== root) unavailable();
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, LANG: 'C', LC_ALL: 'C' };
    stage = 'key-generation';
    for (const name of ['host', 'client']) {
      const generated = spawnSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '101-disposable-' + name, '-f', join(root, name)],
        { env, encoding: 'utf8', timeout: 1000, maxBuffer: 1024 });
      nativeProbe = startupProbe('ssh-keygen-' + name, generated);
      if (generated.status !== 0) unavailable();
    }
    stage = 'fixture-files';
    const hostKey = (await readFile(join(root, 'host.pub'), 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
    if (!keyPattern.test(hostKey)) unavailable();
    const clientKey = (await readFile(join(root, 'client.pub'), 'utf8')).trim();
    await writeFile(join(root, 'authorized_keys'), 'restrict,from="127.0.0.1" ' + clientKey + '\n', { mode: 0o600 });
    await writeFile(join(root, 'metadata.mjs'), metadataSource, { mode: 0o600 });
    const nonce = randomBytes(16).toString('hex'), clockId = 'ssh:' + nonce;
    // Only this owned socket selects a high port. A subsequent bind collision
    // fails startup; no retry can retarget to another listener.
    stage = 'port-selection';
    const selector = createServer();
    await new Promise((resolve, reject) => { selector.once('error', reject); selector.listen(0, '127.0.0.1', resolve); });
    const port = selector.address().port; await new Promise(resolve => selector.close(resolve));
    const config = ['AddressFamily inet', 'ListenAddress 127.0.0.1', 'Port ' + port, 'HostKey ' + join(root, 'host'), 'PidFile none',
      'AuthorizedKeysFile ' + join(root, 'authorized_keys'), 'AuthorizedKeysCommand none', 'AllowUsers ' + account.username + '@127.0.0.1',
      'AuthenticationMethods publickey', 'PubkeyAuthentication yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
      'HostbasedAuthentication no', 'GSSAPIAuthentication no', 'KerberosAuthentication no', 'UsePAM no', 'UseDNS no',
      'PermitRootLogin no', 'PermitEmptyPasswords no', 'PermitUserEnvironment no', 'PermitUserRC no', 'StrictModes yes',
      'DisableForwarding yes', 'PermitTTY no', 'PermitTunnel no', 'X11Forwarding no', 'PermitOpen none', 'PermitListen none',
      'MaxSessions 1', 'MaxStartups 1', 'MaxAuthTries 1', 'LoginGraceTime 2', 'ChannelTimeout session=2s', 'UnusedConnectionTimeout 2s',
      'PrintMotd no', 'PrintLastLog no', 'LogLevel VERBOSE',
      'SetEnv HOME=' + root + ' ZDOTDIR=' + root + ' PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C METADATA_CLOCK=' + clockId,
      'ForceCommand exec ' + process.execPath + ' ' + join(root, 'metadata.mjs')].join('\n') + '\n';
    await writeFile(join(root, 'sshd_config'), config, { mode: 0o600 });
    stage = 'configuration-validation';
    const valid = spawnSync('/usr/sbin/sshd', ['-t', '-f', join(root, 'sshd_config')], { env, encoding: 'utf8', timeout: 1000, maxBuffer: 4096 });
    nativeProbe = startupProbe('sshd-validation', valid);
    if (valid.status !== 0) unavailable();
    stage = 'listener-startup';
    daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    daemonDone = end(daemon);
    const expiresAt = performance.now() + SSH_HOST_LIMITS.lifetimeMs;
    record = { root, env, daemon, daemonDone, port, account: account.username, hostKey, closing: false, removed: false, clients: new Set(),
      closePromise: undefined, expiresAt, clockId, attempts: 0, credentialFile: join(root, 'client'), credentialStat: await lstat(join(root, 'client')),
      metadataFile: join(root, 'metadata.mjs'), metadataStat: await lstat(join(root, 'metadata.mjs')),
      id: 'ssh-' + nonce, credentialId: 'credential-' + randomBytes(16).toString('hex'), hostFingerprint: fingerprint(hostKey) };
    async function stop() {
      if (record.closePromise) return record.closePromise;
      record.closing = true; clearTimeout(lifetime);
      record.closePromise = (async () => {
        for (const item of record.clients) kill(item.child);
        kill(daemon, true);
        await Promise.all([daemonDone, ...Array.from(record.clients, item => item.done)]);
        await rm(root, { recursive: true, force: false }); record.removed = true; activeFixtures--;
      })();
      return record.closePromise;
    }
    stopOwned = stop;
    const host = Object.freeze({ identity: Object.freeze({ id: record.id, address: '127.0.0.1', port, hostKey, hostFingerprint: record.hostFingerprint, clockId }),
      credential: Object.freeze({ id: record.credentialId }),
      status: () => Object.freeze({ current: current(record), closing: record.closing, nativePending: record.clients.size, attempts: record.attempts,
        removedOwnedRoot: record.removed, timerArmed: !!lifetime && !record.closing, software: 'OpenSSH_10.2p1' }), stop });
    hosts.set(host, record); credentials.set(host.credential, record);
    lifetime = setTimeout(() => { stop().catch(() => {}); }, SSH_HOST_LIMITS.lifetimeMs);
    daemon.once('error', error => { daemonErrorCode = safeErrorCode(error.code); stop().catch(() => {}); });
    daemon.once('exit', () => { stop().catch(() => {}); });
    await new Promise((resolve, reject) => {
      let bytes = '', ready = false;
      listenerOutcome = 'pending';
      const timer = setTimeout(() => finish(false, 'deadline'), 1000);
      function finish(ok, outcome) { if (ready) return; ready = true; listenerOutcome = outcome; clearTimeout(timer); daemon.stderr.off('data', listen);
        if (ok) resolve(); else reject(Error('Owned SSH listener unavailable')); }
      function listen(chunk) { if (bytes.length + chunk.byteLength > SSH_HOST_LIMITS.stderrBytes) { finish(false, 'output-limit'); return; }
        bytes += chunk.toString('utf8'); if (bytes.includes('Server listening on 127.0.0.1 port ' + port + '.')) finish(true, 'ready'); }
      daemon.stderr.on('data', listen); daemon.once('close', () => finish(false, 'daemon-close'));
    });
    // Drain logs without retaining native authentication identities or errors.
    daemon.stderr.on('data', () => {});
    stage = 'final-currentness';
    if (!current(record)) { await stop(); unavailable(); }
    return host;
  } catch {
    // Snapshot native state before requested teardown changes exit/signal codes.
    // Keep only fixed labels and codes, never paths, credentials or raw output.
    const diagnostics = Object.freeze({ stage, native: nativeProbe ?? null,
      listener: Object.freeze({ outcome: listenerOutcome, errorCode: daemonErrorCode,
        exitCode: daemon?.exitCode ?? null, signalCode: daemon?.signalCode ?? null }) });
    clearTimeout(lifetime);
    if (stopOwned) await stopOwned().catch(() => {});
    else {
      if (daemon) { kill(daemon, true); await daemonDone; }
      if (root) await rm(root, { recursive: true, force: true }); activeFixtures--;
    }
    throw Error('Owned SSH startup unavailable', { cause: Object.freeze({ ...diagnostics, cleanupCompleted: record ? record.removed : true }) });
  }
}

/** Internal native port, with no SDK resource authority. Only an opaque owned
 * fixture and credential can select input. Callers must supply their own
 * operation/result grants. Exposes a real child solely to the scoped adapter. */
export function ownedSshHostPort(host, credential) {
  const record = hosts.get(host), key = credentials.get(credential);
  if (!record || !key) unavailable();
  return Object.freeze({ identity: host.identity, credentialId: key.credentialId,
    isCurrent: () => current(record) && current(key),
    spawn(hostKey, literal = 'metadata') {
      // The second fixed literal exists only for a genuine host refusal probe;
      // it cannot choose code or a command, and the forced producer exits64.
      if (!keyPattern.test(hostKey) || !['metadata', 'unsupported-fixture'].includes(literal) || !current(record) || !current(key) || record.clients.size >= 1 ||
        record.attempts >= SSH_HOST_LIMITS.attempts || !sameFile(key.credentialFile, key.credentialStat, 0o600) || !sourceCurrent(record)) unavailable();
      // One owned600 file carries the explicit pin. No global/user known_hosts
      // files or DNS can introduce another identity. stdin is always disabled.
      const knownHosts = join(record.root, 'selected_known_hosts');
      writeFileSync(knownHosts, '[127.0.0.1]:' + record.port + ' ' + hostKey + '\n', { flag: 'wx', mode: 0o600 });
      const args = ['-F', 'none', '-T', '-n', '-p', String(record.port), '-i', key.credentialFile,
        '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile=' + knownHosts, '-o', 'GlobalKnownHostsFile=none', '-o', 'VerifyHostKeyDNS=no', '-o', 'UpdateHostKeys=no',
        '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
        '-o', 'HostbasedAuthentication=no', '-o', 'GSSAPIAuthentication=no', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
        '-o', 'RequestTTY=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
        '-o', 'PermitLocalCommand=no', '-o', 'ConnectTimeout=2', '-o', 'ConnectionAttempts=1', record.account + '@127.0.0.1', literal];
      const child = spawn('/usr/bin/ssh', args, { env: record.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const item = { child, done: end(child) }; record.clients.add(item); record.attempts++;
      child.once('close', () => { record.clients.delete(item); try { unlinkSync(knownHosts); } catch { /* Exact root teardown owns remaining file. */ } });
      return child;
    },
  });
}
