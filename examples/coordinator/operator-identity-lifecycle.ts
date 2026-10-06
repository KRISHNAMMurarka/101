import assert from 'node:assert/strict';
import { request } from 'node:https';
import { createCoordinatorFetcher, prepareOperatorIdentityLifecycle } from '@101/hub-server';
import type { OperatorConfiguration } from '@101/hub-server';

interface Client { certificatePem: string; privateKeyPem: string }
interface Input { initial: OperatorConfiguration; narrowed: OperatorConfiguration; replacement: OperatorConfiguration;
  origin: string; initialClient: Client; removedClient: Client; otherClient: Client; replacementClient: Client }

/** Actual provisioned local identity replacement. Keys/configuration are explicit
 * host inputs; no file/environment lookup, account store, migration or grants. */
export async function runOperatorIdentityLifecycleExample(input: Input) {
  const prepared = prepareOperatorIdentityLifecycle(input.initial); assert.ok(prepared.ok);
  const lifecycle = prepared.controller, callers: ReturnType<typeof createCoordinatorFetcher>[] = [], endpoints: string[] = [];
  const client = (endpoint: string, configuration: OperatorConfiguration, credentials: Client) => {
    const caller = createCoordinatorFetcher({ endpoint, origin: input.origin,
      caCertificatePem: configuration.identity.clientCaCertificatePem, certificatePem: credentials.certificatePem,
      privateKeyPem: credentials.privateKeyPem }); callers.push(caller); return caller;
  };
  const create = async (caller: ReturnType<typeof createCoordinatorFetcher>, endpoint: string) => {
    const response = await caller.fetch(endpoint + '/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'OWNED-IDENTITY' }) });
    assert.equal(response.status, 201); return await response.json() as { hostToken: string };
  };
  const inspect = (caller: ReturnType<typeof createCoordinatorFetcher>, endpoint: string, token: string) =>
    caller.fetch(endpoint + '/v1/sessions/OWNED-IDENTITY/host/peers', { headers: { Authorization: `Bearer ${token}` } });
  let recovery: ReturnType<typeof prepareOperatorIdentityLifecycle> | undefined;
  try {
    const first = await lifecycle.start(); assert.ok(first.ok); endpoints.push(first.endpoint);
    const original = client(first.endpoint, input.initial, input.initialClient), old = await create(original, first.endpoint);
    const invalid = await lifecycle.rotate({ ...input.narrowed, identity: { ...input.narrowed.identity, serverPrivateKeyPem: 'invalid-key' } });
    assert.equal(invalid.ok, false); assert.equal((await inspect(original, first.endpoint, old.hostToken)).status, 200);
    const narrowed = await lifecycle.rotate(input.narrowed); assert.ok(narrowed.ok); endpoints.push(narrowed.endpoint);
    await assert.rejects(original.fetch(first.endpoint + '/v1/health'));
    const current = client(narrowed.endpoint, input.narrowed, input.initialClient), removed = client(narrowed.endpoint, input.narrowed, input.removedClient);
    assert.equal((await removed.fetch(narrowed.endpoint + '/v1/health')).status, 401);
    assert.equal((await inspect(current, narrowed.endpoint, old.hostToken)).status, 404);
    const second = await create(current, narrowed.endpoint); assert.notEqual(second.hostToken, old.hostToken);
    const other = client(narrowed.endpoint, input.narrowed, input.otherClient);
    assert.equal((await inspect(other, narrowed.endpoint, second.hostToken)).status, 404);
    const replacement = await lifecycle.rotate(input.replacement); assert.ok(replacement.ok); endpoints.push(replacement.endpoint);
    await assert.rejects(current.fetch(narrowed.endpoint + '/v1/health'));
    // Both the trust root and the client identity change; no old key/pin is reused.
    const fresh = client(replacement.endpoint, input.replacement, input.replacementClient);
    assert.equal((await fresh.fetch(replacement.endpoint + '/v1/health')).status, 200);
    const retiredTlsCode = await new Promise<string>((resolve, reject) => {
      const probe = request(replacement.endpoint + '/v1/health', { agent: false, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
        ca: input.replacement.identity.clientCaCertificatePem, cert: input.initialClient.certificatePem, key: input.initialClient.privateKeyPem,
        headers: { Origin: input.origin } }, response => { response.resume(); reject(new Error('Retired TLS identity reached the replacement')); });
      probe.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'unavailable'));
      probe.setTimeout(1500, () => probe.destroy(new Error('Owned TLS identity probe exceeded its bound'))); probe.end();
    });
    // The producer destroys rejected native TLS sockets without returning HTTP
    // or an alert body. Healthy-current probes before and after bracket this
    // exact different-CA/key request; no response or bearer authority is issued.
    assert.ok(retiredTlsCode === 'ECONNRESET' || /^ERR_SSL_.*ALERT/.test(retiredTlsCode), 'Actual TLS rejects the retired CA/client identity');
    assert.equal((await fresh.fetch(replacement.endpoint + '/v1/health')).status, 200);
    assert.equal((await inspect(fresh, replacement.endpoint, second.hostToken)).status, 404);
    const third = await create(fresh, replacement.endpoint); assert.notEqual(third.hostToken, second.hostToken);
    const redacted = JSON.stringify(lifecycle.snapshot());
    for (const secret of ['PRIVATE KEY', 'BEGIN CERTIFICATE', old.hostToken, second.hostToken, third.hostToken]) assert.ok(!redacted.includes(secret));
    assert.equal(lifecycle.snapshot().generation, 3); await lifecycle.stop();
    await assert.rejects(fresh.fetch(replacement.endpoint + '/v1/health'));
    assert.equal((await lifecycle.start()).ok, false); assert.equal((await lifecycle.rotate(input.replacement)).ok, false);
    recovery = prepareOperatorIdentityLifecycle(input.replacement); assert.ok(recovery.ok);
    const recovered = await recovery.controller.start(); assert.ok(recovered.ok); endpoints.push(recovered.endpoint);
    const recoveredCaller = client(recovered.endpoint, input.replacement, input.replacementClient);
    assert.equal((await inspect(recoveredCaller, recovered.endpoint, third.hostToken)).status, 404);
    const fourth = await create(recoveredCaller, recovered.endpoint); assert.notEqual(fourth.hostToken, third.hostToken);
    await recovery.controller.stop();
    return Object.freeze({ result: 'pass', actualNativeStartups: 4, successfulRotations: 2, freshRecoveryGeneration: recovered.generation,
      invalidCandidatePreservedIncumbent: true, removedEnrollmentStatus: 401, copiedTenantTokenStatus: 404,
      retiredTlsCode,
      oldBearerStatuses: [404, 404, 404], priorListenersClosed: true, authorityCopied: false, credentialsPersisted: false,
      final: lifecycle.snapshot(), recovery: recovery.controller.snapshot(), endpoints: Object.freeze(endpoints) });
  } finally {
    for (const caller of callers) caller.close();
    await lifecycle.stop(); if (recovery?.ok) await recovery.controller.stop();
  }
}
