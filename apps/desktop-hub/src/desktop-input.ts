import { createDeviceRuntime } from "@101/connect";
import type { AuthorizationRequest, Connection, DeviceRuntime, EndpointHandle, RouteGrant } from "@101/connect";

export type DesktopInputCommand =
  | { type: "pointer"; x: number; y: number }
  | { type: "key"; key: "Left" | "Right" | "Up" | "Down" | "Space" | "Return" | "Escape" | "Tab"; down: boolean }
  | { type: "button"; button: "Left" | "Right"; down: boolean; x: number; y: number };
export interface NativeTarget { application: string; window: string; pid: number; windowId: number; displayId: number }
export interface NativeSelection { token: string; target: NativeTarget }
export interface DesktopInputOptions {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  now(): number;
  principalId: string; applicationId: string; sessionId: string;
  /** This public runtime grant is independent of the native user confirmation. */
  authorizeRoute?(request: Readonly<AuthorizationRequest>): RouteGrant | undefined;
}
const MAX_COMMAND_MS = 500;
const fields = {
  pointer: { x: { type: "scalar", unit: "1", min: 0, max: 1 }, y: { type: "scalar", unit: "1", min: 0, max: 1 } },
  key: { key: { type: "enum", values: ["Left", "Right", "Up", "Down", "Space", "Return", "Escape", "Tab"] }, down: { type: "boolean" } },
  button: { button: { type: "enum", values: ["Left", "Right"] }, down: { type: "boolean" },
    x: { type: "scalar", unit: "1", min: 0, max: 1 }, y: { type: "scalar", unit: "1", min: 0, max: 1 } },
} as const;
type Kind = keyof typeof fields;
const kinds: readonly Kind[] = ["pointer", "key", "button"];
const clockField = { type: "scalar", unit: "ms", min: 0, max: 1e12 } as const;
function descriptor(kind: Kind, sink: boolean) {
  return { schemaVersion: 1, id: `local:desktop-${sink ? "sink" : "source"}-${kind}`, label: `Desktop ${kind}`,
    revision: 1, adapter: { id: "local:desktop-native-input", version: "1.0.0" },
    runtime: { platform: "macos-desktop-hub" }, capabilities: [{ id: "input", semantic: `local:desktop-${kind}`,
      schemaVersion: 1, kind: sink ? "command" : "event",
      value: { type: "record", fields: { ...fields[kind], deadlineMs: clockField } },
      delivery: { mode: "reliable", maxAgeMs: MAX_COMMAND_MS },
      permissions: [sink ? "invoke" : "subscribe"], ...(sink ? { ownership: { mode: "exclusive" } } : {}) }] };
}

/** Same-machine renderer/native deadline mapping, distinct from the public
 * four-timestamp RemoteClockMap used for remote producers. Assumes each local
 * monotonic clock rate stays within 100 ppm over a fresh <=500 ms command
 * exchange. RTT must be <=200 ms; subtract all measured RTT and drift.
 */
