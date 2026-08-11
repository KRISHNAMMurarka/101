import { SeededRandom } from "@101/core";

export type MazeDirection = "north" | "east" | "south" | "west";

export interface MazePoint { x: number; y: number }
export interface MazeCell extends MazePoint { walls: number }
export interface MazeFloor {
  seed: string;
  level: number;
  width: number;
  height: number;
  cells: MazeCell[];
  start: MazePoint;
  exit: MazePoint;
  fragments: MazePoint[];
  echoes: MazePoint[];
}

const WALL: Record<MazeDirection, number> = { north: 1, east: 2, south: 4, west: 8 };
const STEP: Record<MazeDirection, MazePoint> = { north: { x: 0, y: -1 }, east: { x: 1, y: 0 }, south: { x: 0, y: 1 }, west: { x: -1, y: 0 } };
const OPPOSITE: Record<MazeDirection, MazeDirection> = { north: "south", east: "west", south: "north", west: "east" };
export const MAZE_DIRECTIONS = Object.keys(WALL) as MazeDirection[];

export function generateMaze(seed: string, level = 1): MazeFloor {
  const random = new SeededRandom(`${seed}:floor:${level}`);
  const width = Math.min(15, 7 + Math.floor((level - 1) / 2) * 2);
  const height = Math.min(13, 7 + Math.floor((level - 1) / 3) * 2);
  const cells = Array.from({ length: width * height }, (_, index): MazeCell => ({ x: index % width, y: Math.floor(index / width), walls: 15 }));
  const start = { x: 0, y: 0 };
  const visited = new Set([pointKey(start)]);
  const stack: MazePoint[] = [start];
  while (stack.length) {
    const current = stack.at(-1)!;
    const choices = shuffle(MAZE_DIRECTIONS, random).filter((direction) => {
      const next = offset(current, direction);
      return contains(width, height, next) && !visited.has(pointKey(next));
    });
    const direction = choices[0];
    if (!direction) { stack.pop(); continue; }
    const next = offset(current, direction);
    cellAtRaw(cells, width, current).walls &= ~WALL[direction];
    cellAtRaw(cells, width, next).walls &= ~WALL[OPPOSITE[direction]];
    visited.add(pointKey(next));
    stack.push(next);
  }
  const shell: MazeFloor = { seed, level, width, height, cells, start, exit: start, fragments: [], echoes: [] };
  const distances = breadthFirstDistances(shell, start);
  const ordered = [...distances.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const exit = parsePoint(ordered[0]![0]);
  const candidates = ordered.map(([key]) => parsePoint(key)).filter((point) => !samePoint(point, start) && !samePoint(point, exit));
  const fragments = pickSeparated(candidates, 2 + Math.min(2, Math.floor(level / 4)), random, [start, exit]);
  const echoes = pickSeparated(candidates.filter((point) => !fragments.some((fragment) => samePoint(point, fragment))), Math.min(3, 1 + Math.floor(level / 3)), random, [start, exit, ...fragments]);
  return { ...shell, exit, fragments, echoes };
}

export function cellAt(floor: MazeFloor, point: MazePoint) {
  return contains(floor.width, floor.height, point) ? floor.cells[point.y * floor.width + point.x] : undefined;
}

export function canTravel(floor: MazeFloor, point: MazePoint, direction: MazeDirection) {
  const cell = cellAt(floor, point);
  return Boolean(cell && (cell.walls & WALL[direction]) === 0 && contains(floor.width, floor.height, offset(point, direction)));
}

export function travel(floor: MazeFloor, point: MazePoint, direction: MazeDirection) {
  return canTravel(floor, point, direction) ? offset(point, direction) : { ...point };
}

export function shortestPath(floor: MazeFloor, from: MazePoint, to: MazePoint) {
  const queue: MazePoint[] = [{ ...from }];
  const previous = new Map<string, string | undefined>([[pointKey(from), undefined]]);
  while (queue.length) {
    const point = queue.shift()!;
    if (samePoint(point, to)) break;
    for (const direction of MAZE_DIRECTIONS) {
      if (!canTravel(floor, point, direction)) continue;
      const next = offset(point, direction);
      const key = pointKey(next);
      if (previous.has(key)) continue;
      previous.set(key, pointKey(point));
      queue.push(next);
    }
  }
  if (!previous.has(pointKey(to))) return [];
  const path: MazePoint[] = [];
  let cursor: string | undefined = pointKey(to);
  while (cursor) { path.unshift(parsePoint(cursor)); cursor = previous.get(cursor); }
  return path;
}

export function mazeBearing(from: MazePoint, to: MazePoint) {
  return Math.atan2(to.x - from.x, from.y - to.y);
}

export function compassLabel(angle: number) {
  const index = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][index]!;
}

export function validateMaze(floor: MazeFloor) {
  if (floor.cells.length !== floor.width * floor.height || floor.width < 3 || floor.height < 3) return false;
  const reachable = breadthFirstDistances(floor, floor.start);
  if (reachable.size !== floor.cells.length || shortestPath(floor, floor.start, floor.exit).length < 2) return false;
  for (const cell of floor.cells) {
    for (const direction of MAZE_DIRECTIONS) {
      const next = offset(cell, direction);
      if (!contains(floor.width, floor.height, next)) {
        if ((cell.walls & WALL[direction]) === 0) return false;
        continue;
      }
      const neighbor = cellAt(floor, next)!;
      const open = (cell.walls & WALL[direction]) === 0;
      const reverseOpen = (neighbor.walls & WALL[OPPOSITE[direction]]) === 0;
      if (open !== reverseOpen) return false;
    }
  }
  return true;
}

function breadthFirstDistances(floor: MazeFloor, start: MazePoint) {
  const distances = new Map<string, number>([[pointKey(start), 0]]);
  const queue: MazePoint[] = [{ ...start }];
  while (queue.length) {
    const point = queue.shift()!;
    const distance = distances.get(pointKey(point))!;
    for (const direction of MAZE_DIRECTIONS) {
      if (!canTravel(floor, point, direction)) continue;
      const next = offset(point, direction);
      const key = pointKey(next);
      if (distances.has(key)) continue;
      distances.set(key, distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

function pickSeparated(candidates: MazePoint[], count: number, random: SeededRandom, excluded: MazePoint[]) {
  const pool = shuffle(candidates, random);
  const selected: MazePoint[] = [];
  for (const point of pool) {
    if ([...excluded, ...selected].some((other) => Math.abs(point.x - other.x) + Math.abs(point.y - other.y) < 3)) continue;
    selected.push(point);
    if (selected.length === count) break;
  }
  return selected;
}

function shuffle<T>(values: readonly T[], random: SeededRandom) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random.next() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function contains(width: number, height: number, point: MazePoint) { return point.x >= 0 && point.y >= 0 && point.x < width && point.y < height; }
function offset(point: MazePoint, direction: MazeDirection) { const step = STEP[direction]; return { x: point.x + step.x, y: point.y + step.y }; }
function cellAtRaw(cells: MazeCell[], width: number, point: MazePoint) { return cells[point.y * width + point.x]!; }
function pointKey(point: MazePoint) { return `${point.x},${point.y}`; }
function parsePoint(key: string) { const [x, y] = key.split(",").map(Number); return { x: x!, y: y! }; }
function samePoint(a: MazePoint, b: MazePoint) { return a.x === b.x && a.y === b.y; }
