import type { InputAdapter, InputFrameListener } from "@101/input";

export class GamepadAdapter implements InputAdapter {
  readonly id = "gamepad-browser";
  readonly source = "gamepad" as const;
  private emit?: InputFrameListener;
  private frameHandle?: number;
  private sequence = 0;

  constructor(private readonly playerId = "player-1") {}

  start(emit: InputFrameListener) {
    this.emit = emit;
    this.frameHandle = requestAnimationFrame(this.poll);
  }

  stop() {
    if (this.frameHandle !== undefined) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.emit = undefined;
  }

  private poll = () => {
    const pads = navigator.getGamepads?.() ?? [];
    const gamepad = [...pads].find(Boolean);
    if (gamepad) {
      const deadZone = (value = 0) => (Math.abs(value) < 0.12 ? 0 : value);
      const x = deadZone(gamepad.axes[0]);
      const y = deadZone(gamepad.axes[1]);
      this.emit?.({
        deviceId: `gamepad-${gamepad.index}`,
        playerId: this.playerId,
        sequence: ++this.sequence,
        timestamp: performance.now(),
        source: this.source,
        actions: {
          trigger: gamepad.buttons[0]?.pressed ?? false,
          buttonA: gamepad.buttons[0]?.pressed ?? false,
          buttonB: gamepad.buttons[1]?.pressed ?? false,
          pause: gamepad.buttons[9]?.pressed ?? false,
        },
        axes: { moveX: x, moveY: y, steer: x },
        vectors: { move: { x, y }, aim: { x: deadZone(gamepad.axes[2]), y: deadZone(gamepad.axes[3]) } },
      });
    }
    this.frameHandle = requestAnimationFrame(this.poll);
  };
}
