import { Game101 } from "@101/sdk";

export const meteorDash = Game101.define({
  id: "meteor-dash",
  initialState: () => ({ x: 0, y: 0, energy: 1 }),
  start(ctx) {
    ctx.input.bind("move");
    ctx.input.bind("boost");
  },
  update(ctx, deltaSeconds) {
    const move = ctx.input.vector("move");
    const speed = ctx.input.action("boost") ? 2 : 1;
    ctx.state.x += move.x * speed * deltaSeconds;
    ctx.state.y += move.y * speed * deltaSeconds;
  },
});
