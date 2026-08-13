import type { InputVector } from "@101/input";

export type HardwareValueType = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32";
export type HardwareControlKind = "action" | "axis" | "vector";

export interface HardwareControlMapping {
  kind: HardwareControlKind;
  name: string;
  offset: number;
  valueType: HardwareValueType;
  littleEndian?: boolean;
  component?: "x" | "y" | "z";
  inputMin?: number;
  inputCenter?: number;
  inputMax?: number;
  deadZone?: number;
  threshold?: number;
  invert?: boolean;
}

export interface HardwareReportMapping {
  reportId?: number;
  controls: readonly HardwareControlMapping[];
}

export interface HardwareDecodedState {
  actions: Record<string, boolean | number>;
  axes: Record<string, number>;
  vectors: Record<string, InputVector>;
}

export interface HardwarePacket {
  bytes: Uint8Array;
  reportId?: number;
  timestamp: number;
}

export type HardwareDecoder = (packet: HardwarePacket) => HardwareDecodedState | undefined;

export interface HardwareCapabilityStatus {
  api: "hid" | "bluetooth" | "serial";
  supported: boolean;
  secureContext: boolean;
  permission: "unsupported" | "prompt" | "granted";
  connected: boolean;
  deviceLabel?: string;
  error?: string;
}

export function createHardwareDecoder(mapping: HardwareReportMapping): HardwareDecoder {
  const validated = validateHardwareMapping(mapping);
  const vectors: Record<string, InputVector> = {};
  return (packet) => {
    if (validated.reportId !== undefined && packet.reportId !== validated.reportId) return undefined;
    const view = new DataView(packet.bytes.buffer, packet.bytes.byteOffset, packet.bytes.byteLength);
    const state: HardwareDecodedState = { actions: {}, axes: {}, vectors: {} };
    for (const control of validated.controls) {
      if (control.offset + byteWidth(control.valueType) > view.byteLength) continue;
      const raw = readValue(view, control);
      const value = normalizeValue(raw, control);
      if (control.kind === "action") {
        state.actions[control.name] = control.threshold === undefined ? value : raw >= control.threshold;
      } else if (control.kind === "axis") {
        state.axes[control.name] = value;
      } else {
        const previous = vectors[control.name] ?? { x: 0, y: 0 };
        const next = { ...previous, [control.component!]: value };
        vectors[control.name] = next;
        state.vectors[control.name] = { ...next };
      }
    }
    return state;
  };
}

export function validateHardwareMapping(mapping: HardwareReportMapping): HardwareReportMapping {
  if (!mapping || typeof mapping !== "object" || !Array.isArray(mapping.controls) || mapping.controls.length === 0 || mapping.controls.length > 128) {
    throw new Error("A hardware mapping requires 1-128 controls");
  }
  if (mapping.reportId !== undefined && (!Number.isInteger(mapping.reportId) || mapping.reportId < 0 || mapping.reportId > 255)) {
    throw new Error("Hardware reportId must be an unsigned byte");
  }
  const controls = mapping.controls.map((control, index) => {
    if (!control || typeof control !== "object" || !["action", "axis", "vector"].includes(control.kind)) throw new Error(`Invalid hardware control ${index}`);
    if (!/^[a-z0-9._-]{1,64}$/i.test(control.name)) throw new Error(`Invalid hardware control name ${index}`);
    if (!Number.isInteger(control.offset) || control.offset < 0 || control.offset > 65_535) throw new Error(`Invalid hardware offset ${index}`);
    if (!["u8", "i8", "u16", "i16", "u32", "i32", "f32"].includes(control.valueType)) throw new Error(`Invalid hardware value type ${index}`);
    if (control.kind === "vector" && !["x", "y", "z"].includes(control.component ?? "")) throw new Error(`Vector control ${control.name} requires a component`);
    const numbers = [control.inputMin, control.inputCenter, control.inputMax, control.deadZone, control.threshold].filter((value) => value !== undefined);
    if (numbers.some((value) => !Number.isFinite(value))) throw new Error(`Invalid numeric mapping for ${control.name}`);
    if (control.deadZone !== undefined && (control.deadZone < 0 || control.deadZone >= 1)) throw new Error(`Invalid dead zone for ${control.name}`);
    if (control.inputMin !== undefined && control.inputMax !== undefined && control.inputMin >= control.inputMax) throw new Error(`Invalid input range for ${control.name}`);
    return { ...control };
  });
  return { ...(mapping.reportId === undefined ? {} : { reportId: mapping.reportId }), controls };
}

export class HardwareFrameEmitter {
  private sequence = 0;
  private readonly deviceId: string;
  private readonly playerId: string;
  private readonly source: "hid" | "bluetooth" | "serial";
  private readonly decoder: HardwareDecoder;
  constructor(
    deviceId: string,
    playerId: string,
    source: "hid" | "bluetooth" | "serial",
    decoder: HardwareDecoder,
  ) {
    this.deviceId = deviceId;
    this.playerId = playerId;
    this.source = source;
    this.decoder = decoder;
  }

