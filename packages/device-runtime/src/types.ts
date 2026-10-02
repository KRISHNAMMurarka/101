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
  partition?: string; leaseMs?: number; queueCapacity?: number;
  /** Optional caller constraints only narrow the host-authorized grant. */
  constraints?: RouteGrant;
}
export interface Connection {
  readonly id: string;
  start(): Result; stop(reason?: string): void; renew(principalId: string): Result;
  status(): Readonly<{ state: "idle" | "active" | "closed"; reason?: string; pending: number }>;
  limits(): Readonly<{ maxHz: number; maxAgeMs: number; expiresAt: number }> | undefined;
  operations(): readonly OperationRecord[];
}
export interface RuntimeOptions {
  now?: () => number; clockDomain?: string; authorize: Authorize;
  maxRoutes?: number; maxSubscribers?: number; maxRegistrations?: number; maxPendingDeliveries?: number;
}
export interface DeviceRuntime {
  readonly clockDomain: string;
  registerSource(provider: { device: unknown; capability: string }): EndpointHandle;
  registerSink(provider: SinkProvider): EndpointHandle;
  setReadiness(handle: EndpointHandle, readiness: Readiness): Result;
  unregister(handle: EndpointHandle): Result;
  route(request: RouteRequest): Connection;
  publish(source: EndpointHandle, value: unknown, options?: PublishOptions): Result<{ accepted: number; rejected: number }>;
  flush(): void; revoke(connection: Connection): void; close(): void;
}
