import assert from "node:assert/strict";
import test from "node:test";
import { HttpControllerSignalingClient, HttpHostSignalingClient } from "@101/pairing";
import { BrowserHostTransport } from "../../../app/lib/browser-link.ts";
import { LocalHubServer, createRemoteHubSession } from "./index.ts";

test("serves the authenticated signaling contract over a real local HTTP socket", async () => {
  const server = new LocalHubServer({ host: "127.0.0.1", port: 0 });
  const endpoint = await server.start();
  try {
    const health = await fetch(`${endpoint}/v1/health`).then((response) => response.json()) as { service: string };
    assert.equal(health.service, "101-hub");
    const created = await createRemoteHubSession(endpoint, "HTTP101", { hostName: "Test Host" });
    const controller = new HttpControllerSignalingClient(created.ticket);
    const host = new HttpHostSignalingClient(endpoint, "HTTP101", created.hostToken);
    const lease = await controller.join({ deviceId: "phone-http", label: "HTTP Phone", capabilities: { touch: true } });
    assert.equal((await host.listPeers())[0]?.deviceId, "phone-http");
    await host.publishOffer(lease.peerId, lease.generation, "101-offer-http");
    assert.equal((await controller.getOffer(lease)).offer, "101-offer-http");
    await controller.publishAnswer(lease, lease.generation, "101-answer-http");
    assert.equal((await host.listPeers())[0]?.answer, "101-answer-http");
    await controller.leave(lease);
    assert.deepEqual(await host.listPeers(), []);
    await assert.rejects(() => new HttpHostSignalingClient(endpoint, "HTTP101", "x".repeat(32)).listPeers(), /401/);
  } finally {
    await server.stop();
  }
});

test("does not reveal existing session authority to a repeated unauthenticated create", async () => {
  const server = new LocalHubServer({ host: "127.0.0.1", port: 0 });
  const endpoint = await server.start();
  try {
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "REPEAT101", hostName: "Original Host" }),
    } as const;
    const initialResponse = await fetch(`${endpoint}/v1/sessions`, request);
    assert.equal(initialResponse.status, 201);
    const initial = await initialResponse.json() as { hostToken: string; ticket: { joinToken: string } };

    const repeatedResponse = await fetch(`${endpoint}/v1/sessions`, request);
    assert.equal(repeatedResponse.status, 409);
    const repeated = await repeatedResponse.json() as Record<string, unknown>;
    const serialized = JSON.stringify(repeated);
    assert.equal("hostToken" in repeated, false);
    assert.equal(serialized.includes(initial.hostToken), false);
    assert.equal(serialized.includes(initial.ticket.joinToken), false);

    const resumed = await createRemoteHubSession(endpoint, "REPEAT101", {
      hostName: "Reloaded Host",
      hostToken: initial.hostToken,
    });
    assert.notEqual(resumed.hostToken, initial.hostToken);
    assert.equal(resumed.ticket.joinToken, initial.ticket.joinToken);
    await assert.rejects(
      () => new HttpHostSignalingClient(endpoint, "REPEAT101", initial.hostToken).listPeers(),
      /401/,
    );
    assert.deepEqual(
      await new HttpHostSignalingClient(endpoint, "REPEAT101", resumed.hostToken).listPeers(),
      [],
    );
  } finally {
    await server.stop();
  }
});

