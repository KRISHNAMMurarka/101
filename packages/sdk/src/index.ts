import type { InputVector } from "@101/input";

export type RendererKind = "2d" | "3d";

export interface GameManifest {
  id: string;
  name: string;
  tagline?: string;
  version: string;
  engine: string;
  renderer: RendererKind;
  players: { min: number; max: number };
  inputs: string[];
  offline: boolean;
  procedural: boolean;
  status?: "playable" | "foundation" | "planned";
  accent?: string;
}

export interface GameInput {
  bind(control: string): void;
  action(name: string, playerId?: string): boolean | number;
  axis(name: string, playerId?: string): number;
  vector(name: string, playerId?: string): InputVector;
  pose(name: string, playerId?: string): ReadonlyArray<number> | undefined;
}

export interface GameContext<State = unknown> {
  input: GameInput;
  state: State;
  assets: {
    load(...urls: string[]): Promise<void>;
  };
}

export interface GameDefinition<State = unknown> {
  id: string;
  initialState: () => State;
  preload?(context: GameContext<State>): Promise<void>;
  start?(context: GameContext<State>): void;
  update(context: GameContext<State>, deltaSeconds: number): void;
  stop?(context: GameContext<State>): void;
}

export const Game101 = {
  define<State>(definition: GameDefinition<State>) {
    return Object.freeze(definition);
  },
};
