export interface SwarmPoint { x: number; y: number }
export interface SwarmAgent extends SwarmPoint { id: string; vx: number; vy: number; selected?: boolean }
export type FormationKind = "cluster" | "line" | "wedge" | "ring" | "grid";

export interface SwarmCommand {
  target: SwarmPoint;
  direction?: SwarmPoint;
  formation: FormationKind;
  spacing?: number;
  heading?: number;
}

export interface SwarmStepOptions {
  maxSpeed?: number;
  acceleration?: number;
  stiffness?: number;
  separationRadius?: number;
  separationStrength?: number;
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
}

const DEFAULTS: Required<Omit<SwarmStepOptions, "bounds">> = {
  maxSpeed: 7,
  acceleration: 22,
  stiffness: 2.4,
  separationRadius: .34,
  separationStrength: 4.5,
};

/**
 * Produces centered deterministic slots. Rotating the heading never changes an
 * agent's slot index, which keeps formations stable while steering.
 */
export function formationSlots(kind: FormationKind, count: number, spacing = .42, heading = 0): SwarmPoint[] {
  const safeCount = Math.max(0, Math.floor(count));
  const safeSpacing = Math.max(.05, spacing);
  const raw = Array.from({ length: safeCount }, (_, index) => rawSlot(kind, index, safeCount, safeSpacing));
  if (!raw.length) return raw;
  const center = raw.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
  center.x /= raw.length; center.y /= raw.length;
  const cosine = Math.cos(heading); const sine = Math.sin(heading);
  return raw.map((point) => {
    const x = point.x - center.x; const y = point.y - center.y;
    return { x: x * cosine - y * sine, y: x * sine + y * cosine };
  });
}

/** Mutates agents in place to avoid per-frame allocation for large swarms. */
export function stepSwarm(agents: SwarmAgent[], command: SwarmCommand, deltaSeconds: number, options: SwarmStepOptions = {}) {
  if (!agents.length || deltaSeconds <= 0) return agents;
  const delta = Math.min(.05, deltaSeconds);
  const settings = { ...DEFAULTS, ...options };
  const direction = normalize(command.direction ?? { x: 0, y: 0 });
  const heading = command.heading ?? (direction.x || direction.y ? Math.atan2(direction.y, direction.x) : 0);
  const slots = formationSlots(command.formation, agents.length, command.spacing, heading);
  const grid = spatialGrid(agents, settings.separationRadius);
  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index]!; const slot = slots[index]!;
    const desiredX = (command.target.x + slot.x - agent.x) * settings.stiffness + direction.x * settings.maxSpeed * .35;
    const desiredY = (command.target.y + slot.y - agent.y) * settings.stiffness + direction.y * settings.maxSpeed * .35;
    const separation = separationForce(agent, grid, settings.separationRadius);
    const desired = clampVector({ x: desiredX + separation.x * settings.separationStrength, y: desiredY + separation.y * settings.separationStrength }, settings.maxSpeed);
    const acceleration = clampVector({ x: desired.x - agent.vx, y: desired.y - agent.vy }, settings.acceleration * delta);
    agent.vx += acceleration.x; agent.vy += acceleration.y;
    const velocity = clampVector({ x: agent.vx, y: agent.vy }, settings.maxSpeed);
    agent.vx = velocity.x; agent.vy = velocity.y;
    agent.x += agent.vx * delta; agent.y += agent.vy * delta;
    if (settings.bounds) {
      if (agent.x < settings.bounds.minX || agent.x > settings.bounds.maxX) agent.vx *= -.35;
      if (agent.y < settings.bounds.minY || agent.y > settings.bounds.maxY) agent.vy *= -.35;
      agent.x = clamp(agent.x, settings.bounds.minX, settings.bounds.maxX);
      agent.y = clamp(agent.y, settings.bounds.minY, settings.bounds.maxY);
    }
  }
  return agents;
}

