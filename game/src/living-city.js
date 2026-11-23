// living-city.js — Living city depth (prose spec §3.6, stretch).
// Pedestrian variety (different colours and walking speeds, some in
// pairs); more parked-car colour variety; traffic density varies by
// time of day (busier at midday, quieter at night). This module only
// provides the variety/density rules — the world, traffic and
// pedestrian systems own spawning and movement. It must never delay
// the core systems; it is pure depth.

export const PEDESTRIAN_COLORS = [
  '#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#7b2cbf',
  '#457b9d', '#ef476f', '#06d6a0', '#ffd166', '#8d99ae',
];

export const PARKED_CAR_COLORS = [
  '#c1121f', '#1d3557', '#f48c06', '#2a9d8f', '#7b2cbf',
  '#edf2f4', '#6c757d', '#90be6d', '#f9c74f', '#43aa8b',
  '#577590', '#f3722c', '#9d4edd', '#80ed99',
];

// Traffic density multiplier by hour of day (0-23).
// Busier at midday, quieter at night.
export function trafficDensityForHour(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 7 && h < 10) return 0.85;   // morning rush
  if (h >= 10 && h < 16) return 1.0;   // midday — busiest
  if (h >= 16 && h < 19) return 0.9;   // evening rush
  if (h >= 19 && h < 22) return 0.6;   // evening
  if (h >= 22 || h < 5) return 0.3;    // night — quietest
  return 0.55;                          // early morning
}

// Pedestrian variety: a random look + walk speed, drawn from the
// deterministic RNG the caller passes in (mulberry32, seed 20261118).
// Some pedestrians walk in pairs — the caller spawns a companion with
// the same destination and a small offset when `inPair` is true.
export function randomPedestrianLook(rng) {
  const inPair = rng() < 0.25; // ~1 in 4 pedestrians walks in a pair
  return {
    color: PEDESTRIAN_COLORS[Math.floor(rng() * PEDESTRIAN_COLORS.length)],
    // Walk speeds vary: slow strollers to brisk walkers.
    walkSpeed: 38 + rng() * 42, // 38..80 units/s
    inPair,
    // Pair partners walk shoulder to shoulder, slightly offset.
    pairOffsetX: inPair ? (rng() < 0.5 ? -16 : 16) : 0,
    pairOffsetY: inPair ? (rng() < 0.5 ? -10 : 10) : 0,
    // Shirt/pants split so two pedestrians rarely look identical.
    pantsColor: PEDESTRIAN_COLORS[Math.floor(rng() * PEDESTRIAN_COLORS.length)],
  };
}

export function randomParkedCarColor(rng) {
  return PARKED_CAR_COLORS[Math.floor(rng() * PARKED_CAR_COLORS.length)];
}

// How many traffic cars the city wants on the road right now, given
// the hour and the baseline count the world was built with.
export function desiredTrafficCount(baselineCount, hour) {
  return Math.max(4, Math.round(baselineCount * trafficDensityForHour(hour)));
}

// How many pedestrians the city wants out walking right now.
export function desiredPedestrianCount(baselineCount, hour) {
  return Math.max(2, Math.round(baselineCount * trafficDensityForHour(hour)));
}
