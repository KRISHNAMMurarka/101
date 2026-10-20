"use client";

// Device discovery belongs to the linked platform; Games consumes its measured availability.
export { detectLocalCapabilities, localInputSources, describeLocalDevice, useLocalDevice, refreshLocalCameras } from "@uynis-connect/connect";
export type { LocalDevice } from "@uynis-connect/connect";
