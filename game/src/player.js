// player.js — Rook on foot and behind the wheel (Crescent Bay).
//
// Owns the player character: walking / sprinting / aiming / shooting on
// foot, entering and leaving cars (stealing parked cars, carjacking traffic
// cars), the wanted heat meter and its stars, hiding decay, arrest
// exposure, health and the CAUGHT / DOWN game-over states.
//
// Game-state contract (duck-typed; every field is read defensively):
//   game.state            'playing' while the world runs
//   game.now              seconds elapsed (for damage ticks)
//   game.dt               frame delta in seconds
//   game.world            { isBlocked(x, y) } when present, else a
//                         road-proximity fallback is used
//   game.input            { keys:Set of codes } and/or booleans
//                         up/down/left/right/sprint, mouseDown,
//                         mousePressed (edge), interactPressed (E edge),
//                         aimX/aimY (mouse position in world coords)
//   game.player           the player object (see createPlayer)
//   game.cars             array of car objects (see traffic.js)
//   game.peds             array of pedestrian objects
//   game.police           foot cops + patrol cars (or game.cops)
//   game.sprayShop        { x, y, radius } — repaint garage
//   game.helicopter       { spotlightOnPlayer } — blocks heat decay
//   game.combat           combat module handle (fireWeapon) when wired
//   game.audio            audio engine handle when wired
//
// The autopilot drives the player's car on frames it sets
// game.autopilotDrove = true; manual driving is skipped on those frames
// so the two drivers never fight each other.

import { applyCarPhysics } from './traffic.js';

export const WANTED_STAR_THRESHOLDS = [0, 12, 30, 52, 74, 92];
export const PLAYER_WALK_SPEED = 170;
export const PLAYER_SPRINT_SPEED = 285;
export const PLAYER_MAX_HEALTH = 100;
export const HEAT_MAX = 100;
export const HIDE_DISTANCE = 450;
export const HIDE_TIME = 3;
export const HEAT_DECAY_RATE = 10;
export const SPRAY_SHOP_RADIUS = 150;
export const SPRAY_SHOP_DRAIN = 50;
export const ARREST_DISTANCE = 30;
export const ARREST_HOLD_TIME = 1.2;
export const CAR_ENTER_DISTANCE = 78;

