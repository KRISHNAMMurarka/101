import type { InputAdapter, InputFrameListener } from "@101/input";
import {
  DelimitedByteFramer,
  HardwareFrameEmitter,
  createHardwareDecoder,
  type HardwareByteFramer,
  type HardwareCapabilityStatus,
  type HardwareDecoder,
  type HardwareReportMapping,
} from "@101/hardware";

export interface SerialPortFilter101 { usbVendorId?: number; usbProductId?: number; bluetoothServiceClassId?: string }
export interface SerialPortInfo101 { usbVendorId?: number; usbProductId?: number; bluetoothServiceClassId?: string }
export interface SerialPort101 {
  connected?: boolean;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfo101;
  open(options: SerialOpenOptions101): Promise<void>;
  close(): Promise<void>;
}
export interface SerialManager101 { getPorts(): Promise<SerialPort101[]>; requestPort(options?: { filters?: SerialPortFilter101[] }): Promise<SerialPort101> }
export interface SerialOpenOptions101 { baudRate: number; dataBits?: 7 | 8; stopBits?: 1 | 2; parity?: "none" | "even" | "odd"; bufferSize?: number; flowControl?: "none" | "hardware" }

export interface WebSerialAdapterOptions {
  playerId?: string;
  filters?: SerialPortFilter101[];
  open: SerialOpenOptions101;
  mapping?: HardwareReportMapping;
  decoder?: HardwareDecoder;
  framer?: HardwareByteFramer;
  port?: SerialPort101;
  manager?: SerialManager101;
  onStatus?(status: HardwareCapabilityStatus): void;
}

export class WebSerialAdapter implements InputAdapter {
  readonly id = "serial-browser";
  readonly source = "serial" as const;
  private readonly options: WebSerialAdapterOptions;
  private readonly decoder: HardwareDecoder;
  private readonly playerId: string;
  private readonly framer: HardwareByteFramer;
  private manager?: SerialManager101;
  private port?: SerialPort101;
  private emitter?: HardwareFrameEmitter;
  private emit?: InputFrameListener;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private readTask?: Promise<void>;
  private active = false;

  constructor(options: WebSerialAdapterOptions) {
    if ((!options.mapping && !options.decoder) || (options.mapping && options.decoder)) throw new Error("Web Serial requires exactly one mapping or decoder");
    validateOpenOptions(options.open);
    this.options = { ...options, filters: options.filters?.map(validateFilter), open: { ...options.open } };
    this.decoder = options.decoder ?? createHardwareDecoder(options.mapping!);
    this.playerId = options.playerId ?? "player-1";
    this.framer = options.framer ?? new DelimitedByteFramer();
    this.manager = options.manager;
    this.port = options.port;
  }

  get status(): HardwareCapabilityStatus {
    const supported = Boolean(this.manager ?? serialManager());
    const info = this.port?.getInfo();
    return { api: "serial", supported, secureContext: secureContext(), permission: !supported ? "unsupported" : this.port ? "granted" : "prompt", connected: Boolean(this.port?.readable), ...(info ? { deviceLabel: label(info) } : {}) };
  }

  async requestPort() {
    const manager = this.manager ?? serialManager();
    if (!manager) throw new Error("Web Serial is unavailable in this browser");
    if (!secureContext()) throw new Error("Web Serial requires a secure context");
    const port = await manager.requestPort(this.options.filters?.length ? { filters: this.options.filters } : undefined);
    await this.attach(port);
    return port;
  }

  async start(emit: InputFrameListener) {
    this.emit = emit;
    this.active = true;
    this.manager ??= serialManager();
    if (!this.port && this.manager) {
      const granted = await this.manager.getPorts();
      this.port = granted.find((port) => this.matches(port));
    }
    if (this.port) await this.attach(this.port);
    this.report();
  }

  async stop() {
    this.active = false;
    try { await this.reader?.cancel(); } catch { /* Port may already be gone. */ }
    await this.readTask;
    this.framer.reset();
    this.emit?.(this.emitter?.release() ?? releaseFrame(this.id, this.playerId));
    this.emitter = undefined;
    this.emit = undefined;
    if (this.port?.readable || this.port?.writable) { try { await this.port.close(); } catch { /* Device may already be gone. */ } }
    this.report();
  }

