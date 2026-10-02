# Embedded device pipelines

These examples use `@101/connect` without a game package. They simulate the
providers in one process; they do not pair a physical device, send data over a
network, move an operating system cursor or operate an actual relay.

Run them with `npm run example:devices` from the repository root. The command
prints deterministic pointer coordinates and command evidence as JSON.

For an external consumer, build the current SDK with `npm run build:sdk -- HEAD`,
install all five produced tarballs in a separate directory using offline npm,
and run `node node_modules/@101/connect/examples/run.js`. The facade exports
`@101/connect/examples/pointer`, `/examples/sensor-feedback`,
`/examples/threshold` and `/examples/telemetry-batch` as compiled ESM with declarations. The packed examples also
include readable source. No workspace link, type stripping or game dependency is
needed for the compiled examples. See [distribution evidence](../../docs/platform/SDK-DISTRIBUTION-QA-2026-10-02.md)
for exact supported checks and remaining qualification.

## Touch position → application pointer

`pointer.ts` describes a dimensionless two-coordinate touch source and an
application surface accepting the same `surface-normalized` frame. A position
of `{ x: 0.2, y: 0.8 }` places the application pointer at `{ x: 200, y: 400 }`
on a 1000 by 500 surface. Resizing remaps the existing normalized position.

```ts
import { createPointerPipeline } from './pointer.ts';

const pointer = createPointerPipeline({ width: 1000, height: 500 });
pointer.publish({ x: 0.2, y: 0.8 }); // Admission; output has not applied yet.
pointer.runtime.flush();
console.log(pointer.state().position);
pointer.runtime.close();
```

The output has exclusive ownership. A second authorized route returns `busy`
while the first owner holds it, then starts after the first owner releases it.
Release clears the active pointer. The example uses an explicit deterministic
clock and grants; an embedding host supplies its own authority and lifecycle.

## Temperature → threshold → simulated relay

`sensor-feedback.ts` declares two separate authorized routes: a Celsius sensor
feeds the app-owned processor input, and the processor's boolean output feeds
a reliable set-state command. `threshold.ts` turns on at 30 °C and off at 28 °C;
readings between those limits retain the known state. An initial in-band reading
does not invent a state. This processor preserves upstream identity, time,
quality and calibration provenance with its own version and configuration.

```ts
import { createSensorFeedbackPipeline } from './sensor-feedback.ts';

const sensor = createSensorFeedbackPipeline();
sensor.publishTemperature(31.25);
sensor.runtime.flush(); // Processor receives input and queues derived output.
sensor.runtime.flush(); // Relay receives the set-state command.
console.log(sensor.state().operations); // unverified
sensor.receiveFeedback(); // Separate simulated state observation.
console.log(sensor.state().operations); // observed
sensor.runtime.close();
```

Commands have increasing positive decimal IDs and bounded deadlines. Missing
feedback leaves evidence `unverified`; dispatch never implies observation. This
simulated relay uses explicit set-state commands, not retryable toggles.
Unavailable input or upstream revocation resets hysteresis, marks derived output
unavailable and clears pending commands. Invalid, stale or nonfinite readings do
not produce an actuator command. The processor declares `Cel`; the SDK performs
no automatic unit conversion.

## Timestamped resident-memory batch

`telemetry-batch.ts` declares 1–16 records of timestamp and resident bytes. Version
2 adds optional quality; `upgradeTelemetryBatchV1()` explicitly validates and
migrates version 1, labeling old readings `unverified`. A version mismatch cannot
silently route. The deterministic runner uses labeled fixtures. A Node consumer
can publish actual process memory through the same authorized embedded route:

```js
import { createTelemetryBatchPipeline } from '@101/connect/examples/telemetry-batch';

const timestamp = performance.now();
const batch = createTelemetryBatchPipeline({ now: () => timestamp });
try {
  batch.publish([{ timestamp, residentBytes: process.memoryUsage().rss, quality: 'observed' }]);
  batch.runtime.flush();
  console.log(batch.state().residentBytes);
  batch.connection.stop(); // Releases the sink's owned telemetry state.
} finally { batch.runtime.close(); }
```

For an explicitly converted source, call `publishResidentKiBy([{ timestamp,
residentKiBy, quality }])` on a version 2 pipeline. It validates the `KiBy`
batch, converts to the declared `By` sink with explicit decimal precision and
an error budget, and retains the conversion map in observation provenance. It
does not infer units from a number or change normal route compatibility.

Timestamp members retain the application's clock domain. Remote structured samples
and events negotiate `json/2`; outer observation timestamps translate separately.
The wire and full runtime observation/options envelopes each have an independent
4 KiB limit. A wire-valid batch may exceed host admission once provenance is
included. `payload-limit` reports a dropped batch without refreshing the route;
smaller data may recover while the current grant remains active.

## Local peer resource example

[remote-pointer.ts](remote-pointer.ts) declares application pointer/contact resources and explicit owner selection into host-authorized sinks through the public facade. Run `node tools/qa-resource-peer.mjs chromium` or `webkit` from the repository root for actual two-peer WebRTC with synthetic values, both diagonals, resize and loss. This separately labeled runtime check does not prove a phone touch provider, native input, endpoint authentication or physical acceptance. See [resource QA](../../docs/platform/RESOURCE-BINDING-QA-2026-10-02.md).
