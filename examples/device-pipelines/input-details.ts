import { createGamepadDetailProcessor, createPenDetailProcessor, createRotaryDeltaProcessor } from '@101/device-model';

/** Synthetic producer shapes. A real host must probe inventory and call release on loss. */
export function runInputDetailsExample() {
  const pen = createPenDetailProcessor({ pressureMin: 0.1, pressureMax: 0.9,
    tiltXOffset: 5, tiltYOffset: 0, twistOffset: 20 });
  const rotary = createRotaryDeltaProcessor(4);
  const gamepad = createGamepadDetailProcessor({
    axes: [{ min: -1, center: 0, max: 1, deadzone: 0.1 }, { min: -1, center: 0, max: 1, deadzone: 0.1 }],
    buttonCount: 2, triggers: [{ button: 1, min: 0.1, max: 0.9 }], hats: [{ xAxis: 0, yAxis: 1, threshold: 0.5 }],
  });
  const contact = pen.process({ id: 'stylus-1', phase: 'down', position: { x: 0.25, y: 0.5 }, primary: true,
    pressure: 0.5, tiltX: 15, tiltY: -10, twist: 10 });
  const turn = rotary.process('crown', -3);
  const active = gamepad.process({ axes: [1, -1], buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0.7 }] });
  const disconnected = gamepad.release();
  return { contact, turn, active, disconnected };
}
