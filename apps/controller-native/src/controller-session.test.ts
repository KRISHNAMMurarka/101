import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";
import { LocalHubServer } from "../../../packages/hub-server/src/index.ts";
import { LocalSignalingBroker } from "@101/pairing";
import { encodePairingTicket, type StatefulLinkTransport } from "@101/protocol";
import type { ControllerSessionEvents } from "./controller-session.ts";

// Load the actual session class; only the unavailable Expo/RTC platform ports are replaced.
// Real HTTP requests, ticket codec, SignaledLinkTransport and Hub execute unchanged.
const portKey = "101.controller-session-lifecycle-test";
const ports = { fetch: globalThis.fetch, factories: 0 };
Reflect.set(globalThis, Symbol.for(portKey), ports);
const sourceUrl = new URL("./controller-session.ts", import.meta.url).href;
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === sourceUrl) {
      if (specifier === "expo/fetch") return { shortCircuit: true, url: moduleUrl(`const port = globalThis[Symbol.for('${portKey}')]; export const fetch = (...args) => port.fetch(...args);`) };
      if (specifier === "./native-webrtc") return { shortCircuit: true, url: moduleUrl(`const port = globalThis[Symbol.for('${portKey}')]; export class NativeWebRTCTransport { constructor() { port.factories++; throw Error('No native RTC factory is expected in these lifecycle checks'); } }`) };
      if (specifier.startsWith(".")) return { shortCircuit: true, url: new URL(`${specifier}.ts`, sourceUrl).href };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === sourceUrl) return { shortCircuit: true, format: "module", source: ts.transpileModule(readFileSync(new URL(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
    return next(url, context);
  },
});
const { ControllerSession } = await import("./controller-session.ts");
const events: ControllerSessionEvents = {
  state() {}, layout() {}, assignment() {}, hostState() {}, haptic() {}, speakerCue() {},
  speakerDiscard() {}, speakerCancel() {}, speakerReset() {}, calibration() {}, latency() {}, error() {},
};
async function fixture() {
  const broker = new LocalSignalingBroker();
  const hub = new LocalHubServer({ broker, host: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0 });
  await hub.start();
  const first = hub.createSession("CANCEL-A101");
  const second = hub.createSession("CANCEL-B101");
  const session = new ControllerSession("lifecycle-controller", "Lifecycle", events);
  const transports = new Set<StatefulLinkTransport>();
  const attach = Reflect.get(session, "attachTransport") as (transport: StatefulLinkTransport, revision?: number) => void;
  Reflect.set(session, "attachTransport", function(transport: StatefulLinkTransport, revision?: number) {
    transports.add(transport);
    return attach.call(session, transport, revision);
  });
  const requests: Array<{ method: string; url: string }> = [];
  ports.factories = 0;
  ports.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", url: String(input) });
    return fetch(input, init);
  }) as typeof fetch;
  return { broker, hub, first, second, session, transports, requests, async close() { await session.disconnect(); await Promise.all([...transports].map(transport => transport.disconnect())); await hub.stop(); ports.fetch = globalThis.fetch; } };
}

test("native Cancel before session setup prevents a real Hub join and permits a later connection", async () => {
  const f = await fixture();
  try {
    const pending = f.session.connect(encodePairingTicket(f.first.ticket));
    const observed = pending.then(() => "connected", () => "cancelled");
    await f.session.disconnect();
    assert.equal(await observed, "cancelled");
    assert.equal(f.requests.length, 0, "cancelled setup must remain inert");
    await f.session.connect(encodePairingTicket(f.second.ticket));
    assert.equal(f.broker.listPeers(f.second.ticket.sessionId, f.second.hostToken).length, 1);
    assert.equal(ports.factories, 0, "null Hub offer keeps native RTC dormant");
  } finally { await f.close(); }
});

test("a replacement connection cannot let the earlier setup dispatch to its old Hub session", async () => {
  const f = await fixture();
  try {
    const first = f.session.connect(encodePairingTicket(f.first.ticket));
    const old = first.then(() => "connected", () => "cancelled");
    await f.session.connect(encodePairingTicket(f.second.ticket));
    assert.equal(await old, "cancelled");
    assert.equal(f.requests.some(request => request.url.includes("/CANCEL-A101/")), false);
    assert.equal(f.broker.listPeers(f.first.ticket.sessionId, f.first.hostToken).length, 0);
    assert.equal(f.broker.listPeers(f.second.ticket.sessionId, f.second.hostToken).length, 1);
  } finally { await f.close(); }
});

