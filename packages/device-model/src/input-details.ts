import { DeviceValidationError } from './descriptor.ts';
import { getInputProfile } from './input-profile.ts';
import { parseSignalValue } from './sample.ts';

function fail(path: string): never { throw new DeviceValidationError('input-detail-range', path); }
function finite(value: number, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path);
  return value;
}
function schema(profile: 'app:pen/1' | 'app:rotary/1' | 'app:gamepad/1', id: string) {
  const value = getInputProfile(profile).capabilities.find(capability => capability.id === id)?.value;
  if (!value) throw new Error(`Missing ${profile} ${id} profile`);
  return value;
}

export interface PenCalibration {
  readonly pressureMin: number; readonly pressureMax: number;
  readonly tiltXOffset: number; readonly tiltYOffset: number; readonly twistOffset: number;
}
export interface RawPenDetail {
  readonly id: string; readonly phase: 'down' | 'move' | 'up' | 'cancel';
  readonly position: Readonly<{ x: number; y: number }>; readonly primary: boolean;
  readonly pressure: number; readonly tiltX: number; readonly tiltY: number; readonly twist: number;
}

/** Calibrates provider pen values before the reliable app:pen/1 transition is published. */
export function createPenDetailProcessor(calibration: PenCalibration) {
  const min = finite(calibration.pressureMin, 0, 1, '$.pressureMin');
  const max = finite(calibration.pressureMax, 0, 1, '$.pressureMax');
  if (max <= min) fail('$.pressureMax');
  const tiltXOffset = finite(calibration.tiltXOffset, -90, 90, '$.tiltXOffset');
  const tiltYOffset = finite(calibration.tiltYOffset, -90, 90, '$.tiltYOffset');
  const twistOffset = finite(calibration.twistOffset, -359, 359, '$.twistOffset');
  return Object.freeze({ process(input: RawPenDetail) {
    // Browser pen release/cancel reports zero even when the in-contact sensor floor is higher.
    const pressure = (input.phase === 'up' || input.phase === 'cancel') && input.pressure === 0 ? 0 :
      (finite(input.pressure, min, max, '$.pressure') - min) / (max - min);
    const tiltX = finite(input.tiltX, -90, 90, '$.tiltX') - tiltXOffset;
    const tiltY = finite(input.tiltY, -90, 90, '$.tiltY') - tiltYOffset;
    const twist = ((finite(input.twist, 0, 359, '$.twist') - twistOffset) % 360 + 360) % 360;
    return parseSignalValue({ ...input, pressure, tiltX, tiltY, twist }, schema('app:pen/1', 'pen'));
  } });
}

/** Counts are signed and never rounded, so fractional detents are not lost. */
export function createRotaryDeltaProcessor(countsPerDetent: number) {
  finite(countsPerDetent, Number.MIN_VALUE, 1e6, '$.countsPerDetent');
  return Object.freeze({ process(source: 'crown' | 'encoder', counts: number) {
    const delta = finite(counts, -1024 * countsPerDetent, 1024 * countsPerDetent, '$.counts') / countsPerDetent;
    return parseSignalValue({ source, delta, unit: 'detent' }, schema('app:rotary/1', 'delta'));
  } });
}

export interface GamepadAxisCalibration { readonly min: number; readonly center: number; readonly max: number; readonly deadzone: number }
export interface GamepadTriggerCalibration { readonly button: number; readonly min: number; readonly max: number }
export interface GamepadDetailConfig {
  readonly axes: readonly GamepadAxisCalibration[];
  readonly buttonCount: number;
  /** A button index uses the standard normalized [0, 1] range; a record declares a raw range. */
  readonly triggers: readonly (number | GamepadTriggerCalibration)[];
  readonly hats: readonly Readonly<{ xAxis: number; yAxis: number; threshold: number }>[];
}
export interface RawGamepadDetail {
  readonly axes: readonly number[];
  readonly buttons: readonly Readonly<{ pressed: boolean; value: number }>[];
}

