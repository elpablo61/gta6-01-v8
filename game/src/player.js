// player.js — Crescent Bay player control + state (fresh from prose spec §1).
//
// Rook, on foot and behind the wheel. On foot: WASD/arrows move, mouse
// aim, click shoot, Shift sprint. Driving: E enter/exit, steal parked
// cars, carjack traffic cars (the driver flees). Health, cash, and the
// wanted interface live here; the police module owns heat itself, this
// module only reads it and exposes stars.
//
// The player reads input from G.input when driven by a human, and from
// G.autopilot.input when the autopilot is active — the autopilot sets
// that object every frame, and this module never runs both at once
// (the autopilot-vs-manual conflict from the builder-1 notes is designed
// out: one input source per frame, autopilot wins when active).
//
// Input shape (both sources): { up, down, left, right, sprint, interact,
//   shoot, aimX, aimY, weapon1, weapon2, weapon3, cycleWeapon, radio }
// Mouse aim: aimX/aimY are world coordinates; when absent the player
// keeps the last aim angle.
//
// Game-over words are CAUGHT (arrested) and DOWN (killed) — never the
// Rockstar terms (spec §1 naming rules).
//
// Context object G (only what this module reads):
//   G.input     — live keyboard/mouse state
//   G.autopilot — { active, input } when the autopilot drives
//   G.traffic   — traffic module (nearestParked / nearestDriven / carjack)
//   G.combat    — combat module (fire / weapon keys)
//   G.police    — police module ({ heat, stars(), addHeat(), ... })
//   G.audio     — optional { sfx(name), setEngine(speed01, on) }
//   G.onEnterCar(car) / G.onExitCar(car) / G.onCarjack(car) — hooks
//   G.onPlayerDown() / G.onPlayerCaught() — game-over hooks
//   G.onSpendFail(amount) — optional hook when cash is short
//   G.world     — optional { collide(x, y, r) } building/wall helper;
//                 without it the player is clamped to the world edge
//
// Public API (returned by createPlayer):
//   state            the live player object (x, y, angle, health, cash,
//                    onFoot, car, speed, aimAngle, ...)
//   update(dt)
//   takeDamage(amount, source) -> 'alive' | 'down'
//   heal(amount)
//   addCash(n) / spendCash(n) -> bool
//   addHeat(n)         forwards to the police module when present
//   wantedStars()      stars from heat thresholds [0,12,30,52,74,92]
//   enterCar(car) / exitCar() / tryEnterNearby()
//   die(cause)         'down' | 'caught'
//   reset(x, y)        fresh state for a new game

export const WORLD = 3200;
export const WALK_SPEED = 210;
export const SPRINT_SPEED = 330;
export const HEAT_THRESHOLDS = [0, 12, 30, 52, 74, 92];