test("browser host reload resumes with stored authority while unauthenticated callers stay locked out", async () => {
  const server = new LocalHubServer({ host: "127.0.0.1", port: 0 });
  const endpoint = await server.start();
  const storage = memoryStorage();
  const saved = ["window", "document", "localStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let first: BrowserHostTransport | undefined;
  let reloaded: BrowserHostTransport | undefined;
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: endpoint, search: `?hub=${encodeURIComponent(endpoint)}` },
        localStorage: storage,
      },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { title: "Reload Test" } });

    first = new BrowserHostTransport("RELOAD101");
    const initial = await first.preparePairing();
    const initialAuthority = storedHostToken(storage);
    assert.ok(initialAuthority);
    await closeBrowserHost(first);
    first = undefined;

    const unauthenticated = await fetch(`${endpoint}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "RELOAD101" }),
    });
    assert.equal(unauthenticated.status, 409);
    const deniedBody = JSON.stringify(await unauthenticated.json());
    assert.equal(deniedBody.includes(initialAuthority), false);
    assert.equal(deniedBody.includes(initial.ticket.joinToken), false);

    reloaded = new BrowserHostTransport("RELOAD101");
    const resumed = await reloaded.preparePairing();
    const rotatedAuthority = storedHostToken(storage);
    assert.ok(rotatedAuthority);
    assert.notEqual(rotatedAuthority, initialAuthority);
    assert.equal(resumed.ticket.joinToken, initial.ticket.joinToken);
    await assert.rejects(
      () => new HttpHostSignalingClient(endpoint, "RELOAD101", initialAuthority).listPeers(),
      /401/,
    );
    assert.deepEqual(
      await new HttpHostSignalingClient(endpoint, "RELOAD101", rotatedAuthority).listPeers(),
      [],
    );
  } finally {
    if (first) await closeBrowserHost(first);
    if (reloaded) await closeBrowserHost(reloaded);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
    await server.stop();
  }
});

test("desktop launcher fragment hands session authority to the browser exactly once", async () => {
  const server = new LocalHubServer({ host: "127.0.0.1", port: 0 });
  const endpoint = await server.start();
  const desktopCreated = await createRemoteHubSession(endpoint, "DESKTOP101", { hostName: "Desktop Hub" });
  const storage = memoryStorage();
  const saved = ["window", "document", "localStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const search = `?session=DESKTOP101&hub=${encodeURIComponent(endpoint)}`;
  const location = {
    origin: endpoint,
    pathname: "/",
    search,
    hash: `#101-host-session=DESKTOP101&101-host-token=${desktopCreated.hostToken}&101-host-hub=${encodeURIComponent(endpoint)}`,
  };
  let replacedUrl = "";
  let host: BrowserHostTransport | undefined;
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location,
        localStorage: storage,
        history: {
          state: null,
          replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
            replacedUrl = String(url ?? "");
            location.hash = "";
          },
        },
      },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { title: "Desktop Handoff" } });

    host = new BrowserHostTransport("DESKTOP101");
    assert.equal(location.hash, "", "the bearer fragment must be erased before session networking");
    assert.equal(replacedUrl, `/${search}`);
    const claimedAuthority = await waitForStoredHostToken(storage);
    assert.notEqual(claimedAuthority, desktopCreated.hostToken,
      "the fragment authority must rotate into origin-local storage without waiting for game launch");
    const resumed = await host.preparePairing();
    const rotatedAuthority = storedHostToken(storage);
    assert.ok(rotatedAuthority);
    assert.notEqual(rotatedAuthority, desktopCreated.hostToken);
    assert.notEqual(rotatedAuthority, claimedAuthority);
    assert.equal(resumed.ticket.joinToken, desktopCreated.ticket.joinToken);
    assert.equal(resumed.controllerUrl.includes(desktopCreated.hostToken), false, "host authority must never enter the controller QR URL");
    await assert.rejects(
      () => new HttpHostSignalingClient(endpoint, "DESKTOP101", desktopCreated.hostToken).listPeers(),
      /401/,
    );
    assert.deepEqual(
      await new HttpHostSignalingClient(endpoint, "DESKTOP101", rotatedAuthority).listPeers(),
      [],
    );

    await closeBrowserHost(host);
    host = undefined;
    location.hash = `#101-host-session=DESKTOP101&101-host-token=${desktopCreated.hostToken}&101-host-hub=${encodeURIComponent(endpoint)}`;
    host = new BrowserHostTransport("DESKTOP101");
    const reopened = await host.preparePairing();
    assert.equal(reopened.ticket.sessionId, "DESKTOP101");
    assert.notEqual(storedHostToken(storage), rotatedAuthority,
      "reopening the one-time Desktop URL must fall back to the browser's rotated authority");
  } finally {
    if (host) await closeBrowserHost(host);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
    await server.stop();
  }
});

test("browser rejects a desktop authority fragment bound to another session", async () => {
  const server = new LocalHubServer({ host: "127.0.0.1", port: 0 });
  const endpoint = await server.start();
  const desktopCreated = await createRemoteHubSession(endpoint, "BOUND101");
  const storage = memoryStorage();
  const saved = ["window", "document", "localStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const search = `?session=BOUND101&hub=${encodeURIComponent(endpoint)}`;
  const location = {
    origin: endpoint,
    pathname: "/",
    search,
    hash: `#101-host-session=OTHER101&101-host-token=${desktopCreated.hostToken}&101-host-hub=${encodeURIComponent(endpoint)}`,
  };
  let host: BrowserHostTransport | undefined;
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location,
        localStorage: storage,
        history: { state: null, replaceState() { location.hash = ""; } },
      },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { title: "Bound Handoff" } });

    host = new BrowserHostTransport("BOUND101");
    assert.equal(location.hash, "");
    await assert.rejects(() => host!.preparePairing(), /409/);
    assert.equal(storedHostToken(storage), undefined);
    assert.deepEqual(
      await new HttpHostSignalingClient(endpoint, "BOUND101", desktopCreated.hostToken).listPeers(),
      [],
      "a mismatched fragment must not rotate the real session authority",
    );
  } finally {
    if (host) await closeBrowserHost(host);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
    await server.stop();
  }
});

