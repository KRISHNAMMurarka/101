import type { InputAdapter, InputFrameListener } from "@101/input";
import {
  HardwareFrameEmitter,
  createHardwareDecoder,
  type HardwareCapabilityStatus,
  type HardwareDecoder,
  type HardwareReportMapping,
} from "@101/hardware";

export type BluetoothServiceUUID101 = string | number;
export interface BluetoothDeviceFilter101 { name?: string; namePrefix?: string; services?: BluetoothServiceUUID101[] }
export interface BluetoothValueEvent101 { target: BluetoothCharacteristic101 }
export interface BluetoothCharacteristic101 {
  value?: DataView;
  startNotifications(): Promise<BluetoothCharacteristic101>;
  stopNotifications(): Promise<BluetoothCharacteristic101>;
  writeValue?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  addEventListener(type: "characteristicvaluechanged", listener: EventListener): void;
  removeEventListener(type: "characteristicvaluechanged", listener: EventListener): void;
}
export interface BluetoothService101 { getCharacteristic(uuid: BluetoothServiceUUID101): Promise<BluetoothCharacteristic101> }
export interface BluetoothGATTServer101 { connected: boolean; connect(): Promise<BluetoothGATTServer101>; disconnect(): void; getPrimaryService(uuid: BluetoothServiceUUID101): Promise<BluetoothService101> }
export interface BluetoothDevice101 extends EventTarget { id: string; name?: string; gatt?: BluetoothGATTServer101 }
export interface BluetoothManager101 {
  requestDevice(options: { filters?: BluetoothDeviceFilter101[]; acceptAllDevices?: boolean; optionalServices?: BluetoothServiceUUID101[] }): Promise<BluetoothDevice101>;
  getDevices?(): Promise<BluetoothDevice101[]>;
}

export interface WebBluetoothAdapterOptions {
  playerId?: string;
  service: BluetoothServiceUUID101;
  characteristic: BluetoothServiceUUID101;
  filters?: BluetoothDeviceFilter101[];
  acceptAllDevices?: boolean;
  optionalServices?: BluetoothServiceUUID101[];
  mapping?: HardwareReportMapping;
  decoder?: HardwareDecoder;
  device?: BluetoothDevice101;
  manager?: BluetoothManager101;
  onStatus?(status: HardwareCapabilityStatus): void;
}

export class WebBluetoothAdapter implements InputAdapter {
  readonly id = "bluetooth-browser";
  readonly source = "bluetooth" as const;
  private readonly options: WebBluetoothAdapterOptions;
  private readonly decoder: HardwareDecoder;
  private readonly playerId: string;
  private manager?: BluetoothManager101;
  private device?: BluetoothDevice101;
  private characteristic?: BluetoothCharacteristic101;
  private emitter?: HardwareFrameEmitter;
  private emit?: InputFrameListener;
  private active = false;

  constructor(options: WebBluetoothAdapterOptions) {
    if ((!options.mapping && !options.decoder) || (options.mapping && options.decoder)) throw new Error("Web Bluetooth requires exactly one mapping or decoder");
    if (!options.acceptAllDevices && !options.filters?.length) throw new Error("Web Bluetooth requires filters or explicit acceptAllDevices");
    this.options = { ...options, filters: options.filters?.map(validateFilter), optionalServices: [...new Set([options.service, ...(options.optionalServices ?? [])])] };
    this.decoder = options.decoder ?? createHardwareDecoder(options.mapping!);
    this.playerId = options.playerId ?? "player-1";
    this.manager = options.manager;
    this.device = options.device;
  }

  get status(): HardwareCapabilityStatus {
    const supported = Boolean(this.manager ?? bluetoothManager());
    return { api: "bluetooth", supported, secureContext: secureContext(), permission: !supported ? "unsupported" : this.device ? "granted" : "prompt", connected: Boolean(this.device?.gatt?.connected), ...(this.device?.name ? { deviceLabel: this.device.name } : {}) };
  }

  async requestDevice() {
    const manager = this.manager ?? bluetoothManager();
    if (!manager) throw new Error("Web Bluetooth is unavailable in this browser");
    if (!secureContext()) throw new Error("Web Bluetooth requires a secure context");
    const device = await manager.requestDevice({
      ...(this.options.acceptAllDevices ? { acceptAllDevices: true } : { filters: this.options.filters }),
      optionalServices: this.options.optionalServices,
    });
    await this.attach(device);
    return device;
  }

