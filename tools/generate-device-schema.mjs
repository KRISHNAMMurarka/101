import { writeFileSync } from "node:fs";
import { DEVICE_DESCRIPTOR_SCHEMA } from "../packages/device-model/src/index.ts";

writeFileSync(new URL("../schemas/device-descriptor.schema.json", import.meta.url), `${JSON.stringify(DEVICE_DESCRIPTOR_SCHEMA, null, 2)}\n`);
console.log("Generated the device descriptor editor schema.");
