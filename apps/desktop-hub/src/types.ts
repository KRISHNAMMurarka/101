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
  bytes: number;
}

export interface InstalledGame {
  id: string;
  name: string;
  version: string;
  renderer: string;
  path: string;
}