test("desktop authority survives a failed immediate claim and transient health failure", async () => {
  const server = new LocalHubServer({ host: "127.0.0.1", port: 0 });
  const endpoint = await server.start();
  const desktopCreated = await createRemoteHubSession(endpoint, "RETRY101");
  const storage = memoryStorage();
  const saved = ["window", "document", "localStorage", "fetch"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const search = `?session=RETRY101&hub=${encodeURIComponent(endpoint)}`;
  const location = {
    origin: endpoint,
    pathname: "/",
    search,
    hash: `#101-host-session=RETRY101&101-host-token=${desktopCreated.hostToken}&101-host-hub=${encodeURIComponent(endpoint)}`,
  };
  const realFetch = globalThis.fetch;
  let rejectClaimOnce = true;
  let rejectHealthOnce = true;
  let host: BrowserHostTransport | undefined;
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location,
        localStorage: storage,
        history: { state: null, replaceState() { location.hash = ""; } },
      },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { title: "Retry Handoff" } });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (rejectClaimOnce && url === `${endpoint}/v1/sessions` && init?.method === "POST") {
          rejectClaimOnce = false;
          return Promise.reject(new TypeError("temporary handoff failure"));
        }
        if (rejectHealthOnce && url === `${endpoint}/v1/health`) {
          rejectHealthOnce = false;
          return Promise.resolve(new Response(JSON.stringify({ error: "not ready" }), { status: 503 }));
        }
        return realFetch(input, init);
      }) satisfies typeof fetch,
    });

    host = new BrowserHostTransport("RETRY101");
    await assert.rejects(() => host!.preparePairing(), /503/);
    assert.equal(storedHostToken(storage), undefined,
      "a failed claim must retain authority in memory rather than persist the unrotated token");

    const resumed = await host.preparePairing();
    assert.equal(resumed.ticket.sessionId, "RETRY101");
    assert.notEqual(storedHostToken(storage), desktopCreated.hostToken);
  } finally {
    if (host) await closeBrowserHost(host);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
    await server.stop();
  }
});

test("browser host connect cannot be disconnected by an in-flight delayed close", async () => {
  const host = new BrowserHostTransport("CLOSE101");
  await host.connect();
  let signalStopStarted!: () => void;
  let releaseStop!: () => void;
  const stopStarted = new Promise<void>((resolve) => { signalStopStarted = resolve; });
  const stopped = new Promise<void>((resolve) => { releaseStop = resolve; });
  let restarts = 0;
  const internals = host as unknown as {
    automatic?: { start(): Promise<void>; stop(): Promise<void> };
    closeIfUnused(): Promise<void>;
    connected: boolean;
    leaseCount: number;
  };
  internals.leaseCount = 0;
  internals.automatic = {
    async start() { restarts += 1; },
    async stop() { signalStopStarted(); await stopped; },
  };

  const closing = internals.closeIfUnused();
  await stopStarted;
  const connecting = host.connect();
  releaseStop();
  await Promise.all([closing, connecting]);
  try {
    assert.equal(internals.connected, true);
    assert.equal(restarts, 1, "the remote pairing host must restart when a lease arrives during close");
  } finally {
    internals.leaseCount = 0;
    internals.automatic = undefined;
    await internals.closeIfUnused();
  }
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key: string) { return values.get(key) ?? null; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    removeItem(key: string) { values.delete(key); },
    setItem(key: string, value: string) { values.set(key, value); },
  } satisfies Storage;
}

function storedHostToken(storage: Storage) {
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith("101.hub.host.")) continue;
    const value = JSON.parse(storage.getItem(key) ?? "null") as { hostToken?: string } | null;
    if (value?.hostToken) return value.hostToken;
  }
  return undefined;
}

async function closeBrowserHost(host: BrowserHostTransport) {
  await (host as unknown as { closeIfUnused(): Promise<void> }).closeIfUnused();
}

async function waitForStoredHostToken(storage: Storage) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const hostToken = storedHostToken(storage);
    if (hostToken) return hostToken;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Desktop host authority was not claimed into browser storage");
}
