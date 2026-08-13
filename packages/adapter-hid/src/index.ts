import type { InputAdapter, InputFrameListener } from "@101/input";
import {
  HardwareFrameEmitter,
  createHardwareDecoder,
  type HardwareCapabilityStatus,
  type HardwareDecoder,
  type HardwareReportMapping,
} from "@101/hardware";

export interface HIDDeviceFilter101 { vendorId?: number; productId?: number; usagePage?: number; usage?: number }
export interface HIDInputReportEvent101 { device: HIDDevice101; reportId: number; data: DataView }
export interface HIDDevice101 {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(type: "inputreport", listener: EventListener): void;
  removeEventListener(type: "inputreport", listener: EventListener): void;
}
export interface HIDConnectionEvent101 { device: HIDDevice101 }
export interface HIDManager101 {
  getDevices(): Promise<HIDDevice101[]>;
  requestDevice(options: { filters: HIDDeviceFilter101[] }): Promise<HIDDevice101[]>;
  addEventListener?(type: "disconnect", listener: EventListener): void;
  removeEventListener?(type: "disconnect", listener: EventListener): void;
}

export interface WebHIDAdapterOptions {
  playerId?: string;
  filters: HIDDeviceFilter101[];
  mapping?: HardwareReportMapping;
  decoder?: HardwareDecoder;
  device?: HIDDevice101;
  manager?: HIDManager101;
  onStatus?(status: HardwareCapabilityStatus): void;
}

export class WebHIDAdapter implements InputAdapter {
  readonly id = "hid-browser";
  readonly source = "hid" as const;
  private readonly playerId: string;
  private readonly filters: HIDDeviceFilter101[];
  private readonly decoder: HardwareDecoder;
  private readonly onStatus?: (status: HardwareCapabilityStatus) => void;
  private manager?: HIDManager101;
  private device?: HIDDevice101;
  private emitter?: HardwareFrameEmitter;
  private emit?: InputFrameListener;
  private active = false;

  constructor(options: WebHIDAdapterOptions) {
    if ((!options.mapping && !options.decoder) || (options.mapping && options.decoder)) throw new Error("WebHID requires exactly one mapping or decoder");
    this.playerId = options.playerId ?? "player-1";
    this.filters = options.filters.map(validateFilter);
    if (this.filters.length === 0) throw new Error("WebHID requires at least one explicit device filter");
    this.decoder = options.decoder ?? createHardwareDecoder(options.mapping!);
    this.device = options.device;
    this.manager = options.manager;
    this.onStatus = options.onStatus;
  }

  get status(): HardwareCapabilityStatus {
    const supported = Boolean(this.manager ?? hidManager());
    return { api: "hid", supported, secureContext: secureContext(), permission: !supported ? "unsupported" : this.device ? "granted" : "prompt", connected: Boolean(this.device?.opened), ...(this.device?.productName ? { deviceLabel: this.device.productName } : {}) };
  }

  async requestDevice() {
    const manager = this.manager ?? hidManager();
    if (!manager) throw new Error("WebHID is unavailable in this browser");
    if (!secureContext()) throw new Error("WebHID requires a secure context");
    const [device] = await manager.requestDevice({ filters: this.filters });
    if (!device) throw new Error("No HID device was selected");
    await this.attach(device);
    return device;
  }

  async start(emit: InputFrameListener) {
    this.emit = emit;
    this.active = true;
    this.manager ??= hidManager();
    if (!this.device && this.manager) {
      const granted = await this.manager.getDevices();
      this.device = granted.find((device) => this.filters.some((filter) => matches(device, filter)));
    }
    if (this.device) await this.attach(this.device);
    this.report();
  }

  async stop() {
    this.active = false;
    const device = this.device;
    if (device) device.removeEventListener("inputreport", this.onInputReport);
    this.manager?.removeEventListener?.("disconnect", this.onDeviceDisconnected);
    this.emit?.(this.emitter?.release() ?? releaseFrame(this.id, this.playerId));
    this.emitter = undefined;
    this.emit = undefined;
    if (device?.opened) await device.close();
    this.report();
  }

  async sendReport(reportId: number, data: BufferSource) {
    if (!this.device?.opened) throw new Error("HID device is not connected");
    if (!Number.isInteger(reportId) || reportId < 0 || reportId > 255) throw new Error("HID reportId must be an unsigned byte");
    await this.device.sendReport(reportId, data);
  }

  private async attach(device: HIDDevice101) {
    if (this.device && this.device !== device) this.device.removeEventListener("inputreport", this.onInputReport);
    this.device = device;
    if (!device.opened) await device.open();
    device.removeEventListener("inputreport", this.onInputReport);
    device.addEventListener("inputreport", this.onInputReport);
    this.manager?.removeEventListener?.("disconnect", this.onDeviceDisconnected);
    this.manager?.addEventListener?.("disconnect", this.onDeviceDisconnected);
    this.emitter = new HardwareFrameEmitter(deviceId(device), this.playerId, this.source, this.decoder);
    this.report();
  }

  /** An unplugged device must never leave an action, axis or vector latched in the Input Bus. */
  private onDeviceDisconnected: EventListener = (rawEvent) => {
    const event = rawEvent as unknown as HIDConnectionEvent101;
    if (!this.device || event.device !== this.device) return;
    this.releaseDevice();
  };

  private releaseDevice() {
    const device = this.device;
    device?.removeEventListener("inputreport", this.onInputReport);
    this.manager?.removeEventListener?.("disconnect", this.onDeviceDisconnected);
    this.emit?.(this.emitter?.release() ?? releaseFrame(this.id, this.playerId));
    this.emitter = undefined;
    this.device = undefined;
    this.report();
  }

  private onInputReport: EventListener = (rawEvent) => {
    const event = rawEvent as unknown as HIDInputReportEvent101;
    if (!this.active || event.device !== this.device) return;
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const frame = this.emitter?.decode({ bytes, reportId: event.reportId, timestamp: performance.now() });
    if (frame) this.emit?.(frame);
  };

  private report(error?: unknown) { this.onStatus?.({ ...this.status, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }); }
}

function hidManager(): HIDManager101 | undefined { return (navigator as Navigator & { hid?: HIDManager101 }).hid; }
function secureContext() { return typeof isSecureContext === "undefined" || isSecureContext; }
function deviceId(device: HIDDevice101) { return `hid-${hex(device.vendorId)}-${hex(device.productId)}-${safeId(device.productName)}`; }
function safeId(value: string) { return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "device"; }
function hex(value: number) { return Math.max(0, value).toString(16).padStart(4, "0"); }
function matches(device: HIDDevice101, filter: HIDDeviceFilter101) { return (filter.vendorId === undefined || filter.vendorId === device.vendorId) && (filter.productId === undefined || filter.productId === device.productId); }
function validateFilter(filter: HIDDeviceFilter101) {
  if (!filter || Object.values(filter).every((value) => value === undefined)) throw new Error("Empty HID filters are not allowed");
  for (const value of Object.values(filter)) if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 65_535)) throw new Error("Invalid HID filter");
  return { ...filter };
}
function releaseFrame(deviceIdValue: string, playerId: string) { return { deviceId: deviceIdValue, playerId, sequence: Number.MAX_SAFE_INTEGER, timestamp: performance.now(), source: "hid" as const, actions: {}, axes: {}, vectors: {} }; }
