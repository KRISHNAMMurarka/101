import type { InputFrame } from './index.ts';

/** Structural SDK snapshot contract. No device runtime or adapter is imported into the game bus. */
export type LocalDeviceSnapshot = {
  readonly deviceId: string; readonly sequence: number; readonly timestamp: number;
} & (
  | { readonly source: 'keyboard'; readonly keys: readonly string[] }
  | { readonly source: 'gamepad'; readonly connected: boolean; readonly axes: readonly number[]; readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[] }
  | { readonly source: 'pointer'; readonly pointerType: string; readonly contact: boolean; readonly x: number; readonly y: number }
);
export interface DeviceMappingOptions {
  /** Unique owned subscription scope; never reuse it for concurrent subscriptions. */
  scopeId: string;
  playerId: string;
  emit(frame: InputFrame): unknown;
  removeDevice(deviceId: string, playerId: string): void;
}

export function createDeviceMapping(options: DeviceMappingOptions) {
  if (!options.scopeId || !options.playerId) throw new Error('Input mapping requires an owned scope and player');
  const { scopeId, playerId, emit, removeDevice } = options;
  const sequences = new Map<string, number>(), contributions = new Map<string, InputFrame>();
  let closed = false;
  const scopedId = (id: string) => `local:${JSON.stringify([scopeId, id])}`;
  const release = (deviceId: string) => {
    const frame = contributions.get(deviceId);
    if (!frame) return;
    contributions.delete(deviceId);
    emit({ ...frame, sequence: frame.sequence + 1, actions: {}, axes: {}, vectors: {}, poses: {} });
    removeDevice(frame.deviceId, playerId);
  };
  return {
    accept(snapshot: LocalDeviceSnapshot) {
      if (closed || !snapshot.deviceId || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || !Number.isFinite(snapshot.timestamp)) return false;
      const previous = sequences.get(snapshot.deviceId);
      if (previous !== undefined && snapshot.sequence <= previous) return false;
      sequences.set(snapshot.deviceId, snapshot.sequence);
      if (snapshot.source === 'gamepad' && !snapshot.connected) { release(snapshot.deviceId); return true; }
      const frame = mapSnapshot(snapshot, playerId);
      frame.deviceId = scopedId(snapshot.deviceId);
      contributions.set(snapshot.deviceId, frame); emit(frame); return true;
    },
    release,
    close() { if (closed) return; closed = true; for (const id of [...contributions.keys()]) release(id); sequences.clear(); },
  };
}

