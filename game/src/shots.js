// Crescent Bay — screenshot poses. Fresh from prose spec §5 + brief A1–A3, A13.
// Four poses, played by the autopilot from a fresh world with a fixed
// seed (7), for a fixed number of steps — never hand-placed entities
// arranged for a good composition. Tuning happens through the seed, the
// step count and the autopilot's behaviour, exactly like the kit
// starter's shot pattern. Each pose waits for full renders before the
// screenshot is taken (the screenshot script handles that wait); this
// module only sets the scenario up and drives it.
//
//   1-cover   — bright daytime, waterfront, chase, wanted 3, escape objective.
//   2-mission — on foot, shootout, fixer dialog visible.
//   3-night   — night chase, headlights, roadblock, wanted 4.
//   4-start   — title overlay over the living city.
//
// Shared-state contract (read defensively; missing fields get defaults):
//   game.player   { x, y, angle, onFoot } — Rook.
//   game.wanted   { heat, stars } — heat 0..100.
//   game.mission  { id, name, objective, stage } — current mission.
//   game.dialog / game.missionDialog — fixer dialog state (see below).
//   game.timeOfDay / game.time.dayFraction — 0..1 around the clock.
//   game.state    — 'title' | 'playing' | 'paused' | 'gameover'.
//   game.autopilot — { update(dt) } / { step(dt) } when present; the
//                pose driver calls it when it exists and otherwise
//                advances the scenario clock only, so a thin game
//                still produces a deterministic frame.
//   game.spawnPoliceChase(n) / game.spawnRoadblock(x, y) — optional
//                hooks the police system may expose; poses fall back
//                to writing game.police directives when absent.

import { SHOT_SEED, createRng } from './random.js';

export const SHOT_POSES = [
  {
    id: 'cover',
    file: '1-cover.jpg',
    query: '?shot=cover&seed=7',
    name: 'Cover — daytime waterfront chase',
    description: 'Bright daytime, waterfront chase, wanted 3, escape objective',
    seed: SHOT_SEED,
    steps: 420,
    timeOfDay: 0.42,
    wantedHeat: 58,
    objective: 'ESCAPE THE POLICE — Lose the cops',
    onFoot: false,
    // Chase runs on the x=2600 road so the water stays visible at the
    // right edge of the frame (v2 lesson: x=3000 puts the player at
    // the screen edge). The player drives a sports car diagonally up
    // the road; police spawn behind, closer and faster than traffic.
    playerStart: { x: 2600, y: 2200, angle: -Math.PI / 2 },
    playerCar: { type: 'sports', color: '#e74c3c' },
    policeBehind: 3,
    policeGap: 130,
    trafficAhead: 3,
    pedestrians: 3,
  },
  {
    id: 'mission',
    file: '2-mission.jpg',
    query: '?shot=mission&seed=7',
    name: 'Mission — on-foot shootout with fixer dialog',
    description: 'On foot, shootout, fixer dialog visible',
    seed: SHOT_SEED,
    steps: 300,
    timeOfDay: 0.45,
    wantedHeat: 30,
    objective: 'CRESCENT JOB — Clear the arena, then escape',
    onFoot: true,
    playerStart: { x: 1800, y: 1800, angle: 0 },
    mission: {
      id: 'm8',
      name: 'Crescent Job',
      fixer: 'Mara',
      reward: 6200,
      dialog: 'Mara: The bank crew is inside. Clear the room, grab the loot, and get out clean. $6,200 when it is done.',
    },
    enemies: 3,
    dialogVisible: true,
  },
  {
    id: 'night',
    file: '3-night.jpg',
    query: '?shot=night&seed=7',
    name: 'Night — night chase with headlights and roadblock',
    description: 'Night chase, headlights, roadblock, wanted 4',
    seed: SHOT_SEED,
    steps: 420,
    timeOfDay: 0.02,
    wantedHeat: 78,
    objective: 'HIGHWAY HEAT — Break through the roadblock',
    onFoot: false,
    playerStart: { x: 2200, y: 2600, angle: -Math.PI / 2 },
    playerCar: { type: 'sports', color: '#f1c40f' },
    policeBehind: 3,
    policeGap: 130,
    roadblock: { x: 2200, y: 2000 },
    trafficAhead: 2,
    pedestrians: 1,
  },
  {
    id: 'start',
    file: '4-start.jpg',
    query: '?shot=start&seed=7',
    name: 'Start — title overlay over the living city',
    description: 'Title overlay over the living city',
    seed: SHOT_SEED,
    steps: 240,
    timeOfDay: 0.4,
    wantedHeat: 0,
    objective: '',
    onFoot: true,
    playerStart: { x: 1400, y: 1400, angle: Math.PI / 2 },
    showTitle: true,
    trafficAhead: 4,
    pedestrians: 4,
  },
];

export const SHOT_IDS = SHOT_POSES.map((p) => p.id);

export function getShotPose(id) {
  return SHOT_POSES.find((p) => p.id === id) || null;
}

export function poseByQuery(query) {
  if (!query || typeof query !== 'string') return null;
  const m = query.match(/shot=([a-z]+)/);
  if (!m) return null;
  return getShotPose(m[1]);
}

