import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { LocalSignalingBroker, type PairingDevice } from "@101/pairing";
import type { PairingTicket } from "@101/protocol";

export interface HubServerOptions {
  host?: string;
  port?: number;
  advertisedHost?: string;
  corsOrigin?: string;
  broker?: LocalSignalingBroker;
}

export interface CreatedHubSession {
  ticket: PairingTicket;
  hostToken: string;
}

export class LocalHubServer {
  private readonly options: HubServerOptions;
  private readonly broker: LocalSignalingBroker;
  private readonly sessions = new Map<string, CreatedHubSession>();
  private server?: Server;
  private endpoint?: string;

  constructor(options: HubServerOptions = {}) {
    this.options = options;
    this.broker = options.broker ?? new LocalSignalingBroker();
  }

  get url() {
    if (!this.endpoint) throw new Error("Start the 101 Hub server first");
    return this.endpoint;
  }

  async start() {
    if (this.server) return this.url;
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port ?? 10101, this.options.host ?? "0.0.0.0", () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("101 Hub did not bind a TCP port");
    const advertisedHost = this.options.advertisedHost ?? (this.options.host && this.options.host !== "0.0.0.0" ? this.options.host : "127.0.0.1");
    this.endpoint = `http://${formatHost(advertisedHost)}:${address.port}`;
    return this.endpoint;
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  createSession(sessionId: string, options: { hostName?: string; ttlMs?: number; endpoint?: string } = {}) {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.ticket.expiresAt > Date.now()) return existing;
    const created = this.broker.createSession({ sessionId, endpoint: options.endpoint ?? this.url, hostName: options.hostName, ttlMs: options.ttlMs });
    this.sessions.set(sessionId, created);
    return created;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    applyCors(response, this.options.corsOrigin ?? "*");
    if (request.method === "OPTIONS") return send(response, 204);
    try {
      const url = new URL(request.url ?? "/", this.endpoint ?? "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (request.method === "GET" && url.pathname === "/v1/health") return json(response, 200, { service: "101-hub", version: 1, endpoint: this.endpoint, addresses: localAddresses() });
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const body = await readJson<{ sessionId?: string; hostName?: string; ttlMs?: number; endpoint?: string }>(request);
        if (!body.sessionId) throw new HttpError(400, "sessionId is required");
        return json(response, 201, this.createSession(body.sessionId, body));
      }
      if (parts[0] !== "v1" || parts[1] !== "sessions" || !parts[2]) throw new HttpError(404, "Not found");
      const sessionId = parts[2];
      const token = bearer(request);

      if (parts[3] === "host") {
        if (request.method === "GET" && parts[4] === "peers" && parts.length === 5) return json(response, 200, this.broker.listPeers(sessionId, token));
        if (request.method === "PUT" && parts[4] === "peers" && parts[5] && parts[6] === "offer") {
          const body = await readJson<{ generation?: number; offer?: string }>(request);
          if (!Number.isInteger(body.generation) || !body.offer) throw new HttpError(400, "Invalid offer");
          this.broker.publishOffer(sessionId, token, parts[5], Number(body.generation), body.offer);
          return send(response, 204);
        }
        if (request.method === "POST" && parts[4] === "peers" && parts[5] && parts[6] === "reconnect") {
          this.broker.requestReconnect(sessionId, parts[5], token, true);
          return send(response, 204);
        }
      }

      if (request.method === "POST" && parts[3] === "peers" && parts.length === 4) {
        const session = this.sessions.get(sessionId);
        if (!session) throw new HttpError(404, "Unknown session");
        return json(response, 201, this.broker.join(session.ticket, token, await readJson<PairingDevice>(request)));
      }
      if (parts[3] === "peers" && parts[4]) {
        const peerId = parts[4];
        if (request.method === "GET" && parts[5] === "offer") return json(response, 200, this.broker.getOffer(sessionId, peerId, token));
        if (request.method === "PUT" && parts[5] === "answer") {
          const body = await readJson<{ generation?: number; answer?: string }>(request);
          if (!Number.isInteger(body.generation) || !body.answer) throw new HttpError(400, "Invalid answer");
          this.broker.publishAnswer(sessionId, peerId, token, Number(body.generation), body.answer);
          return send(response, 204);
        }
        if (request.method === "POST" && parts[5] === "reconnect") return json(response, 200, this.broker.requestReconnect(sessionId, peerId, token));
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : error instanceof Error && /authorization/i.test(error.message) ? 401 : 400;
      json(response, status, { error: error instanceof Error ? error.message : "Invalid request" });
    }
  }
}

export { createHttpSignalingSession as createRemoteHubSession } from "@101/pairing";

export function localAddresses() {
  const addresses: string[] = [];
  for (const interfaces of Object.values(networkInterfaces())) for (const address of interfaces ?? []) if (!address.internal && address.family === "IPv4") addresses.push(address.address);
  return addresses.sort();
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function bearer(request: IncomingMessage) {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length > 300) throw new HttpError(401, "Pairing authorization failed");
  return value.slice(7);
}

async function readJson<Value>(request: IncomingMessage): Promise<Value> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 500_000) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Value;
}

function json(response: ServerResponse, status: number, value: unknown) { response.statusCode = status; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify(value)); }
function send(response: ServerResponse, status: number) { response.statusCode = status; response.end(); }
function applyCors(response: ServerResponse, origin: string) {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
}
function formatHost(host: string) { return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host; }
