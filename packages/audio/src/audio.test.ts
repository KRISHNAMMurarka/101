import assert from "node:assert/strict";
import test from "node:test";
import { Howl, Howler } from "howler";
import { Audio101, toneDataUri } from "./index.ts";

test("generates a bounded offline PCM wave without an external asset", () => {
  const uri = toneDataUri({ frequency: 440, duration: .05, wave: "triangle" });
  assert.match(uri, /^data:audio\/wav;base64,/);
  const bytes = Buffer.from(uri.split(",")[1]!, "base64");
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 22_050);
  assert.ok(bytes.length > 44);
});

test("scopes mute state to each audio instance and leaves the next game audible", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalHowlMute = Howl.prototype.mute;
  const originalGlobalMute = readGlobalMute();
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
  const muteCalls: Array<{ sound: Howl; muted: boolean }> = [];
  Howl.prototype.mute = function (this: Howl, muted?: boolean) {
    if (typeof muted === "boolean") muteCalls.push({ sound: this, muted });
    return typeof muted === "boolean" ? this : false;
  } as typeof Howl.prototype.mute;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument as unknown as Document,
  });
  Howler.mute(false);

  const dispatchVisibilityChange = () => {
    for (const listener of [...visibilityListeners]) listener();
  };
  const soundFor = (audio: Audio101, id: string) => {
    const sound = (audio as unknown as { sounds: Map<string, Howl> }).sounds.get(id);
    assert.ok(sound);
    return sound;
  };

  let outgoing: Audio101 | undefined;
  let overlapping: Audio101 | undefined;
  let incoming: Audio101 | undefined;
  try {
    outgoing = new Audio101();
    outgoing.register("outgoing", { src: ["outgoing.wav"], preload: false });
    overlapping = new Audio101();
    overlapping.register("overlapping", { src: ["overlapping.wav"], preload: false });
    const outgoingSound = soundFor(outgoing, "outgoing");
    const overlappingSound = soundFor(overlapping, "overlapping");

    muteCalls.length = 0;
    outgoing.setMuted(true);
    assert.deepEqual(muteCalls, [{ sound: outgoingSound, muted: true }]);
    assert.equal(readGlobalMute(), false);

    muteCalls.length = 0;
    fakeDocument.hidden = true;
    dispatchVisibilityChange();
    assert.deepEqual(muteCalls, [
      { sound: outgoingSound, muted: true },
      { sound: overlappingSound, muted: true },
    ]);
    assert.equal(readGlobalMute(), false);

    muteCalls.length = 0;
    outgoing.unload();
    outgoing = undefined;
    fakeDocument.hidden = false;
    dispatchVisibilityChange();
    assert.deepEqual(muteCalls, [{ sound: overlappingSound, muted: false }]);
    assert.equal(readGlobalMute(), false);

    overlapping.unload();
    overlapping = undefined;
    incoming = new Audio101();
    incoming.register("incoming", { src: ["incoming.wav"], preload: false });
    assert.equal(readGlobalMute(), false);
    assert.equal(readHowlMute(soundFor(incoming, "incoming")), false);
  } finally {
    outgoing?.unload();
    overlapping?.unload();
    incoming?.unload();
    Howl.prototype.mute = originalHowlMute;
    Howler.mute(originalGlobalMute);
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("explicitly resumes a suspended browser audio context", async () => {
  const originalContext = Howler.ctx;
  const originalUsingWebAudio = Howler.usingWebAudio;
  let resumes = 0;
  try {
    Howler.usingWebAudio = true;
    Howler.ctx = {
      state: "suspended",
      async resume() { resumes += 1; },
    } as AudioContext;
    const audio = new Audio101();
    await audio.resume();
    assert.equal(resumes, 1);
    audio.unload();
  } finally {
    Howler.ctx = originalContext;
    Howler.usingWebAudio = originalUsingWebAudio;
  }
});

function readGlobalMute() {
  return (Howler as unknown as { _muted: boolean })._muted;
}

function readHowlMute(sound: Howl) {
  return (sound as unknown as { _muted: boolean })._muted;
}
