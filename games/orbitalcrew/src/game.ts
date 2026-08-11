import { Game101, type GameContext } from "@101/sdk";
import { OrbitalDirector, type CrewRoleId, type OrbitalEvent } from "./director.ts";

export interface OrbitalCrewState {
  seed: string;
  director: OrbitalDirector;
  events: OrbitalEvent[];
  elapsed: number;
  sector: number;
  shipX: number;
  shipY: number;
  heading: number;
  shieldAngle: number;
  reactorPower: number;
  energy: number;
  heat: number;
  shields: number;
  hull: number;
  score: number;
  combo: number;
  activeThreats: number;
  emergencyCooldown: number;
  lastEvent: string;
  gameOver: boolean;
}

export function createOrbitalCrewGame(seed = "orbitalcrew-101") {
  return Game101.define<OrbitalCrewState>({
    id: "orbitalcrew",
    initialState: () => {
      const state: OrbitalCrewState = {
        seed,
        director: new OrbitalDirector(seed),
        events: [],
        elapsed: 0,
        sector: 1,
        shipX: 0,
        shipY: 0,
        heading: 0,
        shieldAngle: 0,
        reactorPower: .55,
        energy: 100,
        heat: 12,
        shields: 100,
        hull: 100,
        score: 0,
        combo: 0,
        activeThreats: 0,
        emergencyCooldown: 0,
        lastEvent: "CREW STATIONS READY",
        gameOver: false,
      };
      extendSchedule(state);
      return state;
    },
    start(ctx) {
      ["flight", "target", "fire", "shield", "fortify", "power", "vent", "overdrive", "emergency"].forEach((control) => ctx.input.bind(control));
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (state.gameOver) return;
      state.elapsed += delta;
      state.sector = 1 + Math.floor(state.elapsed / 30);
      state.emergencyCooldown = Math.max(0, state.emergencyCooldown - delta);

      const pilot = roleVector(ctx, "flight", "role-pilot", "move");
      const target = roleVector(ctx, "target", "role-weapons", "aim");
      const fire = roleAction(ctx, "fire", "role-weapons", "trigger");
      const shieldAxis = roleAxis(ctx, "shield", "role-shields");
      const fortify = roleAction(ctx, "fortify", "role-shields");
      const requestedPower = roleAxis(ctx, "power", "role-reactor");
      const vent = roleAction(ctx, "vent", "role-reactor");
      const reactorOverdrive = roleAction(ctx, "overdrive", "role-reactor");
      const pilotOverdrive = Boolean(ctx.input.action("overdrive", "role-pilot"));
      const emergency = roleAction(ctx, "emergency", "role-emergency");

      if (Math.abs(requestedPower) > .01) state.reactorPower += (clamp(requestedPower, .2, 1) - state.reactorPower) * Math.min(1, delta * 5);
      state.shipX = clamp(state.shipX + pilot.x * delta * (pilotOverdrive ? .82 : .54), -.88, .88);
      state.shipY = clamp(state.shipY + pilot.y * delta * (pilotOverdrive ? .82 : .54), -.76, .76);
      if (Math.hypot(pilot.x, pilot.y) > .08) state.heading = Math.atan2(pilot.y, pilot.x);
      state.shieldAngle = wrapAngle(state.shieldAngle + shieldAxis * delta * 2.6);

      const powerGain = 5 + state.reactorPower * 7;
      const drain = (fortify ? 6.5 : 0) + (fire ? 3.2 : 0) + (pilotOverdrive ? 4.5 : 0) + (reactorOverdrive ? 5 : 0);
      state.energy = clamp(state.energy + (powerGain - drain) * delta, 0, 100);
      state.heat = clamp(state.heat + (state.reactorPower * 3.2 + drain * .55 - 3.1) * delta, 0, 100);
      if (vent) {
        state.heat = Math.max(0, state.heat - 22 * delta);
        state.energy = Math.max(0, state.energy - 5 * delta);
      }
      if (fortify && state.energy > 1) state.shields = Math.min(100, state.shields + 5 * delta);
      else state.shields = Math.min(100, state.shields + 1.1 * delta);
      if (state.heat > 82) state.hull = Math.max(0, state.hull - (state.heat - 82) * .025 * delta);

      if (emergency && state.emergencyCooldown <= 0) {
        state.shields = Math.min(100, state.shields + 24);
        state.energy = Math.min(100, state.energy + 14);
        state.shipX = 0;
        state.shipY = 0;
        state.emergencyCooldown = 25;
        state.lastEvent = "EMERGENCY RECALL DEPLOYED";
      }

      extendSchedule(state);
      const active = state.events.filter((event) => !event.resolved && event.startAt <= state.elapsed);
      state.activeThreats = active.length;
      for (const event of active) {
        const response = event.requiredRoles.reduce((total, role) => total + roleResponse(role, event, state, {
          pilot,
          target,
          fire,
          fortify,
          vent,
          reactorOverdrive,
        }), 0) / event.requiredRoles.length;
        event.progress = Math.min(1, event.progress + response * delta / (event.duration * .48));
        if (event.progress >= 1) resolveEvent(state, event, true);
        else if (state.elapsed >= event.startAt + event.duration) resolveEvent(state, event, false);
      }
      state.events = state.events.filter((event) => !event.resolved || state.elapsed < event.startAt + event.duration + 8);
      state.score += Math.round(delta * (12 + state.sector * 2) * (1 + state.combo * .08));
      if (state.hull <= 0) {
        state.hull = 0;
        state.gameOver = true;
        state.lastEvent = "SHIP LOST — RUN COMPLETE";
      }
    },
  });
}

