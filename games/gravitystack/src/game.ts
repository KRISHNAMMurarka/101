import { Physics101, type BodyState101, type PhysicsBody101 } from "@101/physics";
import { Game101, type GameContext } from "@101/sdk";
import { GravityStackDirector, type StackShapeSpec } from "./director.ts";

export interface StackPiece extends StackShapeSpec {
  body: PhysicsBody101;
  state: BodyState101;
  lost: boolean;
}

export interface GravityStackState {
  seed: string;
  physics: Physics101;
  director: GravityStackDirector;
  ready: boolean;
  platform?: PhysicsBody101;
  pieces: StackPiece[];
  preview: StackShapeSpec;
  gravity: { x: number; y: number };
  targetGravity: { x: number; y: number };
  placementX: number;
  elapsed: number;
  dropCooldown: number;
  score: number;
  towerHeight: number;
  stability: number;
  integrity: number;
  lostPieces: number;
  lastEvent: string;
  gameOver: boolean;
  previousDrop: boolean;
}

const PLATFORM_Y = 5.2;

export function createGravityStackGame(seed = "gravitystack-101") {
  return Game101.define<GravityStackState>({
    id: "gravitystack",
    initialState: () => {
      const director = new GravityStackDirector(seed);
      return {
        seed,
        physics: new Physics101(),
        director,
        ready: false,
        pieces: [],
        preview: director.next(),
        gravity: { x: 0, y: 9.81 },
        targetGravity: { x: 0, y: 9.81 },
        placementX: 0,
        elapsed: 0,
        dropCooldown: 0,
        score: 0,
        towerHeight: 0,
        stability: 100,
        integrity: 100,
        lostPieces: 0,
        lastEvent: "DROP THE FIRST SHAPE",
        gameOver: false,
        previousDrop: false,
      };
    },
    async preload(ctx) {
      const state = ctx.state;
      await state.physics.initialize(state.gravity);
      state.platform = state.physics.createBody({ type: "fixed", x: 0, y: PLATFORM_Y });
      state.physics.createCollider(state.platform, { type: "box", width: 10.5, height: .65 }, { friction: 1.2, restitution: .02 });
      state.ready = true;
    },
    start(ctx) {
      ["gravity", "placeX", "drop"].forEach((control) => ctx.input.bind(control));
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (!state.ready || state.gameOver) return;
      state.elapsed += delta;
      state.dropCooldown = Math.max(0, state.dropCooldown - delta);

      const requested = roleVector(ctx, "gravity", "role-gravity", "gravity");
      if (Math.hypot(requested.x, requested.y) > .12) {
        const length = Math.hypot(requested.x, requested.y);
        state.targetGravity = { x: requested.x / length * 9.81, y: requested.y / length * 9.81 };
      }
      const gravityBlend = Math.min(1, delta * 2.6);
      state.gravity.x += (state.targetGravity.x - state.gravity.x) * gravityBlend;
      state.gravity.y += (state.targetGravity.y - state.gravity.y) * gravityBlend;
      state.physics.setGravity(state.gravity.x, state.gravity.y);

      const placement = roleAxis(ctx, "placeX", "role-builder");
      state.placementX += (placement * 4.15 - state.placementX) * Math.min(1, delta * 8);
      const drop = Boolean(ctx.input.action("drop", "role-builder") || ctx.input.action("drop", "player-1") || ctx.input.action("trigger", "player-1"));
      if (drop && !state.previousDrop && state.dropCooldown <= 0) spawnPiece(state);
      state.previousDrop = drop;

      state.physics.step(delta);
      let highest = PLATFORM_Y;
      let totalMotion = 0;
      let activeCount = 0;
      for (const piece of state.pieces) {
        if (piece.lost) continue;
        piece.state = state.physics.bodyState(piece.body);
        const { position, velocity, angularVelocity } = piece.state;
        const halfHeight = piece.kind === "orb" ? piece.radius ?? .5 : piece.height / 2;
        highest = Math.min(highest, position.y - halfHeight);
        totalMotion += Math.hypot(velocity.x, velocity.y) + Math.abs(angularVelocity) * .25;
        activeCount += 1;
        if (Math.abs(position.x) <= 15 && position.y <= 15 && position.y >= -15) continue;
        piece.lost = true;
        state.physics.removeBody(piece.body);
        state.lostPieces += 1;
        state.integrity = Math.max(0, state.integrity - 20);
        state.lastEvent = `${piece.kind.toUpperCase()} LOST TO GRAVITY`;
      }
      state.towerHeight = Math.max(0, PLATFORM_Y - highest - .3);
      state.stability = activeCount ? Math.max(0, Math.min(100, 100 - totalMotion / activeCount * 22)) : 100;
      state.score = Math.max(state.score, Math.round(state.towerHeight * 180 + state.pieces.filter((piece) => !piece.lost).length * 35 + state.stability));
      if (state.integrity <= 0) state.gameOver = true;
    },
    stop(ctx) {
      ctx.state.physics.destroy();
      ctx.state.ready = false;
    },
  });
}

function spawnPiece(state: GravityStackState) {
  const spec = state.preview;
  const body = state.physics.createBody({
    x: state.placementX,
    y: -5.5,
    rotation: spec.rotation,
    linearDamping: .04,
    angularDamping: .08,
  });
  state.physics.createCollider(body, spec.kind === "orb"
    ? { type: "ball", radius: spec.radius ?? .55 }
    : { type: "box", width: spec.width, height: spec.height }, {
    density: spec.density,
    friction: spec.friction,
    restitution: spec.restitution,
  });
  state.pieces.push({ ...spec, body, state: state.physics.bodyState(body), lost: false });
  state.preview = state.director.next();
  state.dropCooldown = .35;
  state.lastEvent = `${spec.material.toUpperCase()} ${spec.kind.toUpperCase()} DROPPED`;
}

function roleVector(ctx: GameContext<GravityStackState>, name: string, playerId: string, fallback: string) {
  const role = ctx.input.vector(name, playerId);
  if (Math.hypot(role.x, role.y) > .01) return role;
  const conventional = ctx.input.vector(name, "player-1");
  return Math.hypot(conventional.x, conventional.y) > .01 ? conventional : ctx.input.vector(fallback, "player-1");
}

function roleAxis(ctx: GameContext<GravityStackState>, name: string, playerId: string) {
  const role = ctx.input.axis(name, playerId);
  return Math.abs(role) > .001 ? role : ctx.input.axis(name, "player-1");
}

export default createGravityStackGame();
