// Crescent Bay — central tuning constants for the whole game.
// Every other module reads its numbers from here so the world, the
// wanted system, the cars and the mission rewards always agree.

const GAME_TITLE = 'Crescent Bay';
const WORLD_SEED = 20261118;

const WORLD_W = 3200;
const WORLD_H = 3200;

const CANVAS_W = 1280;
const CANVAS_H = 800;

const ROAD_COUNT = 8;
const ROAD_SPACING = 400;
const ROAD_FIRST = 200;
const ROAD_WIDTH = 64;
const ROAD_HALF = ROAD_WIDTH / 2;

function roadPosition(index) {
  return ROAD_FIRST + index * ROAD_SPACING;
}

const ROAD_POSITIONS = [];
for (let i = 0; i < ROAD_COUNT; i++) ROAD_POSITIONS.push(roadPosition(i));

const DISTRICTS = [
  {
    id: 'northside',
    name: 'Northside',
    x0: 0, y0: 0, x1: 1600, y1: 1000,
    style: 'houses',
    palette: ['#e8c9a0', '#d9b48a', '#cfa87e', '#e2d3b8'],
    roof: ['#a8543c', '#7a5a44', '#96503a', '#8a6a4a'],
    maxHeight: 2,
  },
  {
    id: 'oldtown',
    name: 'Old Town',
    x0: 0, y0: 1000, x1: 1600, y1: 2200,
    style: 'brick',
    palette: ['#b06a4a', '#9c5a40', '#a87252', '#8f5f45'],
    roof: ['#5e3a2e', '#6b4536', '#54402f'],
    maxHeight: 4,
  },
  {
    id: 'downtown',
    name: 'Downtown',
    x0: 1600, y0: 0, x1: 3060, y1: 1600,
    style: 'glass',
    palette: ['#7fa8c8', '#6d9ab8', '#8fb4cc', '#5f8aa8'],
    roof: ['#3a5a74', '#46667e', '#2f4a60'],
    maxHeight: 12,
  },
  {
    id: 'waterfront',
    name: 'Waterfront',
    x0: 1600, y0: 1600, x1: 3060, y1: 3200,
    style: 'sand',
    palette: ['#e8d9ae', '#dfcfa0', '#e2d6b4', '#d8c795'],
    roof: ['#b08a5a', '#a07a4a', '#c09a68'],
    maxHeight: 3,
  },
  {
    id: 'docks',
    name: 'South Docks',
    x0: 0, y0: 2200, x1: 1600, y1: 3200,
    style: 'industrial',
    palette: ['#8a8f96', '#7a7f88', '#979aa0', '#6f747c'],
    roof: ['#4a4e55', '#565b63', '#3f434a'],
    maxHeight: 3,
  },
];

function districtAt(x, y) {
  for (const d of DISTRICTS) {
    if (x >= d.x0 && x < d.x1 && y >= d.y0 && y < d.y1) return d;
  }
  return DISTRICTS[0];
}

const BEACH_X = 3060;
const WATER_X = 3060;
const MARINA = { x: 2900, y: 2600, pierX: 3120, pierY: 2600 };
const AIRPORT = { x: 2600, y: 300, name: 'Airport' };
const HIDEOUT = { x: 600, y: 800, name: 'Hideout' };
const SPRAY_SHOP = { x: 1400, y: 1400, radius: 150, drainPerSecond: 50 };
const FIXER_GARAGE = { x: 1800, y: 1000, name: 'Fixer Garage' };
const GUN_STORE = { x: 1000, y: 1800, name: 'Gun Store' };
const CLUB = { x: 2200, y: 1800, name: 'Club' };
const MARKET = { x: 1000, y: 600, name: 'Market' };
const BANK = { x: 2200, y: 1000, name: 'Bank' };

const WANTED_THRESHOLDS = [0, 12, 30, 52, 74, 92];
const WANTED_MAX_HEAT = 100;
const WANTED_HIDE_DISTANCE = 450;
const WANTED_HIDE_SECONDS = 3;

function wantedStars(heat) {
  let stars = 0;
  for (let i = 0; i < WANTED_THRESHOLDS.length; i++) {
    if (heat >= WANTED_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

const MISSION_REWARDS = {
  m1: 400,
  m2: 700,
  m3: 900,
  m4: 1100,
  m5: 1400,
  m6: 1800,
  m7: 4600,
  m8: 6200,
  m9: 2000,
  m10: 2500,
  m11: 3000,
  m12: 8000,
};

const CAR_TYPES = {
  sedan: { name: 'Sedan', topSpeed: 360, accel: 240, brake: 420, turn: 2.6, colors: ['#c8c8d0', '#7a8aa0', '#a0a8b0', '#d0b090'] },
  taxi: { name: 'Taxi', topSpeed: 350, accel: 250, brake: 430, turn: 2.7, colors: ['#f0c020'] },
  truck: { name: 'Truck', topSpeed: 300, accel: 170, brake: 320, turn: 2.0, colors: ['#8a6a4a', '#6a7a8a', '#a08050'] },
  sports: { name: 'Sports', topSpeed: 520, accel: 380, brake: 520, turn: 3.1, colors: ['#e02030', '#f0c020', '#2080e0', '#e08020'] },
  police: { name: 'Police', topSpeed: 480, accel: 340, brake: 500, turn: 2.9, colors: ['#202840'] },
};

const PLAYER_START = { x: 600, y: 800 };
const PLAYER_COLOR = '#f0c020';

export {
  GAME_TITLE,
  WORLD_SEED,
  WORLD_W,
  WORLD_H,
  CANVAS_W,
  CANVAS_H,
  ROAD_COUNT,
  ROAD_SPACING,
  ROAD_FIRST,
  ROAD_WIDTH,
  ROAD_HALF,
  ROAD_POSITIONS,
  roadPosition,
  DISTRICTS,
  districtAt,
  BEACH_X,
  WATER_X,
  MARINA,
  AIRPORT,
  HIDEOUT,
  SPRAY_SHOP,
  FIXER_GARAGE,
  GUN_STORE,
  CLUB,
  MARKET,
  BANK,
  WANTED_THRESHOLDS,
  WANTED_MAX_HEAT,
  WANTED_HIDE_DISTANCE,
  WANTED_HIDE_SECONDS,
  wantedStars,
  MISSION_REWARDS,
  CAR_TYPES,
  PLAYER_START,
  PLAYER_COLOR,
};