export function createPlayer(G) {
  const game = G || {};

  const state = {
    x: 600,
    y: 600,
    angle: 0, // facing / aim angle (on foot)
    aimAngle: 0,
    health: 100,
    maxHealth: 100,
    cash: 0,
    onFoot: true,
    car: null,
    speed: 0, // on-foot speed, or the car's speed while driving
    moving: false,
    sprinting: false,
    dead: false,
    caught: false,
    // Driving state lives on the car object; these mirror it for the HUD.
    driveAngle: 0,
    interactCooldown: 0,
    hurtCooldown: 0,
  };

  function inputNow() {
    const ap = game.autopilot;
    if (ap && ap.active && ap.input) return ap.input;
    return game.input || {};
  }

  function clampWorld() {
    state.x = Math.max(24, Math.min(WORLD - 24, state.x));
    state.y = Math.max(24, Math.min(WORLD - 24, state.y));
  }

  function wantedStars() {
    const heat = game.police && typeof game.police.heat === 'number'
      ? game.police.heat
      : (typeof game.heat === 'number' ? game.heat : 0);
    let stars = 0;
    for (let i = 0; i < HEAT_THRESHOLDS.length; i++) {
      if (heat >= HEAT_THRESHOLDS[i]) stars = i;
    }
    return stars;
  }

  function updateOnFoot(dt, input) {
    let mx = 0;
    let my = 0;
    if (input.up) my -= 1;
    if (input.down) my += 1;
    if (input.left) mx -= 1;
    if (input.right) mx += 1;
    const len = Math.hypot(mx, my);
    state.sprinting = !!input.sprint && len > 0;
    const speed = state.sprinting ? SPRINT_SPEED : WALK_SPEED;
    state.moving = len > 0;
    if (len > 0) {
      mx /= len;
      my /= len;
      let nx = state.x + mx * speed * dt;
      let ny = state.y + my * speed * dt;
      // Wall slide: try the full step, then each axis alone (spec §1:
      // slide along walls instead of sticking).
      const blocked = (x, y) => {
        if (game.world && typeof game.world.collide === 'function') {
          return game.world.collide(x, y, 14);
        }
        return x < 20 || x > WORLD - 20 || y < 20 || y > WORLD - 20;
      };
      if (!blocked(nx, ny)) {
        state.x = nx; state.y = ny;
      } else if (!blocked(nx, state.y)) {
        state.x = nx;
      } else if (!blocked(state.x, ny)) {
        state.y = ny;
      }
      state.speed = speed;
    } else {
      state.speed = 0;
    }

    // Aim: mouse world position, or keep facing the move direction.
    if (typeof input.aimX === 'number' && typeof input.aimY === 'number') {
      state.aimAngle = Math.atan2(input.aimY - state.y, input.aimX - state.x);
    } else if (len > 0) {
      state.aimAngle = Math.atan2(my, mx);
    }
    state.angle = state.aimAngle;

    // Shooting (on foot only; combat owns ammo / rate / damage).
    if (input.shoot && game.combat && typeof game.combat.fire === 'function') {
      const targets = typeof game.combatTargets === 'function'
        ? game.combatTargets()
        : (game.targets || []);
      game.combat.fire(state.x, state.y, state.aimAngle, targets);
    }

    // Weapon keys.
    if (game.combat) {
      if (input.weapon1) game.combat.setWeapon('pistol');
      if (input.weapon2) game.combat.setWeapon('smg');
      if (input.weapon3) game.combat.setWeapon('shotgun');
      if (input.cycleWeapon) game.combat.cycleWeapon();
    }
    clampWorld();
  }

  // Radius-based steering (spec §1): the car turns on a radius so it can
  // turn inside narrow 64-wide roads; a turn sharper than ~52 degrees
  // (|angle diff| > 0.9) stops the car and rotates it in place.
  function updateDriving(dt, input) {
    const car = state.car;
    if (!car) { state.onFoot = true; return; }
    const type = car.type || { topSpeed: 300, accel: 220 };
    // Garage upgrades on this car (spec §3.3): engine raises top speed,
    // tires raise turn authority, brakes shorten stopping.
    const up = car.upgrades || {};
    const topSpeed = type.topSpeed * (1 + 0.15 * (up.engine || 0));
    const accel = type.accel * (1 + 0.1 * (up.engine || 0));
    const turnRate = 2.6 * (1 + 0.18 * (up.tires || 0));
    const brakePower = accel * (1.6 + 0.5 * (up.brakes || 0));

    let throttle = 0;
    if (input.up) throttle = 1;
    if (input.down) throttle = -0.7; // reverse / brake
    const steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);

    // Sharp-turn rule: stop fully and rotate in place.
    const targetAngle = car.angle + steer * turnRate * dt * Math.min(1, 0.3 + Math.abs(car.speed) / 240);
    const diff = Math.atan2(Math.sin(targetAngle - car.angle), Math.cos(targetAngle - car.angle));
    if (Math.abs(diff) > 0.9 && Math.abs(car.speed) < 40 && steer !== 0) {
      car.angle += steer * 2.2 * dt;
      car.speed = 0;
    } else {
      car.angle = targetAngle;
      if (throttle > 0) {
        car.speed = Math.min(topSpeed, car.speed + accel * dt);
      } else if (throttle < 0) {
        if (car.speed > 5) car.speed = Math.max(0, car.speed - brakePower * dt);
        else car.speed = Math.max(-90, car.speed - accel * 0.6 * dt);
      } else {
        // Coast down.
        car.speed = Math.abs(car.speed) < 4 ? 0 : car.speed - Math.sign(car.speed) * 130 * dt;
      }
    }

    // Crawl-forward turns: keep a minimum turn authority at low speed.
    if (steer !== 0 && Math.abs(car.speed) < 30 && throttle >= 0) {
      car.speed = Math.max(car.speed, 30);
    }

    let nx = car.x + Math.cos(car.angle) * car.speed * dt;
    let ny = car.y + Math.sin(car.angle) * car.speed * dt;
    const blocked = (x, y) => {
      if (game.world && typeof game.world.collide === 'function') {
        return game.world.collide(x, y, 18);
      }
      return x < 20 || x > WORLD - 20 || y < 20 || y > WORLD - 20;
    };
    if (!blocked(nx, ny)) {
      car.x = nx; car.y = ny;
    } else if (!blocked(nx, car.y)) {
      car.x = nx;
      car.speed *= 0.6; // wall scrape: slide, lose some speed
    } else if (!blocked(car.x, ny)) {
      car.y = ny;
      car.speed *= 0.6;
    } else {
      // Fully wedged: reverse straight to unwedge (spec §1).
      car.speed = -60;
      car.x += Math.cos(car.angle) * car.speed * dt;
      car.y += Math.sin(car.angle) * car.speed * dt;
    }
    car.x = Math.max(20, Math.min(WORLD - 20, car.x));
    car.y = Math.max(20, Math.min(WORLD - 20, car.y));

    state.x = car.x;
    state.y = car.y;
    state.speed = car.speed;
    state.driveAngle = car.angle;
    state.moving = Math.abs(car.speed) > 5;
    if (game.audio && typeof game.audio.setEngine === 'function') {
      game.audio.setEngine(Math.abs(car.speed) / topSpeed, true);
    }
  }

  function tryEnterNearby() {
    const traffic = game.traffic;
    if (!traffic) return false;
    // Parked car first (free), then a driven car (carjack).
    let car = null;
    let stolen = false;
    if (typeof traffic.nearestParked === 'function') {
      car = traffic.nearestParked(state.x, state.y, 70);
    }
    if (!car && typeof traffic.nearestDriven === 'function') {
      car = traffic.nearestDriven(state.x, state.y, 70);
      stolen = !!car;
    }
    if (!car) return false;
    if (stolen) {
      if (typeof traffic.carjack === 'function') traffic.carjack(car);
      // Carjacking is a crime: heat. The police module owns the amount.
      if (game.police && typeof game.police.addHeat === 'function') game.police.addHeat(8);
      else if (typeof game.heat === 'number') game.heat = Math.min(100, game.heat + 8);
      if (game.audio) game.audio.sfx('horn');
      if (typeof game.onCarjack === 'function') game.onCarjack(car);
    } else if (typeof traffic.carjack === 'function') {
      // Take a parked car out of the parked list so it is not double-sold.
      traffic.carjack(car);
    }
    state.car = car;
    state.onFoot = false;
    state.speed = 0;
    if (typeof game.onEnterCar === 'function') game.onEnterCar(car);
    return true;
  }

  function exitCar() {
    const car = state.car;
    if (!car) return;
    state.car = null;
    state.onFoot = true;
    // Step out to the side of the car.
    state.x = car.x + Math.cos(car.angle + Math.PI / 2) * 26;
    state.y = car.y + Math.sin(car.angle + Math.PI / 2) * 26;
    state.speed = 0;
    clampWorld();
    if (game.audio && typeof game.audio.setEngine === 'function') game.audio.setEngine(0, false);
    if (typeof game.onExitCar === 'function') game.onExitCar(car);
  }

  return {
    state,

    update(dt) {
      if (state.dead || state.caught) return;
      state.interactCooldown = Math.max(0, state.interactCooldown - dt);
      state.hurtCooldown = Math.max(0, state.hurtCooldown - dt);
      const input = inputNow();
      if (state.onFoot) updateOnFoot(dt, input);
      else updateDriving(dt, input);
      // E: enter / exit a car (on foot) or step out (driving).
      if (input.interact && state.interactCooldown <= 0) {
        state.interactCooldown = 0.35;
        if (state.onFoot) tryEnterNearby();
        else exitCar();
      }
    },

    takeDamage(amount, source) {
      if (state.dead || state.caught || state.hurtCooldown > 0) return 'alive';
      // Armor upgrade on the current car resists damage while driving.
      let dmg = amount;
      if (!state.onFoot && state.car && state.car.upgrades && state.car.upgrades.armor) {
        dmg *= Math.max(0.4, 1 - 0.12 * state.car.upgrades.armor);
      }
      state.health -= dmg;
      state.hurtCooldown = 0.12;
      if (game.audio) game.audio.sfx('crash');
      if (state.health <= 0) {
        state.health = 0;
        return this.die(source === 'arrest' ? 'caught' : 'down');
      }
      return 'alive';
    },

    heal(amount) {
      state.health = Math.min(state.maxHealth, state.health + (amount || 0));
      return state.health;
    },

    addCash(n) {
      state.cash += n;
      return state.cash;
    },

    spendCash(n) {
      if (state.cash < n) {
        if (typeof game.onSpendFail === 'function') game.onSpendFail(n);
        return false;
      }
      state.cash -= n;
      return true;
    },

    addHeat(n) {
      if (game.police && typeof game.police.addHeat === 'function') game.police.addHeat(n);
      else if (typeof game.heat === 'number') game.heat = Math.min(100, game.heat + n);
    },

    wantedStars,

    enterCar(car) {
      if (!car) return false;
      state.car = car;
      state.onFoot = false;
      return true;
    },

    exitCar,
    tryEnterNearby,

    die(cause) {
      if (cause === 'caught') {
        state.caught = true;
        if (game.audio) game.audio.sfx('arrest');
        if (typeof game.onPlayerCaught === 'function') game.onPlayerCaught();
        return 'caught';
      }
      state.dead = true;
      if (game.audio) game.audio.sfx('fail');
      if (typeof game.onPlayerDown === 'function') game.onPlayerDown();
      return 'down';
    },

    reset(x, y) {
      state.x = x === undefined ? 600 : x;
      state.y = y === undefined ? 600 : y;
      state.angle = 0;
      state.aimAngle = 0;
      state.health = state.maxHealth;
      state.cash = 0;
      state.onFoot = true;
      state.car = null;
      state.speed = 0;
      state.dead = false;
      state.caught = false;
      state.interactCooldown = 0;
      state.hurtCooldown = 0;
      return state;
    },
  };
}
