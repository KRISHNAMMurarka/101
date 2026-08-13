import assert from "node:assert/strict";
import test from "node:test";
import { SwarmCommanderDirector, validateSwarmWave } from "./director.ts";

test("swarm waves are deterministic, varied, and validated", () => {
  const collect = (seed: string) => { const director = new SwarmCommanderDirector(seed); return Array.from({ length: 30 }, () => director.next()); };
  const first = collect("swarm-daily");
  assert.deepEqual(first, collect("swarm-daily"));
  assert.notDeepEqual(first, collect("swarm-friend"));
  assert.equal(first.every(validateSwarmWave), true);
  assert.ok(new Set(first.flatMap((wave) => wave.enemies.map((enemy) => enemy.type))).size >= 5);
  assert.ok(new Set(first.map((wave) => wave.modifier)).size >= 3);
});

test("hive bosses recur without unbounded wave payloads", () => {
  const director = new SwarmCommanderDirector("boss-cycle");
  const waves = Array.from({ length: 40 }, () => director.next());
  assert.deepEqual(waves.filter((wave) => wave.boss).map((wave) => wave.id), [8, 16, 24, 32, 40]);
  assert.ok(Math.max(...waves.map((wave) => wave.enemies.length)) <= 28);
  assert.ok(waves.every((wave, index) => index === 0 || wave.startsAt > waves[index - 1]!.startsAt));
});
