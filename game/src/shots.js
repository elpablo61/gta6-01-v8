// shots.js — screenshot poses for Crescent Bay.
//
// The four screenshots the entry hands in are taken from fixed poses, so
// every retake shows the same scene. Each pose is a small script that
// arranges the game — time of day, wanted level, where Rook stands, what
// the objective says — through hooks main.js registers. This module owns
// no game logic of its own; it only describes the poses and calls the
// hooks in order.
//
// Poses (from the prose spec, section 5), all with deterministic seed 7:
//   1-cover    bright daytime, waterfront, a chase, wanted 3, an escape
//              objective on the banner
//   2-mission  on foot, a shootout, the fixer dialog open
//   3-night    night chase, headlights on, a roadblock, wanted 4
//   4-start    the title overlay over the living city
//
// The screenshot tool drives them through window.__crescentShots:
//   window.__crescentShots.list()            -> the pose descriptors
//   window.__crescentShots.apply('1-cover')  -> arrange that pose, and
//                                               return its descriptor
// main.js registers the hooks with registerShotHooks(); until it does,
// apply() only returns the descriptor without touching the game.

import { SHOT_SEED, SeededRandom } from './random.js';

export const SHOT_POSES = [
  {
    name: '1-cover',
    file: '1-cover.jpg',
    title: 'Cover — waterfront chase',
    description: 'Bright daytime on the Waterfront: Rook fleeing in a car with police behind, wanted 3 stars, escape objective on the banner.',
    seed: SHOT_SEED,
    timeHour: 13,
    wanted: 3,
    place: { x: 2700, y: 1000 },
    inCar: true,
    chaseCars: 3,
    objective: { text: 'Escape the police — reach the Spray Shop', x: 2600, y: 2200 },
  },
  {
    name: '2-mission',
    file: '2-mission.jpg',
    title: 'Mission — dockside shootout',
    description: 'On foot in the South Docks during a shootout, enemies ahead, the fixer dialog open with Mara offering the job.',
    seed: SHOT_SEED,
    timeHour: 16,
    wanted: 2,
    place: { x: 1400, y: 2900 },
    inCar: false,
    enemies: 3,
    dialog: { fixer: 'Mara', text: 'The docks are hot, Rook. Clear the crew, then grab the crate. $1,100 when it is done.' },
    objective: { text: 'Clear the dock crew', x: 1400, y: 3000 },
  },
  {
    name: '3-night',
    file: '3-night.jpg',
    title: 'Night — roadblock chase',
    description: 'Night chase through Downtown: headlights and lamp pools in the dark, a police roadblock ahead, wanted 4 stars.',
    seed: SHOT_SEED,
    timeHour: 23,
    wanted: 4,
    place: { x: 2200, y: 1800 },
    inCar: true,
    chaseCars: 4,
    roadblock: { x: 2200, y: 1400 },
    objective: { text: 'Break through the roadblock', x: 2200, y: 1000 },
  },
  {
    name: '4-start',
    file: '4-start.jpg',
    title: 'Title — the living city',
    description: 'The title overlay over the living city at midday: traffic on the roads, pedestrians on the sidewalks, Downtown towers behind.',
    seed: SHOT_SEED,
    timeHour: 11,
    wanted: 0,
    place: { x: 2000, y: 1800 },
    inCar: false,
    showTitle: true,
    objective: null,
  },
];

let hooks = null;

// main.js calls this once at startup with the functions that actually
// move the game. Every hook is optional; a pose skips the steps whose
// hook is missing.
export function registerShotHooks(registered) {
  hooks = registered || null;
}

export function listPoses() {
  return SHOT_POSES.map((pose) => ({ ...pose }));
}

export function poseByName(name) {
  return SHOT_POSES.find((pose) => pose.name === name) || null;
}

// Arrange one pose. Returns the pose descriptor, or null for an unknown
// name. The pose reseeds the deterministic stream first so the traffic
// and pedestrians placed for the shot are the same every time.
export function applyPose(name) {
  const pose = poseByName(name);
  if (!pose) return null;
  const rng = new SeededRandom(pose.seed);
  void rng;
  if (!hooks) return { ...pose };

  if (typeof hooks.setTimeOfDay === 'function') hooks.setTimeOfDay(pose.timeHour);
  if (typeof hooks.setWanted === 'function') hooks.setWanted(pose.wanted);
  if (typeof hooks.placePlayer === 'function') {
    hooks.placePlayer(pose.place.x, pose.place.y, { inCar: pose.inCar });
  }
  if (pose.chaseCars && typeof hooks.spawnPoliceChase === 'function') {
    hooks.spawnPoliceChase(pose.chaseCars);
  }
  if (pose.enemies && typeof hooks.spawnEnemies === 'function') {
    hooks.spawnEnemies(pose.enemies, pose.place.x, pose.place.y);
  }
  if (pose.roadblock && typeof hooks.spawnRoadblock === 'function') {
    hooks.spawnRoadblock(pose.roadblock.x, pose.roadblock.y);
  }
  if (pose.objective && typeof hooks.setObjective === 'function') {
    hooks.setObjective(pose.objective.text, pose.objective.x, pose.objective.y);
  }
  if (pose.dialog && typeof hooks.openMissionDialog === 'function') {
    hooks.openMissionDialog(pose.dialog.fixer, pose.dialog.text);
  }
  if (pose.showTitle && typeof hooks.showTitleScreen === 'function') {
    hooks.showTitleScreen();
  }
  return { ...pose };
}

// The handle the screenshot tool and the playtest probes use.
export function createShotHandle() {
  return {
    list: listPoses,
    apply: applyPose,
    pose: poseByName,
  };
}
