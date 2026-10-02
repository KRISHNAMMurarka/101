# Embedded device pipelines

These examples use `@101/connect` without a game package. They simulate the
providers in one process; they do not pair a physical device, send data over a
network, move an operating system cursor or operate an actual relay.

Run them with `npm run example:devices` from the repository root. The command
prints deterministic pointer coordinates and command evidence as JSON.

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

## Local peer resource example

[remote-pointer.ts](remote-pointer.ts) declares application pointer/contact resources and explicit owner selection into host-authorized sinks through the public facade. Run `node tools/qa-resource-peer.mjs chromium` or `webkit` from the repository root for actual two-peer WebRTC with synthetic values, both diagonals, resize and loss. This separately labeled runtime check does not prove a phone touch provider, native input, endpoint authentication or physical acceptance. See [resource QA](../../docs/platform/RESOURCE-BINDING-QA-2026-10-02.md).