export function selectInRadius(agents: SwarmAgent[], point: SwarmPoint, radius: number, mode: "replace" | "add" | "remove" = "replace") {
  const radiusSquared = Math.max(0, radius) ** 2;
  let selected = 0;
  for (const agent of agents) {
    const inside = (agent.x - point.x) ** 2 + (agent.y - point.y) ** 2 <= radiusSquared;
    if (mode === "replace") agent.selected = inside;
    else if (mode === "add" && inside) agent.selected = true;
    else if (mode === "remove" && inside) agent.selected = false;
    if (agent.selected) selected += 1;
  }
  return selected;
}

export function swarmCentroid(agents: readonly SwarmPoint[]): SwarmPoint {
  if (!agents.length) return { x: 0, y: 0 };
  const center = agents.reduce((total, agent) => ({ x: total.x + agent.x, y: total.y + agent.y }), { x: 0, y: 0 });
  return { x: center.x / agents.length, y: center.y / agents.length };
}

function rawSlot(kind: FormationKind, index: number, count: number, spacing: number): SwarmPoint {
  if (kind === "line") {
    const columns = Math.min(count, Math.ceil(Math.sqrt(count) * 1.7));
    const row = Math.floor(index / columns); const column = index % columns; const rowCount = Math.min(columns, count - row * columns);
    return { x: -row * spacing * .62, y: (column - (rowCount - 1) / 2) * spacing };
  }
  if (kind === "grid") {
    const columns = Math.ceil(Math.sqrt(count));
    return { x: (index % columns) * spacing, y: Math.floor(index / columns) * spacing };
  }
  if (kind === "wedge") {
    const row = Math.floor(Math.sqrt(index)); const start = row * row; const within = index - start;
    return { x: -row * spacing * .72, y: (within - row) * spacing };
  }
  if (kind === "ring") {
    if (index === 0) return { x: 0, y: 0 };
    const ring = Math.ceil((Math.sqrt(index + 1) - 1) / 2); const prior = (2 * ring - 1) ** 2;
    const inRing = index - prior; const capacity = Math.max(8, ring * 8); const angle = inRing / capacity * Math.PI * 2;
    return { x: Math.cos(angle) * ring * spacing * 1.45, y: Math.sin(angle) * ring * spacing * 1.45 };
  }
  const angle = index * 2.399963229728653; const radius = Math.sqrt(index) * spacing * .66;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function spatialGrid(agents: readonly SwarmAgent[], cellSize: number) {
  const grid = new Map<string, SwarmAgent[]>();
  for (const agent of agents) {
    const key = cellKey(agent.x, agent.y, cellSize); const bucket = grid.get(key) ?? [];
    bucket.push(agent); grid.set(key, bucket);
  }
  return grid;
}

function separationForce(agent: SwarmAgent, grid: Map<string, SwarmAgent[]>, radius: number) {
  const cellX = Math.floor(agent.x / radius); const cellY = Math.floor(agent.y / radius);
  let x = 0; let y = 0;
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
    for (const neighbor of grid.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? []) {
      if (neighbor === agent) continue;
      const dx = agent.x - neighbor.x; const dy = agent.y - neighbor.y; const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared <= 1e-8 || distanceSquared >= radius * radius) continue;
      const distance = Math.sqrt(distanceSquared); const pressure = 1 - distance / radius;
      x += dx / distance * pressure; y += dy / distance * pressure;
    }
  }
  return { x, y };
}

function cellKey(x: number, y: number, cellSize: number) { return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`; }
function normalize(point: SwarmPoint) { const length = Math.hypot(point.x, point.y); return length > 1 ? { x: point.x / length, y: point.y / length } : { x: point.x, y: point.y }; }
function clampVector(point: SwarmPoint, maximum: number) { const length = Math.hypot(point.x, point.y); return length > maximum && length > 0 ? { x: point.x / length * maximum, y: point.y / length * maximum } : point; }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }
