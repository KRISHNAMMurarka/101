export { DeviceValidationError, parseDeviceDescriptor, snapshotJson } from './descriptor.ts';
export type {
  DeviceCapability, DeviceDescriptor, DeliveryPolicy, JsonObject, JsonValue,
  OwnershipPolicy, PermissionOperation, SignalValue, ValueSchema,
} from './descriptor.ts';
export { parseSignalValue, schemasCompatible } from './sample.ts';
export { DEVICE_DESCRIPTOR_SCHEMA } from './descriptor-schema.ts';
