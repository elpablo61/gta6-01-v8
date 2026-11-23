// random.js — deterministic seeded random numbers for Crescent Bay.
//
// The whole city, its traffic and its pedestrians must come out the same
// way every time the game loads with the same seed, so replays, screenshots
// and playtests are reproducible. Every random choice in the game flows
// through this module; nothing here reads Math.random.
//
// The generator is mulberry32, a small fast seeded generator. The
// canonical world seed is 20261118 (see the prose spec, section 1).
// Screenshot poses use their own fixed seed (7) through a second stream
// so a pose never disturbs the world stream.

export const WORLD_SEED = 20261118;
export const SHOT_SEED = 7;

// mulberry32: turns a 32-bit seed into a stream of numbers in [0, 1).
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value = (value + Math.imul(value ^ (value >>> 7), value | 61)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// A small wrapper around one mulberry32 stream with the helpers the game
// needs. Create one per purpose (world, traffic, weather) so streams stay
// independent and a change in one system never shifts another system's
// sequence.
export class SeededRandom {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }

  // Next float in [0, 1).
  float() {
    return this.next();
  }

  // Next float in [min, max).
  range(min, max) {
    return min + this.next() * (max - min);
  }

  // Next integer in [min, max] inclusive.
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  // True with probability p (0..1).
  chance(p) {
    return this.next() < p;
  }

  // One element of a non-empty array, uniformly.
  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }

  // A new array with the elements shuffled (Fisher-Yates). The input is
  // left untouched.
  shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  // A value picked from a weighted table: [[value, weight], ...].
  weighted(entries) {
    let total = 0;
    for (const entry of entries) total += entry[1];
    let roll = this.next() * total;
    for (const entry of entries) {
      roll -= entry[1];
      if (roll <= 0) return entry[0];
    }
    return entries[entries.length - 1][0];
  }

  // Approximately normal value around mean with the given spread,
  // clamped to [min, max] when those are given.
  gaussian(mean, spread, min, max) {
    let value = 0;
    for (let i = 0; i < 3; i++) value += this.next();
    value = mean + ((value - 1.5) / 1.5) * spread;
    if (min !== undefined) value = Math.max(min, value);
    if (max !== undefined) value = Math.min(max, value);
    return value;
  }

  // Restart the stream from its original seed.
  reset() {
    this.next = mulberry32(this.seed);
  }

  // Restart the stream from a new seed.
  reseed(seed) {
    this.seed = seed >>> 0;
    this.reset();
  }
}

// The game's shared streams. `world` builds the city and everything
// placed in it at load; `traffic` drives the ambient cars and walkers so
// their behaviour never shifts the city layout.
export const worldRandom = new SeededRandom(WORLD_SEED);
export const trafficRandom = new SeededRandom(WORLD_SEED + 101);
export const shotRandom = new SeededRandom(SHOT_SEED);

// Convenience helpers bound to the world stream, for one-off calls.
export function randomFloat() {
  return worldRandom.float();
}

export function randomRange(min, max) {
  return worldRandom.range(min, max);
}

export function randomInt(min, max) {
  return worldRandom.int(min, max);
}

export function randomPick(list) {
  return worldRandom.pick(list);
}

// A deterministic hash of two integer coordinates, used to give every
// city block a stable identity (its buildings, its palette) without
// storing a stream per block.
export function hashCoords(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
