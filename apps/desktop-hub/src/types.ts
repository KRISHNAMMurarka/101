export interface HubStatus {
  running: boolean;
  endpoint: string;
  addresses: string[];
  mdns: boolean;
  sessionCount: number;
  peerCount: number;
  dataDirectory: string;
  launcherUrl: string;
}

export interface HubSettings {
  port: number;
  advertiseMdns: boolean;
  launcherUrl: string;
  hostName: string;
}

export interface PairingTicket {
  version: 2;
  sessionId: string;
  endpoint: string;
  joinToken: string;
  expiresAt: number;
  hostName?: string;
  transport: "webrtc";
}

export interface CreatedSession {
  ticket: PairingTicket;
  hostToken: string;
}

export interface StoredReplay {
  id: string;
  gameId: string;
  gameVersion: string;
  seed: string;
  savedAt: number;
  expiresAt: number;
  generation: string;
  bytes: number;
}

export interface InstalledGame {
  id: string;
  name: string;
  version: string;
  renderer: string;
  path: string;
}

export interface ReplayCatalog {
  profile: "desktop-local-replay-retention/1";
  revision: number;
  limits: { retentionMs: number; perReplayBytes: number; aggregateBytes: number; liveReplays: number };
  totalBytes: number;
  records: StoredReplay[];
  state: "ready" | "legacy-review";
  pendingCleanup: number;
}

export interface ReplayDeletion {
  state: "deleted" | "not-found" | "conflict" | "cleanup-pending" | "unavailable";
  removedCount: number;
  removedBytes: number;
}
