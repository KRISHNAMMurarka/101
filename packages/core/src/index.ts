import { InputBus } from "@101/input";
import type { GameContext, GameDefinition, GameInput } from "@101/sdk";
export * from "./random.ts";

export class Engine101<State> {
  readonly inputBus: InputBus;
  readonly context: GameContext<State>;
  readonly game: GameDefinition<State>;
  private frameHandle?: number;
  private previousTime = 0;

  constructor(
    game: GameDefinition<State>,
    inputBus = new InputBus(),
  ) {
    this.game = game;
    this.inputBus = inputBus;
    const input: GameInput = {
      bind: (name) => inputBus.bind(name),
      action: (name, playerId) => inputBus.action(name, playerId),
      axis: (name, playerId) => inputBus.axis(name, playerId),
      vector: (name, playerId) => inputBus.vector(name, playerId),
      pose: () => undefined,
    };
    this.context = {
      input,
      state: game.initialState(),
      assets: {
        load: async (...urls) => {
          await Promise.all(urls.map((url) => fetch(url)));
        },
      },
    };
  }

  async start() {
    await this.game.preload?.(this.context);
    this.game.start?.(this.context);
    this.previousTime = performance.now();
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.frameHandle !== undefined) cancelAnimationFrame(this.frameHandle);
    this.game.stop?.(this.context);
    this.frameHandle = undefined;
  }

  step(deltaSeconds: number) {
    this.game.update(this.context, Math.min(deltaSeconds, 0.1));
  }

  private tick = (now: number) => {
    this.step((now - this.previousTime) / 1000);
    this.previousTime = now;
    this.frameHandle = requestAnimationFrame(this.tick);
  };
}