test("Cancel before manual setup does not allocate a native RTC transport", async () => {
  const f = await fixture();
  try {
    const pending = f.session.connectManual("101C2-unused-after-cancel");
    const observed = pending.then(() => "connected", () => "cancelled");
    await f.session.disconnect();
    assert.equal(await observed, "cancelled");
    assert.equal(ports.factories, 0);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("a delayed old Hub leave cannot erase the replacement transport or leak its live lease", async () => {
  const f = await fixture();
  let release!: () => void;
  let started!: () => void;
  const leaving = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetcher = ports.fetch;
  ports.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetcher(input, init);
    if (init?.method === "DELETE" && String(input).includes("/CANCEL-A101/")) { started(); await held; }
    return response;
  }) as typeof fetch;
  try {
    await f.session.connect(encodePairingTicket(f.first.ticket));
    const oldCleanup = f.session.disconnect();
    await leaving;
    await f.session.connect(encodePairingTicket(f.second.ticket));
    release();
    await oldCleanup;
    await f.session.disconnect();
    assert.equal(f.broker.listPeers(f.second.ticket.sessionId, f.second.hostToken).length, 0, "replacement still owns a transport that can release its lease");
  } finally { release(); await f.close(); }
});

test("a state callback cancellation before dispatch prevents a real Hub join", async () => {
  const f = await fixture(); let canceled = false;
  Reflect.set(f.session, 'events', {...events, state(state: string) {
    if (state === 'idle' && !canceled) { canceled = true; void f.session.disconnect(); }
  }});
  try {
    await assert.rejects(() => f.session.connect(encodePairingTicket(f.first.ticket)));
    console.log(JSON.stringify({case:'state callback cancellation',requests:f.requests}));
    assert.equal(f.requests.length,0,'cancellation in the synchronous initial state callback must prevent dispatch');
  } finally {await f.close();}
});


test("synchronous attachment cancellation retires its returned unsubscribe handles", async () => {
  const f = await fixture();
  let cancelled = false;
  Reflect.set(f.session, "events", { ...events, state(state: string) {
    if (state === "idle" && !cancelled) { cancelled = true; void f.session.disconnect(); }
  } });
  try {
    await assert.rejects(() => f.session.connect(encodePairingTicket(f.first.ticket)));
    assert.equal(Reflect.get(f.session, "removeState"), undefined);
    assert.equal(Reflect.get(f.session, "removeMessage"), undefined);
    for (const transport of f.transports) {
      assert.equal((Reflect.get(transport, "stateListeners") as Set<unknown>).size, 0);
      assert.equal((Reflect.get(transport, "listeners") as Set<unknown>).size, 0);
    }
  } finally { await f.close(); }
});

test("replacement during initial state attachment preserves only the new session authority", async () => {
  const f = await fixture();
  let replacement: Promise<unknown> | undefined;
  Reflect.set(f.session, "events", { ...events, state(state: string) {
    if (state === "idle" && !replacement) replacement = f.session.connect(encodePairingTicket(f.second.ticket));
  } });
  try {
    await assert.rejects(() => f.session.connect(encodePairingTicket(f.first.ticket)));
    await replacement;
    assert.equal(f.requests.some(request => request.url.includes("/CANCEL-A101/")), false);
    assert.equal(f.broker.listPeers(f.second.ticket.sessionId, f.second.hostToken).length, 1);
    await f.session.disconnect();
    assert.equal(f.broker.listPeers(f.second.ticket.sessionId, f.second.hostToken).length, 0);
  } finally { await f.close(); }
});

test("a connecting state callback cancellation prevents the subsequent signaling dispatch", async () => {
  const f = await fixture();
  let cancelled = false;
  Reflect.set(f.session, "events", { ...events, state(state: string) {
    if (state === "connecting" && !cancelled) { cancelled = true; void f.session.disconnect(); }
  } });
  try {
    await assert.rejects(() => f.session.connect(encodePairingTicket(f.first.ticket)));
    assert.equal(f.requests.length, 0, "a pre-join callback cannot dispatch after cancelling the connection");
    assert.equal(f.broker.listPeers(f.first.ticket.sessionId, f.first.hostToken).length, 0);
  } finally { await f.close(); }
});
