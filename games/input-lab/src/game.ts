import { Game101 } from "@101/sdk";

export interface InputLabState {
  x: number;
  y: number;
  pulses: number;
}

export default Game101.define<InputLabState>({
  id: "input-lab",
  initialState: () => ({ x: 0, y: 0, pulses: 0 }),
  start(ctx) {
    ctx.input.bind("move");
    ctx.input.bind("aim");
    ctx.input.bind("trigger");
  },
  update(ctx, delta) {
    const move = ctx.input.vector("move");
    ctx.state.x = Math.max(-1, Math.min(1, ctx.state.x + move.x * delta * 0.9));
    ctx.state.y = Math.max(-1, Math.min(1, ctx.state.y + move.y * delta * 0.9));
    if (ctx.input.action("trigger")) ctx.state.pulses += delta;
  },
});