  async start(emit: InputFrameListener) {
    this.emit = emit;
    this.active = true;
    this.manager ??= bluetoothManager();
    if (!this.device && this.manager?.getDevices) {
      const granted = await this.manager.getDevices();
      this.device = granted.find((device) => this.matches(device));
    }
    if (this.device) await this.attach(this.device);
    this.report();
  }

  async stop() {
    this.active = false;
    const characteristic = this.characteristic;
    characteristic?.removeEventListener("characteristicvaluechanged", this.onValue);
    this.device?.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
    if (characteristic) { try { await characteristic.stopNotifications(); } catch { /* Device may already be gone. */ } }
    this.emit?.(this.emitter?.release() ?? releaseFrame(this.id, this.playerId));
    this.device?.gatt?.disconnect();
    this.characteristic = undefined;
    this.emitter = undefined;
    this.emit = undefined;
    this.report();
  }

  async write(bytes: BufferSource, withoutResponse = false) {
    const characteristic = this.characteristic;
    if (!characteristic) throw new Error("Bluetooth characteristic is not connected");
    if (withoutResponse && characteristic.writeValueWithoutResponse) return characteristic.writeValueWithoutResponse(bytes);
    if (characteristic.writeValue) return characteristic.writeValue(bytes);
    throw new Error("Bluetooth characteristic is not writable");
  }

  private async attach(device: BluetoothDevice101) {
    if (!device.gatt) throw new Error("Selected Bluetooth device has no GATT server");
    this.device = device;
    const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    const service = await server.getPrimaryService(this.options.service);
    const characteristic = await service.getCharacteristic(this.options.characteristic);
    if (this.characteristic && this.characteristic !== characteristic) this.characteristic.removeEventListener("characteristicvaluechanged", this.onValue);
    this.characteristic = characteristic;
    characteristic.removeEventListener("characteristicvaluechanged", this.onValue);
    characteristic.addEventListener("characteristicvaluechanged", this.onValue);
    await characteristic.startNotifications();
    device.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
    device.addEventListener("gattserverdisconnected", this.onGattDisconnected);
    this.emitter = new HardwareFrameEmitter(`bluetooth-${safeId(device.id)}`, this.playerId, this.source, this.decoder);
    this.report();
  }

  /** A device that walks out of range must never leave an action, axis or vector latched in the Input Bus. */
  private onGattDisconnected: EventListener = () => {
    this.characteristic?.removeEventListener("characteristicvaluechanged", this.onValue);
    this.device?.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
    this.emit?.(this.emitter?.release() ?? releaseFrame(this.id, this.playerId));
    this.characteristic = undefined;
    this.emitter = undefined;
    this.report();
  };

  private onValue: EventListener = (rawEvent) => {
    const event = rawEvent as unknown as BluetoothValueEvent101;
    if (!this.active || event.target !== this.characteristic || !event.target.value) return;
    const value = event.target.value;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const frame = this.emitter?.decode({ bytes, timestamp: performance.now() });
    if (frame) this.emit?.(frame);
  };

  private matches(device: BluetoothDevice101) {
    if (this.options.acceptAllDevices) return true;
    return this.options.filters?.some((filter) => (!filter.name || device.name === filter.name) && (!filter.namePrefix || device.name?.startsWith(filter.namePrefix))) ?? false;
  }

  private report(error?: unknown) { this.options.onStatus?.({ ...this.status, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }); }
}

function bluetoothManager(): BluetoothManager101 | undefined { return (navigator as Navigator & { bluetooth?: BluetoothManager101 }).bluetooth; }
function secureContext() { return typeof isSecureContext === "undefined" || isSecureContext; }
function safeId(value: string) { return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "device"; }
function validateFilter(filter: BluetoothDeviceFilter101) {
  if (!filter || (!filter.name && !filter.namePrefix && !filter.services?.length)) throw new Error("Empty Bluetooth filters are not allowed");
  if (filter.name && filter.name.length > 248 || filter.namePrefix && filter.namePrefix.length > 248) throw new Error("Bluetooth filter name is too long");
  return { ...filter, ...(filter.services ? { services: [...filter.services] } : {}) };
}
function releaseFrame(deviceId: string, playerId: string) { return { deviceId, playerId, sequence: Number.MAX_SAFE_INTEGER, timestamp: performance.now(), source: "bluetooth" as const, actions: {}, axes: {}, vectors: {} }; }