  decode(packet: HardwarePacket) {
    const state = this.decoder(packet);
    if (!state) return undefined;
    return {
      deviceId: this.deviceId,
      playerId: this.playerId,
      source: this.source,
      sequence: ++this.sequence,
      timestamp: packet.timestamp,
      actions: state.actions,
      axes: state.axes,
      vectors: state.vectors,
    } as const;
  }

  release(timestamp = performance.now()) {
    return {
      deviceId: this.deviceId,
      playerId: this.playerId,
      source: this.source,
      sequence: ++this.sequence,
      timestamp,
      actions: {},
      axes: {},
      vectors: {},
    } as const;
  }
}

export interface HardwareByteFramer {
  push(chunk: Uint8Array): Uint8Array[];
  reset(): void;
}

export class DelimitedByteFramer implements HardwareByteFramer {
  private pending = new Uint8Array();
  private readonly delimiter: number;
  private readonly maxFrameBytes: number;
  constructor(delimiter = 0x0a, maxFrameBytes = 64 * 1024) {
    if (!Number.isInteger(delimiter) || delimiter < 0 || delimiter > 255) throw new Error("Delimiter must be an unsigned byte");
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 1_048_576) throw new Error("Invalid serial frame limit");
    this.delimiter = delimiter;
    this.maxFrameBytes = maxFrameBytes;
  }
  push(chunk: Uint8Array) {
    const combined = new Uint8Array(this.pending.length + chunk.length);
    combined.set(this.pending);
    combined.set(chunk, this.pending.length);
    const frames: Uint8Array[] = [];
    let start = 0;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== this.delimiter) continue;
      if (index > start) frames.push(combined.slice(start, index));
      start = index + 1;
    }
    this.pending = combined.slice(start);
    if (this.pending.length > this.maxFrameBytes) {
      this.pending = new Uint8Array();
      throw new Error("Serial frame exceeds configured limit");
    }
    return frames;
  }
  reset() { this.pending = new Uint8Array(); }
}

export class FixedLengthByteFramer implements HardwareByteFramer {
  private pending = new Uint8Array();
  private readonly frameBytes: number;
  constructor(frameBytes: number) {
    if (!Number.isInteger(frameBytes) || frameBytes < 1 || frameBytes > 64 * 1024) throw new Error("Invalid fixed serial frame size");
    this.frameBytes = frameBytes;
  }
  push(chunk: Uint8Array) {
    const combined = new Uint8Array(this.pending.length + chunk.length);
    combined.set(this.pending);
    combined.set(chunk, this.pending.length);
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (combined.length - offset >= this.frameBytes) { frames.push(combined.slice(offset, offset + this.frameBytes)); offset += this.frameBytes; }
    this.pending = combined.slice(offset);
    return frames;
  }
  reset() { this.pending = new Uint8Array(); }
}

function readValue(view: DataView, control: HardwareControlMapping) {
  const little = control.littleEndian ?? true;
  switch (control.valueType) {
    case "u8": return view.getUint8(control.offset);
    case "i8": return view.getInt8(control.offset);
    case "u16": return view.getUint16(control.offset, little);
    case "i16": return view.getInt16(control.offset, little);
    case "u32": return view.getUint32(control.offset, little);
    case "i32": return view.getInt32(control.offset, little);
    case "f32": return view.getFloat32(control.offset, little);
  }
}

function normalizeValue(raw: number, control: HardwareControlMapping) {
  let value: number;
  if (control.inputCenter !== undefined) {
    const min = control.inputMin ?? defaultRange(control.valueType)[0];
    const max = control.inputMax ?? defaultRange(control.valueType)[1];
    value = raw < control.inputCenter
      ? (raw - control.inputCenter) / Math.max(1e-9, control.inputCenter - min)
      : (raw - control.inputCenter) / Math.max(1e-9, max - control.inputCenter);
  } else {
    const [defaultMin, defaultMax] = defaultRange(control.valueType);
    const min = control.inputMin ?? defaultMin;
    const max = control.inputMax ?? defaultMax;
    value = min < 0 ? raw / Math.max(Math.abs(min), Math.abs(max)) : ((raw - min) / Math.max(1e-9, max - min)) * 2 - 1;
  }
  value = Math.max(-1, Math.min(1, value));
  if (Math.abs(value) < (control.deadZone ?? 0)) value = 0;
  return control.invert ? -value : value;
}

function byteWidth(type: HardwareValueType) { return type.endsWith("8") ? 1 : type.endsWith("16") ? 2 : 4; }
function defaultRange(type: HardwareValueType): [number, number] {
  switch (type) {
    case "u8": return [0, 255];
    case "i8": return [-128, 127];
    case "u16": return [0, 65_535];
    case "i16": return [-32_768, 32_767];
    case "u32": return [0, 4_294_967_295];
    case "i32": return [-2_147_483_648, 2_147_483_647];
    case "f32": return [-1, 1];
  }
}
