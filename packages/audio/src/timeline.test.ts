import assert from "node:assert/strict";
import test from "node:test";
import { AudioTimeline101 } from "./index.ts";

interface AutomationEvent {
  kind: "cancel" | "set" | "ramp";
  value?: number;
  at: number;
}

class FakeAudioParam {
  readonly events: AutomationEvent[] = [];

  cancelScheduledValues(at: number) {
    this.events.push({ kind: "cancel", at });
    return this as unknown as AudioParam;
  }

  setValueAtTime(value: number, at: number) {
    this.events.push({ kind: "set", value, at });
    return this as unknown as AudioParam;
  }

  linearRampToValueAtTime(value: number, at: number) {
    this.events.push({ kind: "ramp", value, at });
    return this as unknown as AudioParam;
  }
}

class FakeOscillator {
  type: OscillatorType = "sine";
  readonly frequency = new FakeAudioParam();
  readonly starts: number[] = [];
  readonly stops: number[] = [];
  connectedTo?: unknown;
  disconnected = false;
  onended: (() => void) | null = null;

  connect(destination: unknown) {
    this.connectedTo = destination;
    return destination;
  }

  disconnect() {
    this.disconnected = true;
  }

  start(at: number) {
    this.starts.push(at);
  }

  stop(at: number) {
    this.stops.push(at);
  }
}

class FakeGain {
  readonly gain = new FakeAudioParam();
  connectedTo?: unknown;
  disconnected = false;

  connect(destination: unknown) {
    this.connectedTo = destination;
    return destination;
  }

  disconnect() {
    this.disconnected = true;
  }
}

test("schedules tone nodes at an absolute AudioContext time and cancels queued cues", async () => {
  const oscillator = new FakeOscillator();
  const outputGain = new FakeGain();
  const cueGain = new FakeGain();
  const gains = [outputGain, cueGain];
  const destination = {} as AudioNode;
  const context = {
    currentTime: 20,
    state: "suspended",
    destination,
    resumeCalls: 0,
    async resume() {
      this.resumeCalls += 1;
      this.state = "running";
    },
    createOscillator: () => oscillator,
    createGain: () => gains.shift(),
  };
  const timeline = new AudioTimeline101({
    context: context as unknown as AudioContext,
    destination,
  });
  timeline.registerTone("beat", {
    frequency: 130,
    duration: .055,
    volume: .4,
    wave: "square",
    release: .025,
  });

  await timeline.resume();
  const cue = timeline.schedule("beat", context.currentTime + .15, { volume: .42 });

  assert.equal(context.resumeCalls, 1);
  assert.equal(timeline.running, true);
  assert.ok(cue);
  assert.equal(cue.at, 20.15);
  assert.deepEqual(oscillator.starts, [20.15], "the source must enter the Web Audio timeline early");
  assert.ok(Math.abs(oscillator.stops[0]! - 20.205) < 1e-9);
  assert.equal(oscillator.type, "square");
  assert.deepEqual(oscillator.frequency.events, [{ kind: "set", value: 130, at: 20.15 }]);
  assert.ok(cueGain.gain.events.some((event) => event.kind === "ramp" && event.value === .4 * .42));
  assert.equal(cueGain.connectedTo, outputGain, "scheduled cues must pass through the local mute gain");
  assert.equal(outputGain.connectedTo, destination, "the local gain must pass through the shared master volume");

  context.currentTime = 20.04;
  timeline.cancelAll();
  assert.deepEqual(oscillator.stops.slice(1), [20.04]);
  assert.equal(oscillator.disconnected, true);
  assert.equal(cueGain.disconnected, true);

  timeline.dispose();
  assert.equal(outputGain.disconnected, true);
  assert.throws(() => timeline.schedule("beat", 21), /disposed/);
});

test("mutes only its own timeline while hidden and removes the visibility listener on dispose", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const visibilityListeners = new Set<() => void>();
  const fakeDocument = {
    hidden: false,
    addEventListener(type: string, listener: () => void) {
      if (type === "visibilitychange") visibilityListeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "visibilitychange") visibilityListeners.delete(listener);
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument as unknown as Document,
  });

  const outputGain = new FakeGain();
  const destination = {} as AudioNode;
  const context = {
    currentTime: 4,
    state: "running",
    destination,
    createGain: () => outputGain,
  };
  let timeline: AudioTimeline101 | undefined;
  try {
    timeline = new AudioTimeline101({
      context: context as unknown as AudioContext,
      destination,
    });
    assert.equal(visibilityListeners.size, 1);
    assert.deepEqual(outputGain.gain.events.slice(-2), [
      { kind: "cancel", at: 4 },
      { kind: "set", value: 1, at: 4 },
    ]);

    context.currentTime = 5;
    fakeDocument.hidden = true;
    for (const listener of visibilityListeners) listener();
    assert.deepEqual(outputGain.gain.events.slice(-2), [
      { kind: "cancel", at: 5 },
      { kind: "set", value: 0, at: 5 },
    ]);

    context.currentTime = 6;
    fakeDocument.hidden = false;
    for (const listener of visibilityListeners) listener();
    assert.deepEqual(outputGain.gain.events.slice(-2), [
      { kind: "cancel", at: 6 },
      { kind: "set", value: 1, at: 6 },
    ]);

    timeline.dispose();
    timeline = undefined;
    assert.equal(visibilityListeners.size, 0);
    assert.equal(outputGain.disconnected, true);
    const eventCount = outputGain.gain.events.length;
    fakeDocument.hidden = true;
    for (const listener of visibilityListeners) listener();
    assert.equal(outputGain.gain.events.length, eventCount, "disposed timelines must ignore later visibility changes");
  } finally {
    timeline?.dispose();
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
