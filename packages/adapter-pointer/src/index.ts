import type { InputAdapter, InputFrameListener } from "@101/input";

export class PointerAdapter implements InputAdapter {
  readonly id = "pointer-primary";
  readonly source = "mouse" as const;
  private emit?: InputFrameListener;
  private sequence = 0;
  private pressed = false;
  private x = 0;
  private y = 0;

  constructor(
    private readonly target: HTMLElement,
    private readonly playerId = "player-1",
  ) {}

  start(emit: InputFrameListener) {
    this.emit = emit;
    this.target.addEventListener("pointermove", this.onMove);
    this.target.addEventListener("pointerdown", this.onDown);
    this.target.addEventListener("pointerup", this.onUp);
    this.target.addEventListener("pointercancel", this.onUp);
  }

  stop() {
    this.target.removeEventListener("pointermove", this.onMove);
    this.target.removeEventListener("pointerdown", this.onDown);
    this.target.removeEventListener("pointerup", this.onUp);
    this.target.removeEventListener("pointercancel", this.onUp);
    this.emit = undefined;
  }

  private onMove = (event: PointerEvent) => {
    const bounds = this.target.getBoundingClientRect();
    this.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.y = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
    this.publish(event.pointerType);
  };

  private onDown = (event: PointerEvent) => {
    this.pressed = true;
    this.target.setPointerCapture?.(event.pointerId);
    this.onMove(event);
  };

  private onUp = (event: PointerEvent) => {
    this.pressed = false;
    this.publish(event.pointerType);
  };

  private publish(pointerType: string) {
    this.emit?.({
      deviceId: `${this.id}-${pointerType || "mouse"}`,
      playerId: this.playerId,
      sequence: ++this.sequence,
      timestamp: performance.now(),
      source: pointerType === "touch" ? "touch" : "mouse",
      actions: { trigger: this.pressed, touch: this.pressed, "swarm.select": this.pressed },
      vectors: { aim: { x: this.x, y: this.y }, "swarm.command": { x: this.x, y: this.y } },
    });
  }
}
