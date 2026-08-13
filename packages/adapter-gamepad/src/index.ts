import type { InputAdapter, InputFrameListener } from "@101/input";

export class GamepadAdapter implements InputAdapter {
  readonly id = "gamepad-browser";
  readonly source = "gamepad" as const;
  private emit?: InputFrameListener;
  private frameHandle?: number;
  private sequence = 0;
  private activeDeviceId?: string;

  constructor(private readonly playerId = "player-1") {}

  start(emit: InputFrameListener) {
    this.emit = emit;
    this.frameHandle = requestAnimationFrame(this.poll);
  }

  stop() {
    if (this.frameHandle !== undefined) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.releaseActiveGamepad();
    this.emit = undefined;
  }

  private poll = () => {
    const pads = navigator.getGamepads?.() ?? [];
    const gamepad = [...pads].find(Boolean);
    if (gamepad) {
      this.activeDeviceId = `gamepad-${gamepad.index}`;
      const deadZone = (value = 0) => (Math.abs(value) < 0.12 ? 0 : value);
      const x = deadZone(gamepad.axes[0]);
      const y = deadZone(gamepad.axes[1]);
      this.emit?.({
        deviceId: this.activeDeviceId,
        playerId: this.playerId,
        sequence: ++this.sequence,
        timestamp: performance.now(),
        source: this.source,
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
      });
    } else this.releaseActiveGamepad();
    this.frameHandle = requestAnimationFrame(this.poll);
  };

  private releaseActiveGamepad() {
    if (!this.activeDeviceId) return;
    this.emit?.({
      deviceId: this.activeDeviceId,
      playerId: this.playerId,
      sequence: ++this.sequence,
      timestamp: performance.now(),
      source: this.source,
      actions: {},
      axes: {},
      vectors: {},
    });
    this.activeDeviceId = undefined;
  }
}