function mapSnapshot(snapshot: LocalDeviceSnapshot, playerId: string): InputFrame {
  if (snapshot.source === 'keyboard') return keyboard(snapshot, playerId);
  if (snapshot.source === 'gamepad') return gamepad(snapshot, playerId);
  return { deviceId: snapshot.deviceId, playerId, sequence: snapshot.sequence, timestamp: snapshot.timestamp,
    source: snapshot.pointerType === 'touch' ? 'touch' : 'mouse',
    actions: { trigger: snapshot.contact, touch: snapshot.contact, 'swarm.select': snapshot.contact },
    vectors: { aim: { x: snapshot.x, y: snapshot.y }, 'swarm.command': { x: snapshot.x, y: snapshot.y } } };
}
function keyboard(snapshot: Extract<LocalDeviceSnapshot, { source: 'keyboard' }>, playerId: string): InputFrame {
  const keys = new Set(snapshot.keys), has = (...codes: string[]) => codes.some(code => keys.has(code));
    const x = Number(has("ArrowRight", "KeyD")) - Number(has("ArrowLeft", "KeyA"));
    const y = Number(has("ArrowDown", "KeyS")) - Number(has("ArrowUp", "KeyW"));
    const gravityX = Number(has("ArrowRight")) - Number(has("ArrowLeft"));
    const gravityY = Number(has("ArrowDown")) - Number(has("ArrowUp"));
    const placeX = Number(has("KeyD")) - Number(has("KeyA"));
    const shield = Number(has("KeyE")) - Number(has("KeyQ"));
    return {
      deviceId: snapshot.deviceId,
      playerId,
      sequence: snapshot.sequence,
      timestamp: snapshot.timestamp,
      source: "keyboard",
      actions: {
        trigger: has("Space", "Enter"),
        fire: has("Space", "Enter"),
        slash: has("Space", "Enter"),
        buttonA: has("Space"),
        buttonB: has("ShiftLeft", "ShiftRight"),
        boost: has("Space", "Enter"),
        brake: has("ArrowDown", "KeyS"),
        drift: has("ShiftLeft", "ShiftRight", "KeyX"),
        duck: has("ArrowDown", "KeyS"),
        jump: has("ArrowUp", "KeyW", "Space"),
        armsRaised: has("KeyE", "Enter"),
        leanLeft: has("ArrowLeft", "KeyA"),
        leanRight: has("ArrowRight", "KeyD"),
        fortify: has("KeyC"),
        vent: has("KeyV"),
        overdrive: has("KeyF"),
        emergency: has("KeyR"),
        "beat.left": has("ArrowLeft", "KeyA"),
        "beat.right": has("ArrowRight", "KeyD"),
        "beat.punch": has("ArrowUp", "KeyW", "Space"),
        "beat.raise": has("KeyE", "Enter"),
        "beat.duck": has("ArrowDown", "KeyS"),
        "beat.swing": has("KeyG"),
        "spell.cast.shield": has("KeyQ"),
        "spell.cast.grab": has("KeyE"),
        "spell.cast.projectile": has("Space", "Enter"),
        "spell.cast.charge": has("KeyC"),
        "spell.cast.blade": has("ShiftLeft", "ShiftRight", "KeyX"),
        "spell.cast.vortex": has("KeyR"),
        "maze.scan": has("KeyR", "Space"),
        "maze.flashlight": has("KeyF"),
        "maze.mark": has("KeyM"),
        "combat.punchLeft": has("KeyJ"),
        "combat.punchRight": has("KeyK"),
        "combat.block": has("KeyL", "KeyQ"),
        "combat.duck": has("ArrowDown", "KeyS"),
        "combat.jump": has("ArrowUp", "KeyW", "Space"),
        "combat.special": has("KeyI", "KeyE"),
        "swarm.select": has("Enter"),
        "swarm.formation.cluster": has("Digit1"),
        "swarm.formation.line": has("Digit2"),
        "swarm.formation.wedge": has("Digit3"),
        "swarm.formation.ring": has("Digit4"),
        "swarm.formation.grid": has("Digit5"),
        "swarm.ability.pulse": has("KeyQ"),
        "swarm.ability.shield": has("KeyE"),
        "swarm.ability.recall": has("KeyR"),
        drop: has("Space", "Enter"),
        pause: has("Escape"),
      },
      axes: { moveX: x, moveY: y, steer: x, dodgeX: x, lean: x, shield, power: has("KeyR") ? 1 : 0, placeX },
      vectors: { move: { x, y }, "maze.move": { x, y }, "maze.scanDirection": { x, y }, "combat.move": { x, y }, "swarm.direction": { x, y }, aim: { x, y }, "spell.aim": { x, y }, flight: { x, y }, target: { x, y }, gravity: { x: gravityX, y: gravityY }, gesture: { x, y } },
    };
}
function gamepad(snapshot: Extract<LocalDeviceSnapshot, { source: 'gamepad' }>, playerId: string): InputFrame {
  const gamepad = snapshot;
      const deadZone = (value = 0) => (Math.abs(value) < 0.12 ? 0 : value);
      const x = deadZone(gamepad.axes[0]);
      const y = deadZone(gamepad.axes[1]);
      return {
        deviceId: snapshot.deviceId,
        playerId,
        sequence: snapshot.sequence,
        timestamp: snapshot.timestamp,
        source: "gamepad",
        actions: {
          trigger: gamepad.buttons[0]?.pressed ?? false,
          fire: gamepad.buttons[0]?.pressed ?? false,
          buttonA: gamepad.buttons[0]?.pressed ?? false,
          buttonB: gamepad.buttons[1]?.pressed ?? false,
          boost: gamepad.buttons[0]?.pressed ?? false,
          brake: gamepad.buttons[6]?.pressed ?? false,
          drift: gamepad.buttons[1]?.pressed ?? false,
          duck: (gamepad.axes[1] ?? 0) > .55 || (gamepad.buttons[1]?.pressed ?? false),
          jump: gamepad.buttons[0]?.pressed ?? false,
          armsRaised: gamepad.buttons[3]?.pressed ?? false,
          leanLeft: x < -.45,
          leanRight: x > .45,
          fortify: gamepad.buttons[2]?.pressed ?? false,
          vent: gamepad.buttons[1]?.pressed ?? false,
          overdrive: gamepad.buttons[3]?.pressed ?? false,
          emergency: gamepad.buttons[8]?.pressed ?? false,
          "beat.left": x < -.45 || (gamepad.buttons[14]?.pressed ?? false),
          "beat.right": x > .45 || (gamepad.buttons[15]?.pressed ?? false),
          "beat.punch": gamepad.buttons[0]?.pressed ?? false,
          "beat.raise": gamepad.buttons[3]?.pressed ?? false,
          "beat.duck": gamepad.buttons[1]?.pressed ?? false,
          "beat.swing": gamepad.buttons[7]?.pressed ?? false,
          "spell.cast.shield": gamepad.buttons[4]?.pressed ?? false,
          "spell.cast.grab": gamepad.buttons[2]?.pressed ?? false,
          "spell.cast.projectile": gamepad.buttons[0]?.pressed ?? false,
          "spell.cast.charge": gamepad.buttons[3]?.pressed ?? false,
          "spell.cast.blade": gamepad.buttons[1]?.pressed ?? false,
          "spell.cast.vortex": gamepad.buttons[5]?.pressed ?? false,
          "maze.scan": gamepad.buttons[0]?.pressed ?? false,
          "maze.flashlight": gamepad.buttons[3]?.pressed ?? false,
          "maze.mark": gamepad.buttons[2]?.pressed ?? false,
          "combat.punchLeft": gamepad.buttons[2]?.pressed ?? false,
          "combat.punchRight": gamepad.buttons[1]?.pressed ?? false,
          "combat.block": gamepad.buttons[4]?.pressed ?? false,
          "combat.duck": (gamepad.axes[1] ?? 0) > .55 || (gamepad.buttons[13]?.pressed ?? false),
          "combat.jump": gamepad.buttons[0]?.pressed ?? false,
          "combat.special": gamepad.buttons[3]?.pressed ?? false,
          "swarm.select": gamepad.buttons[0]?.pressed ?? false,
          "swarm.formation.cluster": gamepad.buttons[14]?.pressed ?? false,
          "swarm.formation.line": gamepad.buttons[15]?.pressed ?? false,
          "swarm.formation.wedge": gamepad.buttons[12]?.pressed ?? false,
          "swarm.formation.ring": gamepad.buttons[13]?.pressed ?? false,
          "swarm.formation.grid": gamepad.buttons[8]?.pressed ?? false,
          "swarm.ability.pulse": gamepad.buttons[2]?.pressed ?? false,
          "swarm.ability.shield": gamepad.buttons[5]?.pressed ?? false,
          "swarm.ability.recall": gamepad.buttons[9]?.pressed ?? false,
          drop: gamepad.buttons[0]?.pressed ?? false,
          pause: gamepad.buttons[9]?.pressed ?? false,
        },
        axes: {
          moveX: x,
          moveY: y,
          steer: x,
          dodgeX: x,
          lean: x,
          shield: (gamepad.buttons[5]?.value ?? 0) - (gamepad.buttons[4]?.value ?? 0),
          power: gamepad.buttons[7]?.value ?? 0,
          placeX: x,
        },
        vectors: {
          move: { x, y },
          "maze.move": { x, y },
          "maze.scanDirection": { x: deadZone(gamepad.axes[2] ?? gamepad.axes[0]), y: deadZone(gamepad.axes[3] ?? gamepad.axes[1]) },
          flight: { x, y },
          aim: { x: deadZone(gamepad.axes[2]), y: deadZone(gamepad.axes[3]) },
          "spell.aim": { x: deadZone(gamepad.axes[2] ?? gamepad.axes[0]), y: deadZone(gamepad.axes[3] ?? gamepad.axes[1]) },
          "combat.move": { x, y },
          "swarm.direction": { x, y },
          "swarm.command": { x: deadZone(gamepad.axes[2]), y: deadZone(gamepad.axes[3]) },
          target: { x: deadZone(gamepad.axes[2]), y: deadZone(gamepad.axes[3]) },
          gravity: { x: deadZone(gamepad.axes[2]), y: deadZone(gamepad.axes[3]) },
          gesture: { x, y },
        },
      };
}
