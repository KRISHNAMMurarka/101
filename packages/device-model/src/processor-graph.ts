import { DeviceValidationError, parseDeviceDescriptor, snapshotJson } from './descriptor.ts';
import type { DeviceCapability, DeviceDescriptor, PermissionOperation, ValueSchema } from './descriptor.ts';
import { parseProcessorManifest } from './processor-manifest.ts';
import type { ProcessorManifest } from './processor-manifest.ts';

export type ProcessorGraphNode = Readonly<{ id: string; kind: 'processor'; manifest: Readonly<ProcessorManifest> }> |
  Readonly<{ id: string; kind: 'resource'; direction: 'source' | 'sink';
    device: Readonly<DeviceDescriptor>; capability: string }>;
export interface ProcessorGraphEndpoint { readonly node: string; readonly port: string }
export interface ProcessorFeedbackBound {
  readonly delayMs: number; readonly maxAgeMs: number; readonly maxPending: number; readonly maxIterations: number;
}
export interface ProcessorGraphEdge {
  readonly from: Readonly<ProcessorGraphEndpoint>;
  readonly to: Readonly<ProcessorGraphEndpoint>;
  readonly feedback?: Readonly<ProcessorFeedbackBound>;
}
export interface ProcessorGraphPlan {
  readonly nodes: readonly ProcessorGraphNode[];
  readonly edges: readonly ProcessorGraphEdge[];
  readonly executionOrder: readonly string[];
  /** Required declarations, never grants or proof of current permission. */
  readonly requiredOperations: readonly Readonly<{
    node: string; deviceId: string; capability: string; operation: PermissionOperation;
  }>[];
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('graph-object', path);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail('graph-fields', path);
}
function name(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z][a-z0-9-]*$/.test(value)) fail('graph-name', path);
  return value as string;
}
function positive(value: unknown, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) fail('graph-bound', path);
  return value as number;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields).sort().map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function parseNode(input: unknown, path: string): ProcessorGraphNode {
  const value = object(input, path);
  const id = name(value.id, `${path}.id`);
  if (value.kind === 'processor') {
    exact(value, ['id', 'kind', 'manifest'], path);
    return Object.freeze({ id, kind: 'processor', manifest: parseProcessorManifest(value.manifest) });
  }
  if (value.kind !== 'resource') fail('graph-node-kind', `${path}.kind`);
  exact(value, ['id', 'kind', 'direction', 'device', 'capability'], path);
  if (value.direction !== 'source' && value.direction !== 'sink') fail('graph-direction', `${path}.direction`);
  const device = parseDeviceDescriptor(value.device);
  const capability = name(value.capability, `${path}.capability`);
  if (!device.capabilities.some((item) => item.id === capability)) fail('graph-capability', `${path}.capability`);
  return Object.freeze({ id, kind: 'resource', direction: value.direction, device, capability });
}
function parseEndpoint(input: unknown, path: string): Readonly<ProcessorGraphEndpoint> {
  const value = object(input, path);
  exact(value, ['node', 'port'], path);
  return Object.freeze({ node: name(value.node, `${path}.node`), port: name(value.port, `${path}.port`) });
}
function parseEdge(input: unknown, path: string): Readonly<ProcessorGraphEdge> {
  const value = object(input, path);
  exact(value, Object.hasOwn(value, 'feedback') ? ['from', 'to', 'feedback'] : ['from', 'to'], path);
  const from = parseEndpoint(value.from, `${path}.from`);
  const to = parseEndpoint(value.to, `${path}.to`);
  if (!Object.hasOwn(value, 'feedback')) return Object.freeze({ from, to });
  const bound = object(value.feedback, `${path}.feedback`);
  exact(bound, ['delayMs', 'maxAgeMs', 'maxPending', 'maxIterations'], `${path}.feedback`);
  const delayMs = positive(bound.delayMs, 60_000, `${path}.feedback.delayMs`);
  const maxAgeMs = positive(bound.maxAgeMs, 60_000, `${path}.feedback.maxAgeMs`);
  const maxPending = positive(bound.maxPending, 64, `${path}.feedback.maxPending`);
  const maxIterations = positive(bound.maxIterations, 64, `${path}.feedback.maxIterations`);
  if (maxAgeMs < delayMs) fail('graph-feedback-age', `${path}.feedback.maxAgeMs`);
  return Object.freeze({ from, to, feedback: Object.freeze({ delayMs, maxAgeMs, maxPending, maxIterations }) });
}
function resourceCapability(node: Extract<ProcessorGraphNode, { kind: 'resource' }>): DeviceCapability {
  const capability = node.device.capabilities.find((item) => item.id === node.capability);
  if (!capability) fail('graph-capability', `$.nodes.${node.id}`);
  return capability;
}
function outputSchema(node: ProcessorGraphNode, port: string): ValueSchema {
  if (node.kind === 'resource') {
    if (node.direction !== 'source' || port !== node.capability) fail('graph-output', `$.edges.from.${node.id}.${port}`);
    return resourceCapability(node).value;
  }
  const output = node.manifest.outputs.find((item) => item.id === port);
  if (!output) fail('graph-output', `$.edges.from.${node.id}.${port}`);
  return output.value;
}
function inputSchema(node: ProcessorGraphNode, port: string): ValueSchema {
  if (node.kind === 'resource') {
    if (node.direction !== 'sink' || port !== node.capability) fail('graph-input', `$.edges.to.${node.id}.${port}`);
    return resourceCapability(node).value;
  }
  const input = node.manifest.inputs.find((item) => item.id === port);
  if (!input) fail('graph-input', `$.edges.to.${node.id}.${port}`);
  return input.value;
}
function requiredOperation(node: Extract<ProcessorGraphNode, { kind: 'resource' }>): PermissionOperation {
  const capability = resourceCapability(node);
  const operation = node.direction === 'source' ? 'subscribe'
    : capability.kind === 'property' ? 'write'
      : capability.kind === 'command' || capability.kind === 'job' ? 'invoke' : undefined;
  if (!operation || !capability.permissions.includes(operation)) fail('graph-permission', `$.nodes.${node.id}`);
  return operation;
}

