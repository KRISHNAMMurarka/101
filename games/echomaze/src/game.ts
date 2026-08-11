import { compassLabel, mazeBearing, shortestPath, travel, type MazeDirection, type MazePoint } from "@101/maze";
import { Game101, type GameContext } from "@101/sdk";
import { EchoMazeDirector, type EchoFloor } from "./director.ts";

export interface EchoClue {
  target: "fragment" | "exit";
  bearing: number;
  compass: string;
  distance: number;
  signal: number;
  echoDistance: number;
  exitLocked: boolean;
}

export interface EchoMazeState {
  seed: string;
  director: EchoMazeDirector;
  floor: EchoFloor;
  floorNumber: number;
  player: MazePoint;
  facing: MazeDirection;
  collected: string[];
  clearedEchoes: string[];
  elapsed: number;
  floorStartedAt: number;
  nextMoveAt: number;
  score: number;
  steps: number;
  health: number;
  battery: number;
  flashlight: boolean;
  scanDirection: { x: number; y: number };
  scanSequence: number;
  floorSequence: number;
  impactSequence: number;
  lastEvent: string;
  previousScan: boolean;
  previousFlashlight: boolean;
  clue: EchoClue;
  gameOver: boolean;
}

export function createEchoMazeGame(seed = "echomaze-101") {
  return Game101.define<EchoMazeState>({
    id: "echomaze",
    initialState: () => {
      const director = new EchoMazeDirector(seed);
      const floor = director.next();
      const state: EchoMazeState = {
        seed, director, floor, floorNumber: 1, player: { ...floor.start }, facing: "south", collected: [], clearedEchoes: [],
        elapsed: 0, floorStartedAt: 0, nextMoveAt: 0, score: 0, steps: 0, health: 100, battery: 100, flashlight: true,
        scanDirection: { x: 0, y: -1 }, scanSequence: 0, floorSequence: 0, impactSequence: 0, lastEvent: "THE SCANNER HEARS TWO FRAGMENTS",
        previousScan: false, previousFlashlight: false, clue: emptyClue(floor), gameOver: false,
      };
      refreshClue(state);
      return state;
    },
    start(ctx) {
      ["maze.scan", "maze.flashlight", "maze.mark"].forEach((action) => ctx.input.bind(action));
      ["maze.move", "maze.scanDirection"].forEach((vector) => ctx.input.bind(vector));
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (state.gameOver) return;
      state.elapsed += delta;
      state.battery = state.flashlight ? Math.max(0, state.battery - delta * 1.7) : Math.min(100, state.battery + delta * .65);
      if (state.battery <= 0) { state.flashlight = false; state.lastEvent = "THE LIGHT HAS GONE QUIET"; }

      const scanDirection = readVector(ctx, "maze.scanDirection");
      if (Math.hypot(scanDirection.x, scanDirection.y) > .12) state.scanDirection = scanDirection;
      const move = readVector(ctx, "maze.move", "move");
      if (state.elapsed >= state.nextMoveAt && Math.hypot(move.x, move.y) > .42) {
        movePlayer(state, directionForVector(move));
        state.nextMoveAt = state.elapsed + .17;
      }

      const scan = readAction(ctx, "maze.scan");
      if (scan && !state.previousScan) performScan(state);
      state.previousScan = scan;
      const flashlight = readAction(ctx, "maze.flashlight");
      if (flashlight && !state.previousFlashlight && state.battery > 1) {
        state.flashlight = !state.flashlight;
        state.lastEvent = state.flashlight ? "FLASHLIGHT OPEN" : "FLASHLIGHT SHUT";
      }
      state.previousFlashlight = flashlight;
    },
  });
}

function movePlayer(state: EchoMazeState, direction: MazeDirection) {
  state.facing = direction;
  const next = travel(state.floor, state.player, direction);
  if (samePoint(next, state.player)) { state.lastEvent = "STONE ANSWERS · PATH CLOSED"; return; }
  state.player = next;
  state.steps += 1;
  const key = pointKey(next);
  const fragment = state.floor.fragments.find((point) => pointKey(point) === key);
  if (fragment && !state.collected.includes(key)) {
    state.collected.push(key);
    state.score += 750 * state.floorNumber;
    state.battery = Math.min(100, state.battery + 22);
    state.lastEvent = `MEMORY FRAGMENT ${state.collected.length}/${state.floor.fragments.length}`;
  }
  const echo = state.floor.echoes.find((point) => pointKey(point) === key);
  if (echo && !state.clearedEchoes.includes(key)) {
    state.clearedEchoes.push(key);
    state.health = Math.max(0, state.health - Math.round(12 + state.floor.echoPressure * 16));
    state.battery = Math.max(0, state.battery - 18);
    state.impactSequence += 1;
    state.lastEvent = "AN ECHO PASSED THROUGH YOU";
  }
  if (samePoint(next, state.floor.exit)) {
    if (state.collected.length < state.floor.fragments.length) state.lastEvent = `EXIT SEALED · ${state.floor.fragments.length - state.collected.length} FRAGMENT${state.floor.fragments.length - state.collected.length === 1 ? "" : "S"} MISSING`;
    else advanceFloor(state);
  }
  if (state.health <= 0) state.gameOver = true;
  else refreshClue(state);
}

