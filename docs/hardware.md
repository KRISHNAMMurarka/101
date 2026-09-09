# Specialist hardware adapters

101 treats WebHID, Web Bluetooth and Web Serial devices as **optional capability enhancements**. A custom board, an unusual peripheral, or a BLE sensor can supply the same semantic actions, axes and vectors that a keyboard supplies. No bundled game requires one of these transports to start, and none of them is ever opened without an explicit user gesture and the browser's own device chooser.

## Why a declarative mapping

Custom decoders can also return `poses: Record<string, number[]>`. The hardware emitter forwards
these arrays through HID, Bluetooth, and serial without clamping metric coordinates to joystick
range; disconnect clears them. A fake HID report now exercises this path through the real InputBus.
This is transport support, not automatic suit compatibility: the profile must define joint order,
units, calibration and the semantic actions its game consumes. No shipped game currently declares
a HID/Bluetooth/serial profile. See [the profile integration contract](VISION-VALIDATION.md) before
adding a player-facing connection option.

Every one of these transports ultimately delivers **bytes**. HID delivers input reports, BLE delivers GATT characteristic notifications, serial delivers a stream that must be framed. The interesting engineering problem is identical in all three cases: convert a byte layout into 101 game language.

`@101/hardware` owns that conversion once, so `@101/adapter-hid`, `@101/adapter-bluetooth` and `@101/adapter-serial` differ only in how they obtain bytes. A mapping authored for a prototype board over serial keeps working unchanged when the same firmware later exposes itself as a HID device.

```ts
import { createHardwareDecoder, type HardwareReportMapping } from "@101/hardware";

const mapping: HardwareReportMapping = {
  reportId: 1,
  controls: [
    { kind: "axis",   name: "steer",   offset: 0, valueType: "u8",  inputCenter: 128, deadZone: 0.08 },
    { kind: "action", name: "boost",   offset: 1, valueType: "u8",  threshold: 1 },
    { kind: "action", name: "throttle",offset: 2, valueType: "u8" },
    { kind: "vector", name: "aim",     offset: 3, valueType: "i16", component: "x" },
    { kind: "vector", name: "aim",     offset: 5, valueType: "i16", component: "y", invert: true },
  ],
};
```

### Control fields

| Field | Meaning |
| --- | --- |
| `kind` | `action` (boolean/analog button), `axis` (single scalar), `vector` (one component of a named vector) |
| `name` | Semantic 101 name the game binds, not a hardware name |
| `offset` | Byte offset inside the report or frame |
| `valueType` | `u8`, `i8`, `u16`, `i16`, `u32`, `i32`, `f32` |
| `littleEndian` | Defaults to `true` for multi-byte values |
| `component` | Required for `vector`: `x`, `y` or `z` |
| `inputMin` / `inputMax` | Raw range override; defaults to the natural range of `valueType` |
| `inputCenter` | Marks a centered control so each side normalizes independently |
| `deadZone` | Absolute normalized magnitude below which the value becomes exactly `0` |
| `threshold` | Raw value at or above which an `action` becomes `true`; omit to keep the action analog |
| `invert` | Negates the normalized result, for screen-space or mounting-orientation differences |
| `reportId` | Optional report filter; non-matching packets are ignored rather than misdecoded |

Every axis and vector component is normalized into `[-1, 1]`, matching every other 101 source. `validateHardwareMapping()` runs at construction time, so a malformed mapping fails immediately during development instead of silently producing wrong values at runtime. Controls whose offset would read past the end of a short packet are skipped, not read out of bounds.

### Custom decoders

Not every device is a fixed byte layout. Pass `decoder` instead of `mapping` for bit-packed reports, checksum-protected framing or text protocols:

```ts
new WebSerialAdapter({
  open: { baudRate: 115_200 },
  framer: new DelimitedByteFramer(0x0a),
  decoder: ({ bytes }) => {
    const [steer, buttons] = new TextDecoder().decode(bytes).split(",").map(Number);
    return { actions: { fire: (buttons & 1) === 1 }, axes: { steer: steer / 512 - 1 }, vectors: {} };
  },
});
```