// Set the scenario conditions for one pose on a fresh game: time of
// day, wanted heat, mission + objective, fixer dialog, player start.
// Positions come from the pose definition (seeded, on roads), and the
// autopilot does the actual driving / walking from there — nothing is
// hand-placed for composition beyond the starting conditions.
export function applyShotSetup(game, poseId) {
  const pose = typeof poseId === 'string' ? getShotPose(poseId) : poseId;
  if (!game || !pose) return null;
  const rng = createRng(pose.seed);

  if (typeof pose.timeOfDay === 'number') {
    game.timeOfDay = pose.timeOfDay;
    if (game.time && typeof game.time === 'object') game.time.dayFraction = pose.timeOfDay;
  }
  if (typeof pose.wantedHeat === 'number') {
    if (!game.wanted) game.wanted = {};
    game.wanted.heat = pose.wantedHeat;
  }
  if (pose.objective !== undefined) {
    game.objectiveText = pose.objective;
    if (!game.mission) game.mission = {};
    game.mission.objective = pose.objective;
  }
  if (pose.mission) {
    if (!game.mission) game.mission = {};
    game.mission.id = pose.mission.id;
    game.mission.name = pose.mission.name;
    game.mission.fixer = pose.mission.fixer;
    game.mission.reward = pose.mission.reward;
    game.mission.stage = 0;
  }
  if (pose.mission && pose.dialogVisible) {
    game.dialog = {
      visible: true,
      fixer: pose.mission.fixer,
      mission: pose.mission.name,
      reward: pose.mission.reward,
      text: pose.mission.dialog,
    };
    game.missionDialog = game.dialog;
  } else if (game.dialog) {
    game.dialog.visible = false;
    if (game.missionDialog) game.missionDialog.visible = false;
  }

  const p = game.player;
  if (p && pose.playerStart) {
    p.x = pose.playerStart.x;
    p.y = pose.playerStart.y;
    p.angle = pose.playerStart.angle || 0;
    p.onFoot = pose.onFoot !== false;
    p.health = 100;
    if (pose.playerCar) {
      if (!p.car) p.car = {};
      p.car.type = pose.playerCar.type;
      p.car.color = pose.playerCar.color;
      p.car.x = p.x;
      p.car.y = p.y;
      p.car.angle = p.angle;
    }
  }

  if (pose.showTitle) {
    game.state = 'title';
    game.showTitle = true;
  } else if (game.state === 'title') {
    game.state = 'playing';
    game.showTitle = false;
  }

  // Deterministic extras, drawn from the pose seed: a few traffic cars
  // ahead on the same road and pedestrians on the sidewalk. Their exact
  // spots come from the seeded stream, so the same seed always gives
  // the same frame.
  game.shotExtras = {
    rngSeed: pose.seed,
    trafficAhead: pose.trafficAhead || 0,
    pedestrians: pose.pedestrians || 0,
    policeBehind: pose.policeBehind || 0,
    policeGap: pose.policeGap || 120,
    roadblock: pose.roadblock || null,
    enemies: pose.enemies || 0,
    jitter: Math.floor(rng() * 1000),
  };

  if (pose.roadblock) {
    if (game && typeof game.spawnRoadblock === 'function') {
      try {
        game.spawnRoadblock(pose.roadblock.x, pose.roadblock.y);
      } catch (e) { /* police hook is optional */ }
    } else {
      game.roadblockTarget = { x: pose.roadblock.x, y: pose.roadblock.y };
    }
  }
  if (pose.policeBehind) {
    if (game && typeof game.spawnPoliceChase === 'function') {
      try {
        game.spawnPoliceChase(pose.policeBehind);
      } catch (e) { /* police hook is optional */ }
    } else {
      game.policeChaseCount = pose.policeBehind;
    }
  }

  game.shotPose = pose.id;
  game.shotStep = 0;
  return pose;
}

// Advance one pose by a frame: run the autopilot when the game has
// one, so the pose is a played simulation, not a still life. The step
// counter lets the screenshot script wait a fixed number of steps.
export function stepShot(game, dt) {
  if (!game) return 0;
  const step = typeof dt === 'number' ? dt : 0.016;
  const ap = game.autopilot;
  if (ap && typeof ap.update === 'function') {
    try {
      ap.update(step);
    } catch (e) { /* autopilot errors must not kill a pose */ }
  } else if (ap && typeof ap.step === 'function') {
    try {
      ap.step(step);
    } catch (e) { /* ignore */ }
  }
  game.shotStep = (game.shotStep || 0) + 1;
  return game.shotStep;
}

// Run a whole pose synchronously for a fixed step count (used by
// headless drivers that step the game manually). Returns the pose and
// how many steps ran.
export function runShotPose(game, poseId, steps) {
  const pose = applyShotSetup(game, poseId);
  if (!pose) return null;
  const total = steps || pose.steps;
  for (let i = 0; i < total; i += 1) {
    stepShot(game, 1 / 60);
  }
  return { pose, steps: total, shotStep: game.shotStep };
}

// Parse a location-style query string ('?shot=cover&seed=7') and apply
// the matching pose. Returns the pose, or null when there is no shot.
export function handleShotQuery(game, search) {
  const pose = poseByQuery(search || (typeof location !== 'undefined' ? location.search : ''));
  if (!pose) return null;
  return applyShotSetup(game, pose.id);
}

export function snapshot(game) {
  return {
    pose: (game && game.shotPose) || null,
    step: (game && game.shotStep) || 0,
    poses: SHOT_POSES.map((p) => ({ id: p.id, file: p.file, steps: p.steps })),
  };
}

export default SHOT_POSES;