/** Validate an inert graph plan. Runtime grants, execution and feedback scheduling are separate. */
export function validateProcessorGraph(input: unknown): Readonly<ProcessorGraphPlan> {
  const source = object(snapshotJson(input), '$');
  exact(source, ['schemaVersion', 'nodes', 'edges'], '$');
  if (source.schemaVersion !== 1) fail('graph-version', '$.schemaVersion');
  if (!Array.isArray(source.nodes) || source.nodes.length < 2 || source.nodes.length > 32 ||
      !Array.isArray(source.edges) || source.edges.length < 1 || source.edges.length > 64) fail('graph-size', '$');
  const nodes = Object.freeze(source.nodes.map((item, index) => parseNode(item, `$.nodes[${index}]`)));
  const edges = Object.freeze(source.edges.map((item, index) => parseEdge(item, `$.edges[${index}]`)));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) fail('graph-duplicate-node', '$.nodes');
  const sources = nodes.filter((node) => node.kind === 'resource' && node.direction === 'source');
  const sinks = nodes.filter((node) => node.kind === 'resource' && node.direction === 'sink');
  if (!sources.length || !sinks.length) fail('graph-endpoints', '$.nodes');
  const requiredOperations = Object.freeze(nodes.filter((node): node is Extract<ProcessorGraphNode, { kind: 'resource' }> => node.kind === 'resource')
    .map((node) => Object.freeze({ node: node.id, deviceId: node.device.id,
      capability: node.capability, operation: requiredOperation(node) })));
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  const seen = new Set<string>();
  const successors = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const predecessors = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const [index, edge] of edges.entries()) {
    const from = byId.get(edge.from.node), to = byId.get(edge.to.node);
    if (!from || !to) fail('graph-unknown-node', `$.edges[${index}]`);
    const left = outputSchema(from, edge.from.port), right = inputSchema(to, edge.to.port);
    if (canonical(left) !== canonical(right)) fail('graph-schema-mismatch', `$.edges[${index}]`);
    if (edge.feedback && (from.kind !== 'processor' || to.kind !== 'processor')) {
      fail('graph-feedback-endpoint', `$.edges[${index}]`);
    }
    const identity = `${edge.from.node}\0${edge.from.port}\0${edge.to.node}\0${edge.to.port}`;
    if (seen.has(identity)) fail('graph-duplicate-edge', `$.edges[${index}]`);
    seen.add(identity);
    const inPort = `${edge.to.node}\0${edge.to.port}`;
    inbound.set(inPort, (inbound.get(inPort) ?? 0) + 1);
    const outPort = `${edge.from.node}\0${edge.from.port}`;
    outbound.set(outPort, (outbound.get(outPort) ?? 0) + 1);
    if (!edge.feedback) {
      successors.get(from.id)!.push(to.id);
      predecessors.get(to.id)!.push(from.id);
      degree.set(to.id, degree.get(to.id)! + 1);
    }
  }
  for (const node of nodes) {
    if (node.kind === 'resource') {
      if (node.direction === 'source' && !outbound.get(`${node.id}\0${node.capability}`) ||
          node.direction === 'sink' && inbound.get(`${node.id}\0${node.capability}`) !== 1) {
        fail('graph-unconnected-port', `$.nodes.${node.id}`);
      }
      continue;
    }
    for (const port of node.manifest.inputs) if (inbound.get(`${node.id}\0${port.id}`) !== 1) fail('graph-input-fan-in', `$.nodes.${node.id}.${port.id}`);
    for (const port of node.manifest.outputs) if (!outbound.get(`${node.id}\0${port.id}`)) fail('graph-unconnected-port', `$.nodes.${node.id}.${port.id}`);
  }
  const queue = nodes.filter((node) => degree.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  for (let at = 0; at < queue.length; at += 1) {
    const id = queue[at]!;
    order.push(id);
    for (const next of successors.get(id)!) {
      const remaining = degree.get(next)! - 1;
      degree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) fail('graph-cycle', '$.edges');
  function reach(start: readonly string[], adjacency: Map<string, string[]>): Set<string> {
    const visited = new Set(start), pending = [...start];
    for (let at = 0; at < pending.length; at += 1) for (const next of adjacency.get(pending[at]!)!) {
      if (!visited.has(next)) { visited.add(next); pending.push(next); }
    }
    return visited;
  }
  const downstream = reach(sources.map((node) => node.id), successors);
  const upstream = reach(sinks.map((node) => node.id), predecessors);
  if (nodes.some((node) => !downstream.has(node.id) || !upstream.has(node.id))) fail('graph-disconnected', '$.nodes');
  return Object.freeze({ nodes, edges, executionOrder: Object.freeze(order), requiredOperations });
}
