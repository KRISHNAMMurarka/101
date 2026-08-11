import type { DeviceCapabilities } from "@101/protocol";

export interface ConnectedDevice {
  id: string;
  label: string;
  playerId: string;
  role?: string;
  capabilities: DeviceCapabilities;
  connectedAt: number;
}

export class LocalSession {
  readonly devices = new Map<string, ConnectedDevice>();

  constructor(
    readonly code: string = createSessionCode(),
    readonly createdAt = Date.now(),
  ) {}

  register(device: ConnectedDevice) {
    this.devices.set(device.id, device);
  }

  remove(deviceId: string) {
    this.devices.delete(deviceId);
  }

  compatibleDevices(capability: keyof DeviceCapabilities) {
    return [...this.devices.values()].filter(
      (device) => device.capabilities[capability] === true,
    );
  }
}

export function createSessionCode(random = Math.random) {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 6 }, () =>
    alphabet[Math.floor(random() * alphabet.length)],
  ).join("");
}