## Transports

### `@101/adapter-hid`

```ts
const adapter = new WebHIDAdapter({
  filters: [{ vendorId: 0x0101 }],
  mapping,
  onStatus: (status) => console.log(status.permission, status.deviceLabel),
});
await adapter.requestDevice();  // must be called from a user gesture
await bus.register(adapter);
```

`requestDevice()` opens the browser chooser and is the only path that prompts. `start()` additionally checks `navigator.hid.getDevices()` for a device the user already granted and matching the adapter's own `filters`, which is what makes reconnect after a page reload silent. Both paths reuse the same filters, so the adapter can never widen its own access. `@101/adapter-serial` does the same through `getPorts()`, and `@101/adapter-bluetooth` through `getDevices()` where the browser exposes it.

### `@101/adapter-bluetooth`

Connects to exactly one declared GATT service and input characteristic, subscribes to notifications, and optionally writes to an output characteristic for rumble or LED commands. It performs no background scanning and requests no additional services.

### `@101/adapter-serial`

Serial is a stream, not a message channel, so framing is explicit. `FixedLengthByteFramer(n)` suits fixed binary packets and `DelimitedByteFramer(byte)` suits newline-style protocols. Both buffer partial reads across chunks and enforce a bounded pending buffer, so a device emitting garbage cannot grow memory without limit. `write()` sends host commands back to the board.

## Surprise disconnects

A deliberate `stop()` is the easy case. The one that matters is the device that simply vanishes: a cable pulled mid-game, a BLE sensor carried out of range, a board that resets itself. The last packet received before that moment is frequently *mid-input* — a trigger held, a stick pushed hard over — and if nothing clears it, the game keeps steering into a wall forever with no device left to fix it.

All three adapters therefore treat unexpected loss as a first-class event and emit the same neutral release frame that `stop()` does:

| Transport | Signal | Handling |
| --- | --- | --- |
| HID | `disconnect` on `navigator.hid`, matched to this adapter's own device | Detach listeners, release, clear device |
| Bluetooth | `gattserverdisconnected` on the device | Detach notifications, release, clear characteristic |
| Serial | Read loop ends or throws while still active | Reset framer, release, close and clear the port |

After a release the adapter also stops accepting late events from the detached device, so a straggling notification cannot re-latch a control that was just cleared. `onStatus` reports `connected: false` so the UI can offer reselection. This mirrors the watchdog and neutral-transition rules that browser and native 101 Link already follow — one platform-wide guarantee that a disconnected device never leaves a stuck input.

## Lifecycle guarantees

All three adapters:

- open the device only from an explicit user action, never on page load;
- report `supported`, `secureContext`, `permission`, `connected`, `deviceLabel` and `error` through `onStatus`;
- emit a **neutral release frame** on deliberate teardown *and* on surprise loss, so no action, axis or vector is ever left latched;
- close streams, remove listeners and release readers/writers in `stop()`, including when connection fails partway through;
- carry a stable `deviceId`, an incrementing `sequence` and the packet timestamp, so `@101/diagnostics` measures them like every other source.

## Hardware Lab

`/hardware` is the engineering playground. It reports honest per-API capability state after hydration (server-rendered output never claims support it cannot know), opens each chooser only on click, applies a sample four-byte mapping to `steer`, `trigger` and `aim`, and prints the resulting normalized frame. Use it to confirm a mapping before wiring the device into a game.

## Rules

- **Never gate a game on one of these APIs.** Support varies significantly by browser and operating system; Safari and Firefox do not ship all three. Keyboard, pointer, touch and gamepad startup controls remain mandatory.
- **Never scan or enumerate in the background.** The user's chooser selection is the permission boundary.
- **Surface unsupported honestly.** A disabled control with a stated reason is correct; a control that silently does nothing is not.
