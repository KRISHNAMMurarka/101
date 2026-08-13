import type { InputAdapter, InputFrameListener } from "@101/input";

export class KeyboardAdapter implements InputAdapter {
  readonly id = "keyboard-primary";
  readonly source = "keyboard" as const;
  private emit?: InputFrameListener;
  private sequence = 0;
  private readonly pressed = new Set<string>();

  constructor(private readonly playerId = "player-1") {}

  start(emit: InputFrameListener) {
    this.emit = emit;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.publish();
  }

  stop() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.emit = undefined;
    this.pressed.clear();
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
      event.preventDefault();
    }
    this.pressed.add(event.code);
    this.publish();
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.pressed.delete(event.code);
    this.publish();
  };

  private onBlur = () => {
    this.pressed.clear();
    this.publish();
  };

  private publish() {
    const x = Number(this.has("ArrowRight", "KeyD")) - Number(this.has("ArrowLeft", "KeyA"));
    const y = Number(this.has("ArrowDown", "KeyS")) - Number(this.has("ArrowUp", "KeyW"));
    const gravityX = Number(this.has("ArrowRight")) - Number(this.has("ArrowLeft"));
    const gravityY = Number(this.has("ArrowDown")) - Number(this.has("ArrowUp"));
    const placeX = Number(this.has("KeyD")) - Number(this.has("KeyA"));
    const shield = Number(this.has("KeyE")) - Number(this.has("KeyQ"));
    this.emit?.({
      deviceId: this.id,
      playerId: this.playerId,
      sequence: ++this.sequence,
      timestamp: performance.now(),
      source: this.source,
      actions: {
        trigger: this.has("Space", "Enter"),
        fire: this.has("Space", "Enter"),
        slash: this.has("Space", "Enter"),
        buttonA: this.has("Space"),
        buttonB: this.has("ShiftLeft", "ShiftRight"),
        boost: this.has("Space", "Enter"),
        brake: this.has("ArrowDown", "KeyS"),
        drift: this.has("ShiftLeft", "ShiftRight", "KeyX"),
        duck: this.has("ArrowDown", "KeyS"),
        jump: this.has("ArrowUp", "KeyW", "Space"),
        armsRaised: this.has("KeyE", "Enter"),
        leanLeft: this.has("ArrowLeft", "KeyA"),
        leanRight: this.has("ArrowRight", "KeyD"),
        fortify: this.has("KeyC"),
        vent: this.has("KeyV"),
        overdrive: this.has("KeyF"),
        emergency: this.has("KeyR"),
        "beat.left": this.has("ArrowLeft", "KeyA"),
        "beat.right": this.has("ArrowRight", "KeyD"),
        "beat.punch": this.has("ArrowUp", "KeyW", "Space"),
        "beat.raise": this.has("KeyE", "Enter"),
        "beat.duck": this.has("ArrowDown", "KeyS"),
        "spell.cast.shield": this.has("KeyQ"),
        "spell.cast.grab": this.has("KeyE"),
        "spell.cast.projectile": this.has("Space", "Enter"),
        "spell.cast.charge": this.has("KeyC"),
        "spell.cast.blade": this.has("ShiftLeft", "ShiftRight", "KeyX"),
        "spell.cast.vortex": this.has("KeyR"),
        "maze.scan": this.has("KeyR", "Space"),
        "maze.flashlight": this.has("KeyF"),
        "maze.mark": this.has("KeyM"),
        "combat.punchLeft": this.has("KeyJ"),
        "combat.punchRight": this.has("KeyK"),
        "combat.block": this.has("KeyL", "KeyQ"),
        "combat.duck": this.has("ArrowDown", "KeyS"),
        "combat.jump": this.has("ArrowUp", "KeyW", "Space"),
        "combat.special": this.has("KeyI", "KeyE"),
        "swarm.select": this.has("Enter"),
        "swarm.formation.cluster": this.has("Digit1"),
        "swarm.formation.line": this.has("Digit2"),
        "swarm.formation.wedge": this.has("Digit3"),
        "swarm.formation.ring": this.has("Digit4"),
        "swarm.formation.grid": this.has("Digit5"),
        "swarm.ability.pulse": this.has("KeyQ"),
        "swarm.ability.shield": this.has("KeyE"),
        "swarm.ability.recall": this.has("KeyR"),
        drop: this.has("Space", "Enter"),
        pause: this.has("Escape"),
      },
      axes: { moveX: x, moveY: y, steer: x, dodgeX: x, lean: x, shield, power: this.has("KeyR") ? 1 : 0, placeX },
      vectors: { move: { x, y }, "maze.move": { x, y }, "maze.scanDirection": { x, y }, "combat.move": { x, y }, "swarm.direction": { x, y }, aim: { x, y }, "spell.aim": { x, y }, flight: { x, y }, target: { x, y }, gravity: { x: gravityX, y: gravityY }, gesture: { x, y } },
    });
  }

  private has(...codes: string[]) {
    return codes.some((code) => this.pressed.has(code));
  }
}
