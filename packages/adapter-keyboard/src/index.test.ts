import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { InputFrame } from "@101/input";
import { KeyboardAdapter } from "./index.ts";

function keyboard(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const window = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  const adapter = new KeyboardAdapter();
  const frames: InputFrame[] = [];
  adapter.start((frame) => frames.push(frame));
  t.after(() => {
    adapter.stop();
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  });
  /** A key press as the browser delivers it: at whatever element has focus, then up to the window. */
  const press = (code: string, focused: { matches(selector: string): boolean }) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { code });
    Object.defineProperty(event, "target", { value: focused });
    window.dispatchEvent(event);
    return { prevented: event.defaultPrevented, frame: frames.at(-1)! };
  };
  return { press };
}

const playField = { matches: () => false };
const button = { matches: (selector: string) => selector.split(",").map((part) => part.trim()).includes("button") };

test("Space on a focused button presses the button, not the game", (t) => {
  /*
   * The adapter listens on the window and cancelled Space and the arrows wherever they came from.
   * Cancelling a keydown cancels a button's own activation, so when a run ended and focus moved to
   * Play again, Space did nothing — only Enter restarted — and the press was read as a jump instead.
   */
  const { press } = keyboard(t);
  const pressed = press("Space", button);
  assert.equal(pressed.prevented, false, "the button must keep its native activation");
  assert.equal(pressed.frame.actions.jump, false, "a key that belongs to a control is not also game input");
});

test("Space and the arrows on the play field still drive the game and do not scroll the page", (t) => {
  const { press } = keyboard(t);
  const jump = press("Space", playField);
  assert.equal(jump.prevented, true);
  assert.equal(jump.frame.actions.jump, true);
  const left = press("ArrowLeft", playField);
  assert.equal(left.prevented, true);
  assert.equal(left.frame.axes?.moveX, -1);
});
