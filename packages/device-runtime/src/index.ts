export { EmbeddedRuntime } from "./runtime.ts";
import { EmbeddedRuntime } from "./runtime.ts";
import type { DeviceRuntime, RuntimeOptions } from "./types.ts";
export const createDeviceRuntime = (options: RuntimeOptions): DeviceRuntime => new EmbeddedRuntime(options);
export type * from "./types.ts";
export type { Evidence, OperationRecord, OperationState, Result } from "./scheduler.ts";