  async write(bytes: Uint8Array) {
    const writable = this.port?.writable;
    if (!writable) throw new Error("Serial port is not writable");
    const writer = writable.getWriter();
    try { await writer.write(bytes); } finally { writer.releaseLock(); }
  }

  private async attach(port: SerialPort101) {
    this.port = port;
    if (!port.readable && !port.writable) await port.open(this.options.open);
    if (!port.readable) throw new Error("Serial port did not provide a readable stream");
    this.emitter = new HardwareFrameEmitter(`serial-${safeId(label(port.getInfo()))}`, this.playerId, this.source, this.decoder);
    this.readTask = this.readLoop(port);
    this.report();
  }

  private async readLoop(port: SerialPort101) {
    while (this.active && port === this.port && port.readable) {
      const reader = port.readable.getReader();
      this.reader = reader;
      let failure: unknown;
      try {
        while (this.active) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (const bytes of this.framer.push(value)) {
            const frame = this.emitter?.decode({ bytes, timestamp: performance.now() });
            if (frame) this.emit?.(frame);
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        try { reader.releaseLock(); } catch { /* The stream may already be errored. */ }
        if (this.reader === reader) this.reader = undefined;
      }
      // Reaching here while still active means the device vanished rather than being stopped
      // deliberately, so release every held control instead of latching the last packet.
      if (this.active && port === this.port) await this.releasePort(port, failure);
      break;
    }
  }

  private async releasePort(port: SerialPort101, error?: unknown) {
    this.framer.reset();
    this.emit?.(this.emitter?.release() ?? releaseFrame(this.id, this.playerId));
    this.emitter = undefined;
    this.port = undefined;
    if (port.readable || port.writable) { try { await port.close(); } catch { /* Device may already be gone. */ } }
    this.report(error);
  }

  private matches(port: SerialPort101) {
    if (!this.options.filters?.length) return true;
    const info = port.getInfo();
    return this.options.filters.some((filter) => (filter.usbVendorId === undefined || filter.usbVendorId === info.usbVendorId) && (filter.usbProductId === undefined || filter.usbProductId === info.usbProductId) && (filter.bluetoothServiceClassId === undefined || filter.bluetoothServiceClassId === info.bluetoothServiceClassId));
  }

  private report(error?: unknown) { this.options.onStatus?.({ ...this.status, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }); }
}

function serialManager(): SerialManager101 | undefined { return (navigator as Navigator & { serial?: SerialManager101 }).serial; }
function secureContext() { return typeof isSecureContext === "undefined" || isSecureContext; }
function label(info: SerialPortInfo101) { return info.usbVendorId === undefined ? info.bluetoothServiceClassId ? `BLE ${info.bluetoothServiceClassId}` : "Serial device" : `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId ?? 0)}`; }
function safeId(value: string) { return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "device"; }
function hex(value: number) { return Math.max(0, value).toString(16).padStart(4, "0"); }
function validateFilter(filter: SerialPortFilter101) {
  if (!filter || Object.values(filter).every((value) => value === undefined)) throw new Error("Empty Serial filters are not allowed");
  for (const value of [filter.usbVendorId, filter.usbProductId]) if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 65_535)) throw new Error("Invalid Serial USB filter");
  if (filter.bluetoothServiceClassId !== undefined && (filter.bluetoothServiceClassId.length === 0 || filter.bluetoothServiceClassId.length > 128)) throw new Error("Invalid Serial Bluetooth service filter");
  return { ...filter };
}
function validateOpenOptions(options: SerialOpenOptions101) {
  if (!options || !Number.isInteger(options.baudRate) || options.baudRate < 1 || options.baudRate > 20_000_000) throw new Error("Invalid serial baud rate");
  if (options.bufferSize !== undefined && (!Number.isInteger(options.bufferSize) || options.bufferSize < 255 || options.bufferSize > 16 * 1024 * 1024)) throw new Error("Invalid serial buffer size");
}
function releaseFrame(deviceId: string, playerId: string) { return { deviceId, playerId, sequence: Number.MAX_SAFE_INTEGER, timestamp: performance.now(), source: "serial" as const, actions: {}, axes: {}, vectors: {} }; }
