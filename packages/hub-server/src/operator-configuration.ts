import { PRIVATE_DIRECTORY_LIMITS } from '@101/device-model';
import { createHttpsCoordinator, HTTPS_COORDINATOR_LIMITS } from './https-coordinator.ts';
import type { CoordinatorEnrollment } from './https-coordinator.ts';
import { createCoordinatorDirectory } from './private-directory.ts';
import type { ProvisionedDirectoryResource } from './private-directory.ts';
import { X509Certificate } from 'node:crypto';

export const OPERATOR_CONFIGURATION_PROFILE = 'operator-loopback-startup/1';
export interface OperatorConfiguration {
  readonly schemaVersion: 1; readonly profile: typeof OPERATOR_CONFIGURATION_PROFILE;
  readonly identity: { readonly serverCertificatePem: string; readonly serverPrivateKeyPem: string;
    readonly clientCaCertificatePem: string; readonly enrollments: readonly CoordinatorEnrollment[] };
  readonly origins: readonly string[];
  readonly listener: { readonly host: '127.0.0.1'; readonly port: number };
  readonly directory: { readonly resources: readonly ProvisionedDirectoryResource[] };
  readonly storage: { readonly mode: 'ephemeral'; readonly acknowledgeLossOnStop: true };
  readonly relay: { readonly mode: 'disabled' };
  readonly quotas: { readonly profile: 'fixed-coordinator-directory/1' };
}
type Field = 'configuration' | 'identity' | 'origins' | 'listener' | 'directory' | 'storage' | 'relay' | 'quotas';
type Code = 'configuration-missing' | 'configuration-invalid' | 'identity-invalid' | 'origins-invalid' | 'listener-invalid' |
  'directory-invalid' | 'storage-unsupported' | 'relay-unsupported' | 'quotas-invalid' | 'startup-unavailable' | 'startup-stopped';
export interface OperatorConfigurationIssue { readonly code: Code; readonly field: Field; readonly message: string; readonly recovery: string }
export interface OperatorStartupSnapshot {
  readonly profile: typeof OPERATOR_CONFIGURATION_PROFILE;
  readonly phase: 'prepared' | 'starting' | 'running' | 'failed' | 'stopped';
  readonly endpoint?: string; readonly issue?: OperatorConfigurationIssue;
  readonly requirements: Readonly<{ identity: 'provisioned-mtls'; enrollmentCount: number; originCount: number; directoryResourceCount: number;
    listener: '127.0.0.1'; storage: 'ephemeral'; authorityLostOnStop: true; relay: 'disabled';
    quotas: Readonly<{ coordinator: typeof HTTPS_COORDINATOR_LIMITS; directory: typeof PRIVATE_DIRECTORY_LIMITS }> }>;
}
export type OperatorStartupResult = Readonly<{ ok: true; endpoint: string }> | Readonly<{ ok: false; issue: OperatorConfigurationIssue }>;
export interface OperatorStartupController { start(): Promise<OperatorStartupResult>; stop(): Promise<void>; snapshot(): OperatorStartupSnapshot }
const fields: readonly Field[] = ['identity', 'origins', 'listener', 'directory', 'storage', 'relay', 'quotas'];
function issue(code: Code, field: Field, message: string, recovery: string): OperatorConfigurationIssue {
  return Object.freeze({ code, field, message, recovery });
}
const rejected = (value: OperatorConfigurationIssue) => Object.freeze({ ok: false as const, issue: value });
const recovery: Record<Field, string> = {
  configuration: 'Provide the supported version and all required local startup sections.',
  identity: 'Provide current matching loopback server credentials, a trusted client CA and unique enrolled client certificates.',
  origins: 'Provide distinct exact HTTPS origins without paths, wildcards or embedded credentials.',
  listener: 'Select 127.0.0.1 and a valid port; zero selects an available disposable port.',
  directory: 'Provision only bounded resources belonging to enrolled principals and their enrolled devices.',
  storage: 'Select ephemeral storage and explicitly acknowledge that stop loses sessions, directory membership and bearer authority.',
  relay: 'Select disabled relay for this local profile; TURN and gateway relay are unavailable.',
  quotas: 'Select fixed-coordinator-directory/1; these are enforced admission ceilings, not resource permission.',
};
function own(input: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Invalid closed configuration');
  const keys = Reflect.ownKeys(input); if (keys.length > allowed.length) throw new Error('Invalid closed fields');
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const value = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !value?.enumerable || !Object.hasOwn(value, 'value')) throw new Error('Invalid closed fields');
    output[key] = value.value;
  }
  if (required.some(key => !Object.hasOwn(output, key))) throw new Error('Missing closed fields'); return output;
}
function array(input: unknown, limit: number, empty = false): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > limit || !empty && !input.length) throw new Error('Invalid closed list');
  const keys = Reflect.ownKeys(input); if (keys.length !== input.length + 1) throw new Error('Invalid closed list');
  return Array.from({ length: input.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(input, String(index)); if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw new Error('Invalid list entry'); return property.value;
  });
}
function pem(input: unknown): string { if (typeof input !== 'string' || input.length < 64 || input.length > 16384) throw new Error('Invalid credentials'); return input; }
function identifier(input: unknown): string { if (typeof input !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(input)) throw new Error('Invalid enrollment'); return input; }

