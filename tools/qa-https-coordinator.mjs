#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'node:https';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

/** Real, disposable credentials. Private keys never enter a receipt or the repository. */
export function createCoordinatorFixtures() {
  const directory = mkdtempSync(join(tmpdir(), '101-coordinator-tls-'));
  const run = (args) => {
    const result = spawnSync('openssl', args, { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) throw new Error(`Disposable certificate generation failed: ${result.stderr?.slice(-600) ?? result.error?.message ?? ''}`);
  };
  const read = (name) => readFileSync(join(directory, name), 'utf8');
  try {
    run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-sha256', '-days', '2', '-keyout', join(directory, 'ca.key'), '-out', join(directory, 'ca.pem'), '-subj', '/CN=101 disposable coordinator CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    writeFileSync(join(directory, 'expired.index'), '');
    writeFileSync(join(directory, 'expired.serial'), '01\n');
    const issue = (name, extensions, days = '1') => {
      run(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-keyout', join(directory, `${name}.key`), '-out', join(directory, `${name}.csr`), '-subj', `/CN=${name}`]);
      writeFileSync(join(directory, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n${extensions}\n`);
      if (days === '0') {
        writeFileSync(join(directory, `${name}.conf`), `[ca]\ndefault_ca=local\n[local]\nnew_certs_dir=${directory}\ndatabase=${directory}/expired.index\nserial=${directory}/expired.serial\ncertificate=${directory}/ca.pem\nprivate_key=${directory}/ca.key\ndefault_md=sha256\npolicy=policy_any\nunique_subject=no\nx509_extensions=profile\n[policy_any]\ncommonName=supplied\n[profile]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n${extensions}\n`);
        run(['ca', '-batch', '-notext', '-config', join(directory, `${name}.conf`), '-in', join(directory, `${name}.csr`), '-out', join(directory, `${name}.pem`), '-startdate', '20200101000000Z', '-enddate', '20200102000000Z']);
      } else {
        run(['x509', '-req', '-in', join(directory, `${name}.csr`), '-CA', join(directory, 'ca.pem'), '-CAkey', join(directory, 'ca.key'), '-CAcreateserial', '-CAserial', join(directory, 'ca.srl'), '-days', days, '-sha256', '-extfile', join(directory, `${name}.ext`), '-out', join(directory, `${name}.pem`)]);
      }
      return { certificatePem: read(`${name}.pem`), privateKeyPem: read(`${name}.key`) };
    };
    const server = issue('server', 'extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1');
    const wrongHost = issue('wrong-host', 'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:wrong.invalid');
    const expiredServer = issue('expired-server', 'extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1', '0');
    const clients = ['host-a', 'host-b', 'peer-a', 'peer-b', 'other', 'unknown'].map((name) => ({ ...issue(name, 'extendedKeyUsage=clientAuth'), principalId: name, deviceId: `device-${name}` }));
    const expiredClient = issue('expired-client', 'extendedKeyUsage=clientAuth', '0');
    return { directory, ca: read('ca.pem'), server, wrongHost, expiredServer, expiredClient, clients, close() { rmSync(directory, { recursive: true, force: true }); } };
  } catch (cause) {
    rmSync(directory, { recursive: true, force: true });
    throw cause;
  }
}


async function main() {
  const workspaceExports = process.argv.slice(2).includes('--workspace-exports');
  let hooks;
  if (workspaceExports) {
    // The owned worktree uses the integration owner's real public barrel. No API substitution.
    const { registerHooks } = await import('node:module');
    const entry = new URL('../packages/hub-server/src/index.ts', import.meta.url).href;
    hooks = registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier === '@101/hub-server' ? entry : specifier, context); } });
  }
  const fixture = createCoordinatorFixtures();
  const cleanup = () => fixture.close();
  const terminate = () => { cleanup(); process.exit(130); };
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  const checks = [];
  const check = (value, label) => { assert.equal(value, true, label); checks.push(label); };
  let coordinator;
  const callers = [];
  try {
    const { createHttpsCoordinator, createCoordinatorFetcher, HTTPS_COORDINATOR_LIMITS } = await import('@101/hub-server');
    check(typeof createHttpsCoordinator === 'function' && typeof createCoordinatorFetcher === 'function', 'public-hub-exports');
    const { runHttpsCoordinatorExample } = await import('../examples/coordinator/https-coordinator.ts');
    const origin = 'https://local-coordinator.example';
    const config = { serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem, clientCaCertificatePem: fixture.ca, allowedOrigins: [origin], enrollments: fixture.clients.slice(0, 5).map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })), port: 0 };
    const example = await runHttpsCoordinatorExample({ coordinator: config, origin, host: fixture.clients[0], peer: fixture.clients[2] });
    check(example.signalingOnly && example.levels.length === 5, 'public-first-caller-create-join-private-signaling-rotation-leave');
    coordinator = createHttpsCoordinator(config);
    const endpoint = await coordinator.start();
    const raw = (client, path = '/v1/health', requestOptions = {}) => new Promise((resolve, reject) => {
      const body = requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body);
      const outgoing = request(endpoint + path, { ca: fixture.ca, cert: client?.certificatePem, key: client?.privateKeyPem, agent: false, minVersion: requestOptions.version ?? 'TLSv1.3', maxVersion: requestOptions.version ?? 'TLSv1.3', method: requestOptions.method ?? 'GET', headers: { ...(requestOptions.origin === null ? {} : { Origin: requestOptions.origin ?? origin }), ...(requestOptions.token ? { Authorization: `Bearer ${requestOptions.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.once('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString(), protocol: incoming.socket.getProtocol(), allowOrigin: incoming.headers['access-control-allow-origin'] }));
      });
      outgoing.once('error', reject);
      outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Disposable request timeout')));
      outgoing.end(body);
    });
    const health = await raw(fixture.clients[0]);
    check(health.status === 200 && health.protocol === 'TLSv1.3' && health.allowOrigin === origin, 'actual-loopback-tls13');
    const rejects = async (operation, label) => { await assert.rejects(operation); checks.push(label); };
    await rejects(() => raw(undefined), 'missing-client-certificate');
    await rejects(() => raw(fixture.clients[0], '/v1/health', { version: 'TLSv1.2' }), 'tls12-rejected');
    await rejects(() => raw(fixture.expiredClient), 'expired-client-certificate');
    check((await raw(fixture.clients[5])).status === 401, 'unenrolled-client-rejected');
    for (const deniedOrigin of ['https://denied.example', 'null', null]) {
      const denied = await raw(fixture.clients[0], '/v1/sessions', { method: 'POST', origin: deniedOrigin, body: { sessionId: 'DENIED101' } });
      check(denied.status === 403 && denied.allowOrigin === undefined, `origin-denied-${checks.length}`);
    }
    const host = createCoordinatorFetcher({ endpoint, origin, caCertificatePem: fixture.ca, certificatePem: fixture.clients[0].certificatePem, privateKeyPem: fixture.clients[0].privateKeyPem });
    callers.push(host);
    const createdResponse = await host.fetch(endpoint + '/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'DENIED101' }) });
    check(createdResponse.status === 201, 'origin-denials-did-not-create-session');
    const created = await createdResponse.json();
    const copied = await raw(fixture.clients[1], '/v1/sessions/DENIED101/host/peers', { token: created.hostToken });
    const unknown = await raw(fixture.clients[1], '/v1/sessions/UNKNOWN101/host/peers', { token: created.hostToken });
    check(copied.status === 404 && copied.body === unknown.body && !copied.body.includes(created.hostToken) && !copied.body.includes(created.ticket.joinToken), 'private-principal-and-error-boundary');
    await rejects(() => host.fetch('https://other.example/v1/health'), 'caller-no-cross-origin-credential-forwarding');
    await coordinator.stop();
    await rejects(() => raw(fixture.clients[0]), 'shutdown-closes-listener-and-authority');
    await rejects(() => coordinator.start(), 'shutdown-prevents-authority-restart');
    const api = readFileSync(new URL('../packages/hub-server/src/https-coordinator.ts', import.meta.url));
    const sha256 = createHash('sha256').update(api).digest('hex');
    cleanup();
    console.log(JSON.stringify({ result: 'pass', profile: 'provisioned-loopback-node-mtls/1', node: process.version, publicExportResolution: workspaceExports ? 'owned-worktree-barrel' : 'normal-package', implementationSha256: sha256, checks, limits: HTTPS_COORDINATOR_LIMITS, disposableCredentialsRemoved: true, excluded: ['browser-client-cert-provisioning', 'account-or-key-lifecycle', 'resource-grants', 'WebRTC-media-negotiation', 'relay', 'phones', 'two-network-topology'] }, null, 2));
  } finally {
    callers.forEach((caller) => caller.close());
    if (coordinator) await coordinator.stop();
    cleanup();
    process.removeListener('SIGINT', terminate);
    process.removeListener('SIGTERM', terminate);
    hooks?.deregister();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
