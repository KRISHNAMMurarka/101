import type { JsonObject, SignalValue } from "@101/device-model";
import type { Evidence, OperationRecord, Result } from "./scheduler.ts";

export interface EndpointHandle { readonly id: string }
export type Readiness = "available" | "unavailable" | "busy" | "denied" | "stale";
export interface PublishOptions {
  sequence?: number; timestamp?: number; clockDomain?: string;
  quality?: "valid" | "unavailable" | "stale"; provenance?: JsonObject;
  operationId?: string; deadline?: number;
}
export interface Observation {
  readonly value: SignalValue; readonly sequence: number; readonly timestamp: number;
  readonly receivedAt: number; readonly clockDomain: string; readonly quality: "valid";
  readonly provenance?: JsonObject;
  readonly source: { readonly registrationId: string; readonly deviceId: string; readonly capabilityId: string };
}
export interface ResourceReference {
  readonly registrationId: string; readonly deviceId: string; readonly capabilityId: string;
  readonly descriptorRevision: number; readonly schemaVersion: number;
}
export interface AuthorizationRequest {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string;
  readonly source: ResourceReference; readonly sink: ResourceReference;
  readonly sourceOperation: "read" | "subscribe"; readonly sinkOperation: "write" | "invoke";
  readonly partition?: string;
}
export interface RouteGrant { expiresAt: number; maxAgeMs: number; maxHz?: number }
export type Authorize = (request: Readonly<AuthorizationRequest>) => RouteGrant | undefined;
export interface DeliveryContext {
  readonly signal: AbortSignal; readonly routeId: string; readonly generation: number;
  readonly operationId?: string;
  readonly partition?: string;
  isCurrent(): boolean;
  reportEvidence(evidence: Evidence): void;
}
export interface SinkProvider {
  device: unknown; capability: string;
  apply(observation: Observation, context: DeliveryContext): void | Promise<void>;
  release(reason: string, context: Readonly<{ routeId: string; partition?: string }>): void;
}
export interface RouteRequest {
  from: EndpointHandle; to: EndpointHandle; principalId: string; applicationId: string; sessionId: string;
  /** Read is a single latest property snapshot; subscribe is a continuing route. */
  sourceOperation?: "read" | "subscribe";
  partition?: string; leaseMs?: number; queueCapacity?: number;
  /** Optional caller constraints only narrow the host-authorized grant. */
  constraints?: RouteGrant;
}
export interface Connection {
  readonly id: string;
  /** Reserve current grant and owner lease without subscribing or dispatching. */
  prepare(): Result;
  /** Recheck authority and activate a prepared connection. */
  activate(): Result;
  start(): Result; stop(reason?: string): void; renew(principalId: string): Result;
  /** Observe terminal route loss after its queues and lease have been released. */
  onClose(listener: (reason: string) => void): () => void;
  /** Optional actual-runtime capability. The same Promise fulfills after terminal
   * retirement, synchronous close/release callouts, and all runtime-reserved apply
   * returns settle. Observation neither stops nor renews a route. A hung returned
   * Promise keeps this pending. It does not prove effects or detached native cleanup. */
  whenSettled?(): Promise<void>;
  status(): Readonly<{ state: "idle" | "prepared" | "active" | "closed"; reason?: string; pending: number }>;
  limits(): Readonly<{ maxHz: number; maxAgeMs: number; expiresAt: number }> | undefined;
  operations(): readonly OperationRecord[];
}
export interface RuntimeOptions {
  now?: () => number; clockDomain?: string; authorize: Authorize;
  maxRoutes?: number; maxSubscribers?: number; maxRegistrations?: number; maxPendingDeliveries?: number;
  /** Outstanding raw provider work per exact principal/application/session tuple; defaults to the global cap. */
  maxPendingDeliveriesPerScope?: number;
  /** Outstanding raw provider work across all approved application/session tuples for an exact principal; defaults to the global cap. */
  maxPendingDeliveriesPerPrincipal?: number;
  /** Sum of UTF-8 encoded publication-envelope bytes reserved by outstanding raw apply returns.
   * Defaults to 4096 times the global count cap; this is not a JavaScript heap limit. */
  maxPendingDeliveryBytes?: number;
  /** Encoded-envelope bytes across all approved tuples for an exact principal; defaults to the global byte cap. */
  maxPendingDeliveryBytesPerPrincipal?: number;
}
export interface DeviceRuntime {
  readonly clockDomain: string;
  registerSource(provider: { device: unknown; capability: string }): EndpointHandle;
  registerSink(provider: SinkProvider): EndpointHandle;
  setReadiness(handle: EndpointHandle, readiness: Readiness, expiresAt?: number): Result;
  unregister(handle: EndpointHandle): Result;
  route(request: RouteRequest): Connection;
  publish(source: EndpointHandle, value: unknown, options?: PublishOptions): Result<{ accepted: number; rejected: number }>;
  flush(): void; revoke(connection: Connection): void; close(): void;
}
