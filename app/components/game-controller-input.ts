import type { InputBus, InputFrame } from "@101/input";
import { ControllerInputModel, type ControllerInputSnapshot } from "@101/link-controller";
import type { GameControllerRole } from "@101/sdk";

/** A local panel contributes frames to the running host; it owns no engine or session. */
export class GameControllerInput {
  private readonly bus: InputBus;
  private readonly role: GameControllerRole;
  private readonly id: string;
  private readonly model: ControllerInputModel;
  private readonly listeners = new Set<() => void>();
  private current: ControllerInputSnapshot;
  private sequence = 0;
  private active = false;

  constructor(bus: InputBus, role: GameControllerRole, id: string) {
    this.bus = bus; this.role = role; this.id = id;
    this.model = new ControllerInputModel(role.layout);
    this.current = this.model.snapshot();
  }

  getSnapshot = () => this.current;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  start() { this.active = true; this.publish(this.model.snapshot()); }
  stop() {
    if (!this.active) return;
    this.release();
    this.active = false;
    this.bus.removeDevice(this.id, this.role.playerId);
  }
  release = () => this.publish(this.model.releaseAll());
  setActions = (values: Record<string, boolean | number>, owner?: string) => { if (this.active) this.publish(this.model.setActions(values, owner)); };
  setAction = (action: string, value: boolean | number) => { if (this.active) this.publish(this.model.setAction(action, value)); };
  setAxis = (action: string, value: number) => { if (this.active) this.publish(this.model.setAxis(action, value)); };
  setVector = (action: string, x: number, y: number) => { if (this.active) this.publish(this.model.setVector(action, x, y)); };

  private publish(snapshot: ControllerInputSnapshot) {
    // Late pointer/timer callbacks from a hidden or replaced panel cannot restore held controls.
    if (!this.active) return;
    this.current = snapshot;
    const frame: InputFrame = {
      ...snapshot, deviceId: this.id, playerId: this.role.playerId, source: "touch",
      sequence: ++this.sequence, timestamp: performance.now(),
    };
    this.bus.accept(frame);
    this.listeners.forEach((listener) => listener());
  }
}
