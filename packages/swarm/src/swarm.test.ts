import assert from "node:assert/strict";
import test from "node:test";
import { formationSlots, selectInRadius, stepSwarm, swarmCentroid, type FormationKind, type SwarmAgent } from "./index.ts";

const FORMATIONS: FormationKind[] = ["cluster", "line", "wedge", "ring", "grid"];

test("all formation grammars produce stable centered slots", () => {
  for (const formation of FORMATIONS) {
    const first = formationSlots(formation, 257, .4, .73);
    assert.equal(first.length, 257);
    assert.deepEqual(first, formationSlots(formation, 257, .4, .73));
    const center = swarmCentroid(first);
    assert.ok(Math.abs(center.x) < 1e-10);
    assert.ok(Math.abs(center.y) < 1e-10);
    assert.equal(first.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)), true);
    assert.ok(Math.max(...formationSlots(formation, 280, .4).map((point) => Math.hypot(point.x, point.y))) < 9);
  }
});

test("spatial steering remains bounded for hundreds of agents", () => {
  const agents: SwarmAgent[] = Array.from({ length: 420 }, (_, index) => ({ id: `unit-${index}`, x: (index % 21) * .06, y: Math.floor(index / 21) * .06, vx: 0, vy: 0 }));
  for (let frame = 0; frame < 180; frame += 1) stepSwarm(agents, { target: { x: 8, y: -4 }, direction: { x: 1, y: -.2 }, formation: "wedge" }, 1 / 60, { maxSpeed: 5, bounds: { minX: -10, maxX: 10, minY: -8, maxY: 8 } });
  assert.equal(agents.every((agent) => Math.hypot(agent.vx, agent.vy) <= 5.000001), true);
  assert.equal(agents.every((agent) => agent.x >= -10 && agent.x <= 10 && agent.y >= -8 && agent.y <= 8), true);
  assert.ok(swarmCentroid(agents).x > 2);
});

test("radius selection composes replace, add, and remove modes", () => {
  const agents: SwarmAgent[] = [
    { id: "a", x: 0, y: 0, vx: 0, vy: 0 },
    { id: "b", x: 1, y: 0, vx: 0, vy: 0 },
    { id: "c", x: 4, y: 0, vx: 0, vy: 0 },
  ];
  assert.equal(selectInRadius(agents, { x: 0, y: 0 }, 1.1), 2);
  assert.equal(selectInRadius(agents, { x: 4, y: 0 }, .2, "add"), 3);
  assert.equal(selectInRadius(agents, { x: 1, y: 0 }, .2, "remove"), 2);
  assert.deepEqual(agents.filter((agent) => agent.selected).map((agent) => agent.id), ["a", "c"]);
});