/** A probed inventory and its calibration; every emitted control has its own profile signal. */
export function createGamepadDetailProcessor(config: GamepadDetailConfig) {
  if (!Array.isArray(config.axes) || !Array.isArray(config.triggers) || !Array.isArray(config.hats) ||
      config.axes.length > 16 || !Number.isInteger(config.buttonCount) || config.buttonCount < 0 || config.buttonCount > 32) fail('$.inventory');
  const buttonCount = config.buttonCount;
  const axes = config.axes.map((axis, index) => {
    const min = finite(axis.min, -1, 1, `$.axes.${index}.min`);
    const center = finite(axis.center, -1, 1, `$.axes.${index}.center`);
    const max = finite(axis.max, -1, 1, `$.axes.${index}.max`);
    const deadzone = finite(axis.deadzone, 0, 0.95, `$.axes.${index}.deadzone`);
    if (!(min < center && center < max)) fail(`$.axes.${index}`);
    return { min, center, max, deadzone };
  });
  const triggers = config.triggers.map((entry, index) => {
    const value = typeof entry === 'number' ? { button: entry, min: 0, max: 1 } : entry;
    if (!value || !Number.isInteger(value.button) || value.button < 0 || value.button >= buttonCount) fail(`$.triggers.${index}`);
    const min = finite(value.min, -1, 1, `$.triggers.${index}.min`);
    const max = finite(value.max, -1, 1, `$.triggers.${index}.max`);
    if (min >= max) fail(`$.triggers.${index}`);
    return { button: value.button, min, max };
  });
  if (new Set(triggers.map(value => value.button)).size !== triggers.length) fail('$.triggers');
  const triggerByButton = new Map(triggers.map(value => [value.button, value]));
  if (config.hats.length > 16) fail('$.hats');
  const hats = config.hats.map((hat, index) => {
    if (!Number.isInteger(hat.xAxis) || !Number.isInteger(hat.yAxis) || hat.xAxis === hat.yAxis ||
        hat.xAxis < 0 || hat.yAxis < 0 || hat.xAxis >= axes.length || hat.yAxis >= axes.length) fail(`$.hats.${index}`);
    finite(hat.threshold, Number.MIN_VALUE, 1, `$.hats.${index}.threshold`);
    return { xAxis: hat.xAxis, yAxis: hat.yAxis, threshold: hat.threshold };
  });
  let previousButtons = Array(buttonCount).fill(false) as boolean[];
  let previousHats = Array(hats.length).fill('center') as string[];
  function button(id: number, pressed: boolean, pressure: number) {
    return parseSignalValue({ id: `button-${id}`, pressed, pressure }, schema('app:gamepad/1', 'button'));
  }
  function hat(id: number, direction: string) {
    return parseSignalValue({ id: `hat-${id}`, direction }, schema('app:gamepad/1', 'hat'));
  }
  return Object.freeze({ process(input: RawGamepadDetail) {
    if (input.axes.length !== axes.length || input.buttons.length !== buttonCount) fail('$.inventory');
    const normalized = input.axes.map((value, index) => {
      const axis = axes[index]!;
      const raw = finite(value, axis.min, axis.max, `$.axes.${index}`);
      const scaled = (raw - axis.center) / (raw < axis.center ? axis.center - axis.min : axis.max - axis.center);
      return Math.abs(scaled) <= axis.deadzone ? 0 : Math.sign(scaled) * (Math.abs(scaled) - axis.deadzone) / (1 - axis.deadzone);
    });
    const buttons = input.buttons.map((value, index) => {
      if (typeof value?.pressed !== 'boolean') fail(`$.buttons.${index}.pressed`);
      const trigger = triggerByButton.get(index);
      const pressure = trigger ? (finite(value.value, trigger.min, trigger.max, `$.buttons.${index}.value`) - trigger.min) /
        (trigger.max - trigger.min) : finite(value.value, 0, 1, `$.buttons.${index}.value`);
      return { pressed: value.pressed, pressure };
    });
    const nextHats = hats.map(({ xAxis, yAxis, threshold }) => {
      const x = normalized[xAxis]!, y = normalized[yAxis]!;
      const horizontal = x <= -threshold ? 'west' : x >= threshold ? 'east' : '';
      const vertical = y <= -threshold ? 'north' : y >= threshold ? 'south' : '';
      return vertical || horizontal ? vertical + horizontal : 'center';
    });
    const events = buttons.flatMap((value, index) => value.pressed === previousButtons[index] ? [] : [button(index, value.pressed, value.pressure)]);
    const hatEvents = nextHats.flatMap((direction, index) => direction === previousHats[index] ? [] : [hat(index, direction)]);
    const triggerSamples = triggers.map(({ button: index }) => parseSignalValue({ id: `button-${index}`, value: buttons[index]!.pressure }, schema('app:gamepad/1', 'trigger')));
    const axisValue = parseSignalValue(normalized, schema('app:gamepad/1', 'axes'));
    previousButtons = buttons.map(value => value.pressed); previousHats = nextHats;
    return Object.freeze({ axes: axisValue, buttons: Object.freeze(events), triggers: Object.freeze(triggerSamples), hats: Object.freeze(hatEvents) });
  }, release() {
    const buttons = previousButtons.flatMap((pressed, index) => pressed ? [button(index, false, 0)] : []);
    const hats = previousHats.flatMap((direction, index) => direction === 'center' ? [] : [hat(index, 'center')]);
    previousButtons = Array(buttonCount).fill(false); previousHats = Array(hats.length).fill('center');
    return Object.freeze({ buttons: Object.freeze(buttons), hats: Object.freeze(hats) });
  } });
}