interface CrewResponse {
  pilot: { x: number; y: number };
  target: { x: number; y: number };
  fire: boolean;
  fortify: boolean;
  vent: boolean;
  reactorOverdrive: boolean;
}

function roleResponse(role: CrewRoleId, event: OrbitalEvent, state: OrbitalCrewState, input: CrewResponse) {
  if (role === "pilot") return directionMatch(input.pilot, event.bearing);
  if (role === "weapons") return input.fire && state.energy > 0 ? .35 + directionMatch(input.target, event.bearing) * .75 : 0;
  if (role === "shields") {
    const alignment = Math.max(0, Math.cos(wrapAngle(state.shieldAngle - event.bearing)));
    return Math.min(1, alignment * (input.fortify && state.energy > 0 ? 1.25 : .82));
  }
  if (event.kind === "reactor-failure") return input.vent ? 1 : state.reactorPower < .45 ? .55 : .08;
  return Math.min(1, state.reactorPower * .75 + Number(input.reactorOverdrive && state.energy > 0) * .35 - state.heat * .003);
}

function resolveEvent(state: OrbitalCrewState, event: OrbitalEvent, success: boolean) {
  event.resolved = true;
  event.success = success;
  if (success) {
    state.combo += 1;
    state.score += Math.round(180 * (1 + event.severity) * (1 + state.combo * .1));
    state.energy = Math.min(100, state.energy + 4);
    state.lastEvent = `${event.label} CLEARED`;
    return;
  }
  const impact = 12 + event.severity * 24;
  const absorbed = Math.min(state.shields, impact * .72);
  state.shields -= absorbed;
  state.hull = Math.max(0, state.hull - (impact - absorbed));
  state.heat = Math.min(100, state.heat + impact * .32);
  state.combo = 0;
  state.lastEvent = `${event.label} IMPACT`;
}

function extendSchedule(state: OrbitalCrewState) {
  let previousStart = state.events[state.events.length - 1]?.startAt ?? 0;
  while (previousStart < state.elapsed + 42) {
    const event = state.director.next(previousStart);
    state.events.push(event);
    previousStart = event.startAt;
  }
}

function roleVector(ctx: GameContext<OrbitalCrewState>, name: string, playerId: string, fallback: string) {
  const role = ctx.input.vector(name, playerId);
  if (Math.hypot(role.x, role.y) > .015) return role;
  const conventional = ctx.input.vector(name, "player-1");
  if (Math.hypot(conventional.x, conventional.y) > .015) return conventional;
  return ctx.input.vector(fallback, "player-1");
}

function roleAction(ctx: GameContext<OrbitalCrewState>, name: string, playerId: string, fallback = name) {
  return Boolean(ctx.input.action(name, playerId) || ctx.input.action(name, "player-1") || ctx.input.action(fallback, "player-1"));
}

function roleAxis(ctx: GameContext<OrbitalCrewState>, name: string, playerId: string) {
  const role = ctx.input.axis(name, playerId);
  return Math.abs(role) > .001 ? role : ctx.input.axis(name, "player-1");
}

function directionMatch(vector: { x: number; y: number }, bearing: number) {
  const length = Math.hypot(vector.x, vector.y);
  if (length < .12) return 0;
  return Math.max(0, (vector.x * Math.cos(bearing) + vector.y * Math.sin(bearing)) / length);
}

function wrapAngle(value: number) {
  let wrapped = value;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

export default createOrbitalCrewGame();