/** Selected Node operator boundary. No file loading, credential serialization,
 * persistent storage or relay implementation. Preparation performs actual producer
 * validation without binding; configuration never grants a session/resource operation. */
export function prepareOperatorStartup(input: unknown): Readonly<{ ok: true; controller: OperatorStartupController }> | Readonly<{ ok: false; issue: OperatorConfigurationIssue }> {
  let values: Record<string, unknown>;
  try { values = own(input, ['schemaVersion', 'profile', ...fields], ['schemaVersion', 'profile']); }
  catch { return rejected(issue('configuration-invalid', 'configuration', 'Startup configuration is invalid.', recovery.configuration)); }
  if (values.schemaVersion !== 1 || values.profile !== OPERATOR_CONFIGURATION_PROFILE) return rejected(issue('configuration-invalid', 'configuration', 'Startup profile or version is unsupported.', recovery.configuration));
  for (const field of fields) if (!Object.hasOwn(values, field)) return rejected(issue('configuration-missing', field, `The ${field} startup section is missing.`, recovery[field]));
  let identity: { serverCertificatePem: string; serverPrivateKeyPem: string; clientCaCertificatePem: string; enrollments: CoordinatorEnrollment[] };
  try {
    const value = own(values.identity, ['serverCertificatePem', 'serverPrivateKeyPem', 'clientCaCertificatePem', 'enrollments']);
    identity = { serverCertificatePem: pem(value.serverCertificatePem), serverPrivateKeyPem: pem(value.serverPrivateKeyPem), clientCaCertificatePem: pem(value.clientCaCertificatePem),
      enrollments: array(value.enrollments, HTTPS_COORDINATOR_LIMITS.enrollments).map(input => { const entry = own(input, ['principalId', 'deviceId', 'certificatePem']);
        return Object.freeze({ principalId: identifier(entry.principalId), deviceId: identifier(entry.deviceId), certificatePem: pem(entry.certificatePem) }); }) };
  } catch { return rejected(issue('identity-invalid', 'identity', 'Provisioned identity is missing or invalid.', recovery.identity)); }
  let origins: string[];
  try { origins = array(values.origins, HTTPS_COORDINATOR_LIMITS.origins).map(input => {
    if (typeof input !== 'string' || input.length > 256) throw new Error('Invalid origin'); const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== input) throw new Error('Invalid origin'); return input;
  }); if (new Set(origins).size !== origins.length) throw new Error('Duplicate origin'); }
  catch { return rejected(issue('origins-invalid', 'origins', 'Allowed origins are missing or invalid.', recovery.origins)); }
  let port: number;
  try { const value = own(values.listener, ['host', 'port']); if (value.host !== '127.0.0.1' || typeof value.port !== 'number' || !Number.isSafeInteger(value.port) || value.port < 0 || value.port > 65535) throw new Error('Invalid listener'); port = value.port; }
  catch { return rejected(issue('listener-invalid', 'listener', 'The local listener selection is invalid.', recovery.listener)); }
  try { const value = own(values.storage, ['mode', 'acknowledgeLossOnStop']); if (value.mode !== 'ephemeral' || value.acknowledgeLossOnStop !== true) throw new Error('Unsupported storage'); }
  catch { return rejected(issue('storage-unsupported', 'storage', 'Storage is unsupported or loss on stop has not been acknowledged.', recovery.storage)); }
  try { if (own(values.relay, ['mode']).mode !== 'disabled') throw new Error('Unsupported relay'); }
  catch { return rejected(issue('relay-unsupported', 'relay', 'Relay is unavailable in this local profile.', recovery.relay)); }
  try { if (own(values.quotas, ['profile']).profile !== 'fixed-coordinator-directory/1') throw new Error('Unsupported quotas'); }
  catch { return rejected(issue('quotas-invalid', 'quotas', 'The required fixed admission ceilings were not selected.', recovery.quotas)); }
  let resources: ProvisionedDirectoryResource[];
  try { resources = array(own(values.directory, ['resources']).resources, PRIVATE_DIRECTORY_LIMITS.catalogResources, true) as ProvisionedDirectoryResource[];
    // Reuse the exact producer projection/ownership/parser, never guess catalog fields or permissions.
    const checked = createCoordinatorDirectory(resources, identity.enrollments); checked.close();
  } catch { return rejected(issue('directory-invalid', 'directory', 'The provisioned directory catalog is invalid.', recovery.directory)); }
  let coordinator: ReturnType<typeof createHttpsCoordinator>;
  try { coordinator = createHttpsCoordinator({ ...identity, allowedOrigins: origins, port, directoryResources: resources }); }
  catch { return rejected(issue('identity-invalid', 'identity', 'Coordinator identity or credentials failed current native TLS validation.', recovery.identity)); }
  // Native producer already checked issuer/purpose/key binding. Retain only its
  // parsed validity intervals for fresh startup and post-bind currentness checks.
  const validity = [identity.serverCertificatePem, identity.clientCaCertificatePem, ...identity.enrollments.map(value => value.certificatePem)]
    .map(value => { const certificate = new X509Certificate(value); return Object.freeze({ from: Date.parse(certificate.validFrom), to: Date.parse(certificate.validTo) }); });
  const requirements: OperatorStartupSnapshot['requirements'] = Object.freeze({ identity: 'provisioned-mtls', enrollmentCount: identity.enrollments.length,
    originCount: origins.length, directoryResourceCount: resources.length, listener: '127.0.0.1', storage: 'ephemeral', authorityLostOnStop: true,
    relay: 'disabled', quotas: Object.freeze({ coordinator: HTTPS_COORDINATOR_LIMITS, directory: PRIVATE_DIRECTORY_LIMITS }) });
  let phase: OperatorStartupSnapshot['phase'] = 'prepared', endpoint: string | undefined, problem: OperatorConfigurationIssue | undefined;
  let stopped = false, starting: Promise<OperatorStartupResult> | undefined, stopping: Promise<void> | undefined;
  const stoppedIssue = () => issue('startup-stopped', 'listener', 'This startup owner has stopped.', 'Prepare a new validated startup owner before trying again.');
  const identityIssue = () => issue('identity-invalid', 'identity', 'Provisioned credentials or the current startup clock are no longer valid.', recovery.identity);
  function currentIdentity() { try { const now = Date.now(); return !stopped && Number.isSafeInteger(now) && validity.every(value => value.from <= now && now < value.to); } catch { return false; } }
  function failIdentity(): Promise<OperatorStartupResult> {
    endpoint = undefined; phase = 'failed'; problem = identityIssue();
    return coordinator.stop().then(() => stopped ? rejected(stoppedIssue()) : rejected(problem!));
  }
  const controller: OperatorStartupController = {
    start() {
      if (stopped) return Promise.resolve(rejected(stoppedIssue()));
      if (phase === 'failed') return Promise.resolve(rejected(problem!));
      if (!currentIdentity()) return stopped ? Promise.resolve(rejected(stoppedIssue())) : failIdentity();
      if (endpoint) return Promise.resolve(Object.freeze({ ok: true, endpoint }));
      if (starting) return starting;
      phase = 'starting';
      starting = coordinator.start().then(value => {
        if (stopped) return rejected(stoppedIssue()); if (!currentIdentity()) return stopped ? rejected(stoppedIssue()) : failIdentity();
        endpoint = value; phase = 'running'; return Object.freeze({ ok: true as const, endpoint: value });
      }).catch(async () => {
        await coordinator.stop(); if (stopped) return rejected(stoppedIssue());
        phase = 'failed'; problem = issue('startup-unavailable', 'listener', 'The coordinator could not start on the selected local port.', 'Release the selected owned port or select port zero, then prepare a new startup owner.');
        return rejected(problem);
      });
      return starting;
    },
    stop() { stopped = true; endpoint = undefined; phase = 'stopped'; stopping ??= coordinator.stop(); return stopping; },
    snapshot() { return Object.freeze({ profile: OPERATOR_CONFIGURATION_PROFILE, phase, requirements,
      ...(endpoint === undefined ? {} : { endpoint }), ...(problem === undefined ? {} : { issue: problem }) }); },
  };
  return Object.freeze({ ok: true, controller: Object.freeze(controller) });
}