export function computeWantedStars(heat) {
  let stars = 0;
  for (let i = 1; i < WANTED_STAR_THRESHOLDS.length; i++) {
    if (heat >= WANTED_STAR_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

export function createPlayer(x = 600, y = 800) {
  return {
    x, y,
    angle: -Math.PI / 2,
    vx: 0, vy: 0,
    speed: 0,
    health: PLAYER_MAX_HEALTH,
    maxHealth: PLAYER_MAX_HEALTH,
    cash: 0,
    heat: 0,
    stars: 0,
    alive: true,
    onFoot: true,
    car: null,
    weapon: 'pistol',
    owned: { pistol: true, smg: false, shotgun: false },
    ammo: { pistol: 48, smg: 0, shotgun: 0 },
    sprinting: false,
    hideTimer: 0,
    arrestTimer: 0,
    damageFlashT: 0,
    lastWallDamageT: -10,
  };
}

function keyDown(game, ...codes) {
  const input = game.input || {};
  const keys = input.keys;
  if (keys && typeof keys.has === 'function') {
    for (const code of codes) if (keys.has(code)) return true;
  }
  for (const code of codes) if (input[code]) return true;
  return false;
}

function readMoveInput(game) {
  const input = game.input || {};
  let mx = 0, my = 0;
  if (keyDown(game, 'KeyA', 'ArrowLeft') || input.left) mx -= 1;
  if (keyDown(game, 'KeyD', 'ArrowRight') || input.right) mx += 1;
  if (keyDown(game, 'KeyW', 'ArrowUp') || input.up) my -= 1;
  if (keyDown(game, 'KeyS', 'ArrowDown') || input.down) my += 1;
  if (input.moveX) mx += input.moveX;
  if (input.moveY) my += input.moveY;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  return { mx, my };
}

function worldBlocked(game, x, y) {
  if (x < 24 || x > 3176 || y < 24 || y > 3176) return true;
  if (game.world && typeof game.world.isBlocked === 'function') {
    return game.world.isBlocked(x, y);
  }
  // Fallback from the spec geometry: roads sit at 200 + i*400 with a
  // 64-wide carriageway; anything further than a sidewalk from a road
  // centreline is inside a block and blocked.
  const coords = [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];
  let nearest = Infinity;
  for (const c of coords) {
    nearest = Math.min(nearest, Math.abs(x - c), Math.abs(y - c));
  }
  return nearest > 46;
}

export function addHeat(game, amount) {
  const p = game.player;
  if (!p) return;
  p.heat = Math.max(0, Math.min(HEAT_MAX, p.heat + amount));
  p.stars = computeWantedStars(p.heat);
}

export function updatePlayerHeat(game, dt) {
  const p = game.player;
  if (!p || !p.alive) return;
  const heli = game.helicopter;
  const spotlighted = !!(heli && heli.active && heli.spotlightOnPlayer);

  // The Spray Shop clears heat fast while Rook is inside its radius.
  const shop = game.sprayShop;
  if (shop) {
    const d = Math.hypot(p.x - shop.x, p.y - shop.y);
    const radius = shop.radius || SPRAY_SHOP_RADIUS;
    if (d < radius) {
      p.heat = Math.max(0, p.heat - SPRAY_SHOP_DRAIN * dt);
      p.stars = computeWantedStars(p.heat);
      p.hideTimer = 0;
      return;
    }
  }

  if (spotlighted) {
    // A helicopter spotlight on Rook blocks heat decay entirely.
    p.hideTimer = 0;
    return;
  }

  const police = game.police || game.cops || [];
  let nearestCop = Infinity;
  for (const cop of police) {
    if (!cop || cop.dead) continue;
    const d = Math.hypot(cop.x - p.x, cop.y - p.y);
    if (d < nearestCop) nearestCop = d;
  }
  if (nearestCop > HIDE_DISTANCE) {
    p.hideTimer += dt;
    if (p.hideTimer >= HIDE_TIME) {
      p.heat = Math.max(0, p.heat - HEAT_DECAY_RATE * dt);
      p.stars = computeWantedStars(p.heat);
    }
  } else {
    p.hideTimer = 0;
  }
}

export function damagePlayer(game, amount, source) {
  const p = game.player;
  if (!p || !p.alive) return;
  p.health -= amount;
  p.damageFlashT = 0.25;
  if (game.audio && typeof game.audio.playHurt === 'function') {
    game.audio.playHurt();
  }
  if (p.health <= 0) {
    p.health = 0;
    p.alive = false;
    setGameOver(game, 'DOWN');
  }
}

export function healPlayer(game, amount) {
  const p = game.player;
  if (!p || !p.alive) return;
  p.health = Math.min(p.maxHealth, p.health + amount);
}

export function setGameOver(game, reason) {
  game.gameOver = { reason, at: game.now || 0 };
  game.state = 'gameover';
  if (game.audio && typeof game.audio.playGameOver === 'function') {
    game.audio.playGameOver(reason);
  }
}

function checkArrest(game, dt) {
  const p = game.player;
  if (!p || !p.alive || !p.onFoot) { if (p) p.arrestTimer = 0; return; }
  // A foot cop must stay within 30 units of a slow on-foot player for
  // 1.2 seconds in a row; running away breaks the hold.
  const slow = p.speed < 100;
  const police = game.police || game.cops || [];
  let held = false;
  if (slow) {
    for (const cop of police) {
      if (!cop || cop.dead || cop.kind === 'car') continue;
      if (Math.hypot(cop.x - p.x, cop.y - p.y) < ARREST_DISTANCE) {
        held = true;
        break;
      }
    }
  }
  if (held) {
    p.arrestTimer += dt;
    if (p.arrestTimer >= ARREST_HOLD_TIME) {
      p.arrestTimer = 0;
      setGameOver(game, 'CAUGHT');
    }
  } else {
    p.arrestTimer = 0;
  }
}

function tryPlayerShoot(game) {
  const combat = game.combat;
  if (!combat || typeof combat.fireWeapon !== 'function') return;
  const input = game.input || {};
  const aimX = input.aimX ?? input.mouseWorldX ?? null;
  const aimY = input.aimY ?? input.mouseWorldY ?? null;
  combat.fireWeapon(game, 'player', aimX, aimY);
}

function updateOnFoot(game, dt) {
  const p = game.player;
  const { mx, my } = readMoveInput(game);
  const input = game.input || {};
  p.sprinting = !!(keyDown(game, 'ShiftLeft', 'ShiftRight') || input.sprint) && (mx !== 0 || my !== 0);
  const targetSpeed = p.sprinting ? PLAYER_SPRINT_SPEED : PLAYER_WALK_SPEED;
  const accel = 1400;
  p.vx += (mx * targetSpeed - p.vx) * Math.min(1, accel * dt / targetSpeed);
  p.vy += (my * targetSpeed - p.vy) * Math.min(1, accel * dt / targetSpeed);
  p.speed = Math.hypot(p.vx, p.vy);

  // Wall slide: try the full step, then each axis on its own.
  const nx = p.x + p.vx * dt;
  const ny = p.y + p.vy * dt;
  if (!worldBlocked(game, nx, ny)) {
    p.x = nx; p.y = ny;
  } else if (!worldBlocked(game, nx, p.y)) {
    p.x = nx; p.vx = 0;
  } else if (!worldBlocked(game, p.x, ny)) {
    p.y = ny; p.vy = 0;
  } else {
    p.vx = 0; p.vy = 0;
  }

  // Aim follows the mouse (world position); without a mouse, face travel.
  const aimX = input.aimX ?? input.mouseWorldX;
  const aimY = input.aimY ?? input.mouseWorldY;
  if (aimX !== undefined && aimY !== undefined && (aimX !== p.x || aimY !== p.y)) {
    p.angle = Math.atan2(aimY - p.y, aimX - p.x);
  } else if (p.speed > 20) {
    p.angle = Math.atan2(p.vy, p.vx);
  }

  if (input.mouseDown || input.mousePressed) tryPlayerShoot(game);

  if (input.interactPressed || input.ePressed) {
    if (!game.dialog || !game.dialog.open) tryEnterCar(game);
  }
  if (p.damageFlashT > 0) p.damageFlashT -= dt;
}

function nearestUsableCar(game) {
  const p = game.player;
  let best = null, bestD = Infinity;
  for (const car of game.cars || []) {
    if (!car || car.wrecked || car.player) continue;
    const d = Math.hypot(car.x - p.x, car.y - p.y);
    if (d < bestD) { bestD = d; best = car; }
  }
  return bestD < CAR_ENTER_DISTANCE ? best : null;
}

export function tryEnterCar(game) {
  const p = game.player;
  if (!p || !p.alive || !p.onFoot) return false;
  const car = nearestUsableCar(game);
  if (!car) return false;
  if (car.driver === 'traffic') {
    // Carjack: the driver flees on foot, the theft adds heat.
    carjackDriverFlees(game, car);
    addHeat(game, 8);
  } else if (car.parked) {
    // Stealing a parked car adds heat too.
    addHeat(game, 5);
  }
  car.player = true;
  car.parked = false;
  car.driver = 'player';
  car.route = [];
  p.car = car;
  p.onFoot = false;
  p.x = car.x; p.y = car.y;
  p.vx = 0; p.vy = 0; p.speed = 0;
  if (game.audio && typeof game.audio.playCarDoor === 'function') {
    game.audio.playCarDoor();
  }
  return true;
}

function carjackDriverFlees(game, car) {
  if (!game.peds) game.peds = [];
  const away = Math.atan2(car.y - (game.player ? game.player.y : car.y), car.x - (game.player ? game.player.x : car.x));
  game.peds.push({
    x: car.x + Math.cos(away + Math.PI / 2) * 30,
    y: car.y + Math.sin(away + Math.PI / 2) * 30,
    angle: away,
    speed: 0,
    state: 'flee',
    fleeT: 4,
    fleeFromX: game.player ? game.player.x : car.x,
    fleeFromY: game.player ? game.player.y : car.y,
    color: '#c8b08a',
    walkSpeed: 150,
    paired: false,
  });
  car.driver = null;
}

export function exitCar(game) {
  const p = game.player;
  if (!p || p.onFoot || !p.car) return false;
  const car = p.car;
  // Step out to the side of the car, clear of its body.
  const side = car.angle + Math.PI / 2;
  const px = car.x + Math.cos(side) * 46;
  const py = car.y + Math.sin(side) * 46;
  if (!worldBlocked(game, px, py)) {
    p.x = px; p.y = py;
  } else {
    p.x = car.x - Math.cos(side) * 46;
    p.y = car.y - Math.sin(side) * 46;
  }
  p.angle = car.angle;
  car.player = false;
  car.parked = true;
  car.driver = null;
  car.speed = 0;
  p.car = null;
  p.onFoot = true;
  p.vx = 0; p.vy = 0; p.speed = 0;
  if (game.audio && typeof game.audio.playCarDoor === 'function') {
    game.audio.playCarDoor();
  }
  return true;
}

function updateDriving(game, dt) {
  const p = game.player;
  const car = p.car;
  if (!car) { p.onFoot = true; return; }
  const input = game.input || {};

  // The autopilot drove this frame: never brake it back with manual input.
  if (game.autopilotDrove) {
    p.x = car.x; p.y = car.y;
    p.angle = car.angle;
    p.speed = Math.abs(car.speed);
    return;
  }

  let throttle = 0;
  if (keyDown(game, 'KeyW', 'ArrowUp') || input.up) throttle += 1;
  if (keyDown(game, 'KeyS', 'ArrowDown') || input.down) throttle -= 1;
  let steer = 0;
  if (keyDown(game, 'KeyA', 'ArrowLeft') || input.left) steer -= 1;
  if (keyDown(game, 'KeyD', 'ArrowRight') || input.right) steer += 1;
  const handbrake = !!(keyDown(game, 'Space') || input.handbrake);
  applyCarPhysics(car, { throttle, steer, handbrake }, dt, game.world, game.now || 0);

  p.x = car.x; p.y = car.y;
  p.angle = car.angle;
  p.speed = Math.abs(car.speed);
  if (car.wrecked) {
    exitCar(game);
    return;
  }
  if (input.interactPressed || input.ePressed) exitCar(game);
  if (p.damageFlashT > 0) p.damageFlashT -= dt;
}

export function updatePlayer(game, dt) {
  const p = game.player;
  if (!p || !p.alive) return;
  if (game.state && game.state !== 'playing') return;
  updatePlayerHeat(game, dt);
  if (p.onFoot) updateOnFoot(game, dt);
  else updateDriving(game, dt);
  checkArrest(game, dt);
  if (p.health <= 0 && p.alive) {
    p.alive = false;
    setGameOver(game, 'DOWN');
  }
}