export class NativeDeadlineMap {
  readonly #nativeNowNs: bigint;
  readonly #receivedAtMs: number;
  readonly #sentAtMs: number;
  constructor(sample: { nativeNowNs: string; sentAtMs: number; receivedAtMs: number }) {
    if (!/^\d{1,20}$/.test(sample.nativeNowNs) || !Number.isFinite(sample.sentAtMs) ||
      !Number.isFinite(sample.receivedAtMs) || sample.receivedAtMs < sample.sentAtMs ||
      sample.receivedAtMs - sample.sentAtMs > 200) throw new TypeError("Invalid clock exchange");
    this.#nativeNowNs = BigInt(sample.nativeNowNs);
    this.#sentAtMs = sample.sentAtMs;
    this.#receivedAtMs = sample.receivedAtMs;
  }
  deadlineNs(originalDeadlineMs: number): string | undefined {
    const remaining = originalDeadlineMs - this.#receivedAtMs;
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > MAX_COMMAND_MS) return undefined;
    // Native sample was made during the exchange. Subtract measured trip time
    // and one extra millisecond, never adding time on IPC receipt.
    const safetyMs = Math.min(remaining, this.#receivedAtMs - this.#sentAtMs + 1 + MAX_COMMAND_MS * 100 / 1_000_000);
    const nativeRemainingNs = Math.floor((remaining - safetyMs) * 1e6);
    if (nativeRemainingNs <= 0) return undefined;
    return (this.#nativeNowNs + BigInt(nativeRemainingNs)).toString();
  }
}

export interface DesktopInputBridge {
  select(): Promise<NativeTarget>;
  startRoutes(): boolean;
  publish(command: DesktopInputCommand, originalDeadlineMs: number): { ok: boolean; reason?: string };
  stop(): Promise<void>;
  close(): Promise<void>;
}
export function createDesktopInputBridge(options: DesktopInputOptions): DesktopInputBridge {
  const invoke = options.invoke, now = options.now, authorizeRoute = options.authorizeRoute;
  const principalId = options.principalId, applicationId = options.applicationId, sessionId = options.sessionId;
  const runtime: DeviceRuntime = createDeviceRuntime({ now, clockDomain: "renderer-monotonic",
    authorize: request => authorizeRoute?.(request) });
  let selection: NativeSelection | undefined;
  let disposed = false, sequence = 0, epoch = 0, selectionRevision = 0, selecting = false;
  let stopping: Promise<void> | undefined;
  let stopFailure: unknown, hasStopFailure = false;
  let pendingNativeSelection: Promise<unknown> | undefined;
  const routes: Connection[] = [];
  const sources = new Map<Kind, EndpointHandle>();
  const sinks = new Map<Kind, EndpointHandle>();
  const apply = async (kind: Kind, value: unknown, current: () => boolean) => {
    if (!current() || disposed || !selection || typeof value !== "object" || value === null) return;
    const originalDeadlineMs = (value as { deadlineMs?: unknown }).deadlineMs;
    if (typeof originalDeadlineMs !== "number" || originalDeadlineMs <= now()) return;
    const selected = selection, generation = epoch;
    const sentAtMs = now();
    const sample = await invoke("native_input_clock") as { nativeNowNs: string };
    const receivedAtMs = now();
    if (!current() || disposed || generation !== epoch || selected !== selection) return;
    let deadlineNs: string | undefined;
    try { deadlineNs = new NativeDeadlineMap({ nativeNowNs: sample.nativeNowNs, sentAtMs, receivedAtMs }).deadlineNs(originalDeadlineMs); }
    catch { return; }
    if (!deadlineNs) return;
    const lastNow = now();
    if (!current() || disposed || generation !== epoch || selected !== selection || originalDeadlineMs <= lastNow) return;
    const { deadlineMs: _deadlineMs, ...payload } = value as Record<string, unknown>;
    void _deadlineMs;
    // A completed invoke proves only that the native call returned, never OS delivery.
    await invoke("native_input_event", { token: selected.token, event: { type: kind, ...payload }, deadlineNs });
  };
  for (const kind of kinds) {
    sources.set(kind, runtime.registerSource({ device: descriptor(kind, false), capability: "input" }));
    sinks.set(kind, runtime.registerSink({ device: descriptor(kind, true), capability: "input",
      apply: (observation, context) => apply(kind, observation.value, () => context.isCurrent() && !context.signal.aborted),
      release: () => { if (!stopping) void stop().catch(() => {}); } }));
    runtime.setReadiness(sources.get(kind)!, "available"); runtime.setReadiness(sinks.get(kind)!, "available");
  }
  function select(): Promise<NativeTarget> {
    if (selecting) return Promise.reject(new Error("Selection already in progress"));
    selecting = true;
    const requestedRevision = selectionRevision;
    const task = Promise.resolve().then(async () => {
      if (disposed || selectionRevision !== requestedRevision) throw new Error("Selection cancelled");
      if (selection) {
        // A retired native watchdog lease can leave the renderer with its old
        // token. Fence and settle that lease before asking for fresh approval.
        const priorStop = stop(), ownRevision = selectionRevision;
        await priorStop;
        if (selectionRevision !== ownRevision) throw new Error("Selection cancelled");
      } else if (stopping) {
        const waitingRevision = selectionRevision;
        await stopping;
        if (selectionRevision !== waitingRevision) throw new Error("Selection cancelled");
      }
      if (disposed) throw new Error("Selection cancelled");
      const generation = ++epoch;
      const admissionRevision = selectionRevision;
      // Publish the pending operation before invoke can synchronously reenter
      // Stop. A Stop before this callout also prevents the callout entirely.
      const native = Promise.resolve().then(() => {
        if (disposed || generation !== epoch || selectionRevision !== admissionRevision)
          throw new Error("Selection cancelled");
        return invoke("native_input_select");
      });
      pendingNativeSelection = native;
      let result: NativeSelection;
      try { result = await native as NativeSelection; }
      finally { if (pendingNativeSelection === native) pendingNativeSelection = undefined; }
      if (disposed || generation !== epoch || selectionRevision !== admissionRevision)
        throw new Error("Selection cancelled");
      if (!result || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.token))
        throw new Error("Native selection unavailable");
      selection = result;
      return result.target;
    });
    return task.finally(() => { selecting = false; });
  }
  function startRoutes(): boolean {
    if (disposed || !selection || routes.length) return false;
    const prepared: Connection[] = [];
    try {
      for (const kind of kinds) {
        const route = runtime.route({ from: sources.get(kind)!, to: sinks.get(kind)!, principalId,
          applicationId, sessionId, queueCapacity: 8 });
        if (!route.prepare().ok) { route.stop("denied"); throw Error("route denied"); }
        prepared.push(route);
      }
      for (const route of prepared) if (!route.activate().ok) throw Error("route unavailable");
      routes.push(...prepared);
      return true;
    } catch { for (const route of prepared) route.stop("activation-failed"); void stop().catch(() => {}); return false; }
  }
  function publish(command: DesktopInputCommand, originalDeadlineMs: number): { ok: boolean; reason?: string } {
    const at = now();
    if (disposed || !selection || routes.length !== kinds.length) return { ok: false, reason: "unavailable" };
    if (!Number.isFinite(originalDeadlineMs) || originalDeadlineMs <= at || originalDeadlineMs - at > MAX_COMMAND_MS)
      return { ok: false, reason: "deadline" };
    const kind = command.type;
    if (!kinds.includes(kind)) return { ok: false, reason: "schema" };
    const source = sources.get(kind)!;
    const { type: _type, ...payload } = command;
    void _type;
    const result = runtime.publish(source, { ...payload, deadlineMs: originalDeadlineMs },
      { sequence: ++sequence, timestamp: at, operationId: String(sequence), deadline: originalDeadlineMs,
        provenance: { source: "local-desktop-ui" } });
    runtime.flush();
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }
  function stop(): Promise<void> {
    selectionRevision++;
    if (stopping) return stopping;
    epoch++;
    selection = undefined;
    const pending = pendingNativeSelection;
    // Reserve the shared settlement before route.stop can synchronously call
    // release (which may call stop again), or invoke can call back into us.
    const task = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      for (const route of routes.splice(0)) {
        try { route.stop("stop"); } catch (error) { failures.push(error); }
      }
      try { await invoke("native_input_stop"); } catch (error) { failures.push(error); }
      if (pending) {
        // The native confirmation may have completed after our first Stop.
        // Join it and issue another native Stop even if the first one failed.
        await pending.catch(() => {});
        try { await invoke("native_input_stop"); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw failures[0];
    });
    const settled = task.then(() => { hasStopFailure = false; stopFailure = undefined; }, error => {
      hasStopFailure = true; stopFailure = error; throw error;
    }).finally(() => { if (stopping === settled) stopping = undefined; });
    stopping = settled;
    return settled;
  }
  const hide = () => { void stop().catch(() => {}); };
  // The five-second selection intentionally asks the user to focus another app.
  // A visibility change during that pending selection has no held input to release.
  const visibility = () => { if (document.hidden && selection) hide(); };
  if (typeof window !== "undefined") window.addEventListener("pagehide", hide);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
  function close(): Promise<void> {
    if (disposed) return stopping ?? (hasStopFailure ? Promise.reject(stopFailure) : Promise.resolve());
    disposed = true;
    const settled = stop();
    runtime.close();
    if (typeof window !== "undefined") window.removeEventListener("pagehide", hide);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility);
    return settled;
  }
  return { select, startRoutes, publish, stop, close };
}
