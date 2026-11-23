// Crescent Bay — deterministic random numbers.
// Every random choice in the city, the traffic and the screenshots comes
// from this one generator so a fresh world always looks the same.
// mulberry32 is a tiny, fast, well-known seeded generator: the same seed
// always produces the same stream of numbers, on every machine.

export const WORLD_SEED = 20261118;
export const SHOT_SEED = 7;

// mulberry32(seed) -> function that returns a float in [0, 1).
// The seed is kept as an unsigned 32-bit integer; each call advances it
// by a fixed odd constant and mixes the bits before scaling to [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function nextRandom() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// createRng(seed) is the friendly factory name for the same generator.
// makeRng is kept as a short alias so other modules can use either name.
export function createRng(seed = WORLD_SEED) {
  return mulberry32(seed);
}

export function makeRng(seed = WORLD_SEED) {
  return mulberry32(seed);
}

// Rng wraps a mulberry32 stream with the helpers the game actually needs:
// ranges, integers, picking from a list and shuffling. One Rng instance
// owns one stream, so callers that need independent streams make their
// own instance with a different seed instead of sharing one.
export class Rng {
  constructor(seed = WORLD_SEED) {
    this.next = mulberry32(seed);
    this.seed = seed >>> 0;
  }

  // A float in [0, 1).
  float() {
    return this.next();
  }

  // A float in [min, max).
  range(min, max) {
    return min + (max - min) * this.next();
  }

  // An integer in [min, max] inclusive.
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  // True with the given probability (0..1).
  chance(p) {
    return this.next() < p;
  }

  // One random element of a non-empty array.
  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }

  // A shuffled copy of the list (Fisher-Yates); the original is untouched.
  shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }
}

// Standalone helpers for callers that already hold a raw stream function
// instead of an Rng instance.
export function randRange(rng, min, max) {
  return min + (max - min) * rng();
}

export function randInt(rng, min, max) {
  return Math.floor(randRange(rng, min, max + 1));
}

export function randPick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

// A fresh Rng for the world generator. The world module owns its own
// instance; gameplay code that needs randomness should create its own
// Rng with an explicit seed so streams never interfere with each other.
export function worldRng() {
  return new Rng(WORLD_SEED);
}