function performScan(state: EchoMazeState) {
  state.scanSequence += 1;
  state.battery = Math.max(0, state.battery - 3.5);
  refreshClue(state);
  const scanAngle = Math.atan2(state.scanDirection.x, -state.scanDirection.y);
  const accuracy = angularDistance(scanAngle, state.clue.bearing);
  const quality = accuracy < .42 ? "LOCKED" : accuracy < 1.05 ? "PARTIAL" : "SCATTERED";
  state.lastEvent = `${quality} PING · ${state.clue.target.toUpperCase()} ${state.clue.compass}`;
}

function advanceFloor(state: EchoMazeState) {
  const bonus = Math.max(0, 2_500 - Math.floor((state.elapsed - state.floorStartedAt) * 18));
  state.score += bonus + state.health * 10;
  state.floor = state.director.next();
  state.floorNumber += 1;
  state.player = { ...state.floor.start };
  state.facing = "south";
  state.collected = [];
  state.clearedEchoes = [];
  state.floorStartedAt = state.elapsed;
  state.battery = Math.min(100, state.battery + 32);
  state.health = Math.min(100, state.health + 10);
  state.floorSequence += 1;
  state.lastEvent = `${state.floor.theme.toUpperCase()} · FLOOR ${state.floorNumber}`;
  refreshClue(state);
}

function refreshClue(state: EchoMazeState) {
  const target = state.floor.fragments.find((point) => !state.collected.includes(pointKey(point))) ?? state.floor.exit;
  const targetType = samePoint(target, state.floor.exit) ? "exit" : "fragment";
  const distance = Math.max(0, shortestPath(state.floor, state.player, target).length - 1);
  const echoDistance = state.floor.echoes
    .filter((point) => !state.clearedEchoes.includes(pointKey(point)))
    .reduce((nearest, point) => Math.min(nearest, Math.max(0, shortestPath(state.floor, state.player, point).length - 1)), Number.POSITIVE_INFINITY);
  const bearing = mazeBearing(state.player, target);
  state.clue = {
    target: targetType,
    bearing,
    compass: compassLabel(bearing),
    distance,
    signal: Math.round(100 / (1 + distance * .14)),
    echoDistance: Number.isFinite(echoDistance) ? echoDistance : 99,
    exitLocked: state.collected.length < state.floor.fragments.length,
  };
}

function readAction(ctx: GameContext<EchoMazeState>, action: string) {
  return Boolean(ctx.input.action(action, "role-scanner") || ctx.input.action(action, "player-1"));
}

function readVector(ctx: GameContext<EchoMazeState>, action: string, fallback = action) {
  const role = ctx.input.vector(action, "role-scanner");
  if (Math.hypot(role.x, role.y) > .02) return { x: role.x, y: role.y };
  const semantic = ctx.input.vector(action, "player-1");
  if (Math.hypot(semantic.x, semantic.y) > .02) return { x: semantic.x, y: semantic.y };
  const conventional = ctx.input.vector(fallback, "player-1");
  return { x: conventional.x, y: conventional.y };
}

function directionForVector(vector: { x: number; y: number }): MazeDirection {
  if (Math.abs(vector.x) > Math.abs(vector.y)) return vector.x > 0 ? "east" : "west";
  return vector.y > 0 ? "south" : "north";
}

function emptyClue(floor: EchoFloor): EchoClue { return { target: "fragment", bearing: 0, compass: "N", distance: 0, signal: 0, echoDistance: 99, exitLocked: floor.fragments.length > 0 }; }
function angularDistance(a: number, b: number) { return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))); }
function pointKey(point: MazePoint) { return `${point.x},${point.y}`; }
function samePoint(a: MazePoint, b: MazePoint) { return a.x === b.x && a.y === b.y; }

export default createEchoMazeGame();
