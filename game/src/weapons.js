// Weapons — pistol, SMG, shotgun. Crescent Bay. Fresh from prose spec §3.2.
// Three weapons, one per key: 1 pistol (the starting weapon), 2 SMG, 3
// shotgun. Q cycles to the next owned weapon. Every weapon keeps its own
// ammo pool, and the HUD shows the current weapon name plus its ammo big.
// Weapon crates sit at fixed spots in the world (gun store, docks, hideout)
// and inside the m10 / m12 shootout arenas; walking over a crate picks the
// weapon up and adds ammo. Ammo pickups sit in the shootout arenas — the
// autopilot grabs one when its current weapon is at 6 ammo or fewer.
// Enemies use the pistol only. Switching weapons works on foot and is
// instant: there is no animation lock, no delay, no cancelled shot.
//
// Shared-state contract (read defensively; missing fields get safe defaults):
//   game.player  { x, y, angle, onFoot } — Rook's position and aim angle.
//   game.world.landmarks { gunStore, docks, hideout } — crate spots; when
//                absent, DEFAULT_CRATE_SPOTS below is used instead.
//   game.mission { id } — 'm10' / 'm12' arenas get their own crates.
//   game.arena   { x, y, radius } — shootout arena centre (optional).
//   game.time    { now } — seconds; used for fire-rate cooldowns.
//   game.audio   { play(name) } — optional sound hook.
//   game.enemies — array of { x, y, health, alive } the combat system
//                owns; this module never mutates enemies directly, it only
//                returns shot descriptors for the combat system to resolve.
// A shot descriptor is { x, y, angle, damage, range, speed, kind, pellet }.
// The combat system moves it, tests hits, and calls registerHit() so the
// ammo bookkeeping stays in one place. tryFire() already deducts ammo.

export const WEAPON_DEFS = {
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    key: '1',
    damage: 18,
    fireInterval: 0.28,
    range: 460,
    bulletSpeed: 900,
    pellets: 1,
    spread: 0.02,
    startAmmo: 48,
    crateAmmo: 48,
    pickupAmmo: 24,
  },
  smg: {
    id: 'smg',
    name: 'SMG',
    key: '2',
    damage: 10,
    fireInterval: 0.09,
    range: 380,
    bulletSpeed: 950,
    pellets: 1,
    spread: 0.06,
    startAmmo: 0,
    crateAmmo: 120,
    pickupAmmo: 60,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    key: '3',
    damage: 8,
    fireInterval: 0.85,
    range: 240,
    bulletSpeed: 800,
    pellets: 5,
    spread: 0.16,
    startAmmo: 0,
    crateAmmo: 24,
    pickupAmmo: 12,
  },
};

export const WEAPON_ORDER = ['pistol', 'smg', 'shotgun'];
export const ENEMY_WEAPON_ID = 'pistol';
export const LOW_AMMO_THRESHOLD = 6;

export const DEFAULT_CRATE_SPOTS = [
  { kind: 'smg', x: 1000, y: 1000, label: 'gun store' },
  { kind: 'shotgun', x: 1000, y: 1000, label: 'gun store' },
  { kind: 'smg', x: 3000, y: 2200, label: 'docks' },
  { kind: 'shotgun', x: 3000, y: 2200, label: 'docks' },
  { kind: 'smg', x: 600, y: 1800, label: 'hideout' },
  { kind: 'shotgun', x: 600, y: 1800, label: 'hideout' },
];

export const CRATE_PICKUP_RADIUS = 46;
export const AMMO_PICKUP_RADIUS = 40;

export function createWeaponSystem(game) {
  const state = {
    current: 'pistol',
    owned: { pistol: true, smg: false, shotgun: false },
    ammo: {
      pistol: WEAPON_DEFS.pistol.startAmmo,
      smg: 0,
      shotgun: 0,
    },
    lastShotAt: -10,
    crates: [],
    ammoPickups: [],
    shotsFired: 0,
    pickupsTaken: 0,
    arenaCratesSpawnedFor: null,
  };

  function now() {
    if (game && game.time && typeof game.time.now === 'number') return game.time.now;
    return Date.now() / 1000;
  }

  function playerPos() {
    const p = game && game.player;
    if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
    return { x: 1600, y: 1600, angle: 0, onFoot: true };
  }

  function rng() {
    if (game && typeof game.rng === 'function') return game.rng();
    return Math.random();
  }

  function playSound(name) {
    if (game && game.audio && typeof game.audio.play === 'function') {
      try { game.audio.play(name); } catch (e) { /* sound is optional */ }
    }
  }

  function landmark(name) {
    const marks = game && game.world && game.world.landmarks;
    if (marks && marks[name] && typeof marks[name].x === 'number') return marks[name];
    return null;
  }

  // Fixed world crates: one SMG crate + one shotgun crate at each of the
  // gun store, the docks and the hideout. Spawned once per run.
  function spawnWorldCrates() {
    if (state.crates.length > 0) return state.crates;
    const spots = [];
    const gun = landmark('gunStore');
    const docks = landmark('docks');
    const hideout = landmark('hideout');
    if (gun) {
      spots.push({ kind: 'smg', x: gun.x, y: gun.y, label: 'gun store' });
      spots.push({ kind: 'shotgun', x: gun.x + 40, y: gun.y, label: 'gun store' });
    }
    if (docks) {
      spots.push({ kind: 'smg', x: docks.x, y: docks.y, label: 'docks' });
      spots.push({ kind: 'shotgun', x: docks.x + 40, y: docks.y, label: 'docks' });
    }
    if (hideout) {
      spots.push({ kind: 'smg', x: hideout.x, y: hideout.y, label: 'hideout' });
      spots.push({ kind: 'shotgun', x: hideout.x + 40, y: hideout.y, label: 'hideout' });
    }
    const list = spots.length > 0 ? spots : DEFAULT_CRATE_SPOTS;
    state.crates = list.map((s) => ({
      kind: s.kind,
      x: s.x,
      y: s.y,
      label: s.label,
      taken: false,
    }));
    return state.crates;
  }

  // Arena crates for the m10 / m12 shootouts: an SMG crate, a shotgun
  // crate and two ammo pickups inside the arena, spawned once per mission.
  function spawnArenaCrates() {
    const missionId = game && game.mission && game.mission.id;
    if (missionId !== 'm10' && missionId !== 'm12') return [];
    if (state.arenaCratesSpawnedFor === missionId) return state.crates;
    state.arenaCratesSpawnedFor = missionId;
    const arena = (game && game.arena) || {};
    const cx = typeof arena.x === 'number' ? arena.x : playerPos().x;
    const cy = typeof arena.y === 'number' ? arena.y : playerPos().y;
    const made = [
      { kind: 'smg', x: cx - 120, y: cy - 80, label: 'arena', taken: false },
      { kind: 'shotgun', x: cx + 120, y: cy - 80, label: 'arena', taken: false },
    ];
    state.crates.push(...made);
    state.ammoPickups.push(
      { weapon: 'smg', x: cx - 60, y: cy + 100, taken: false },
      { weapon: 'shotgun', x: cx + 60, y: cy + 100, taken: false },
      { weapon: 'pistol', x: cx, y: cy + 140, taken: false },
    );
    return made;
  }

  function spawnAmmoPickup(x, y, weapon) {
    const def = WEAPON_DEFS[weapon] || WEAPON_DEFS.pistol;
    state.ammoPickups.push({ weapon: def.id, x, y, taken: false });
    return state.ammoPickups[state.ammoPickups.length - 1];
  }

  function currentDef() {
    return WEAPON_DEFS[state.current];
  }

  function ammoFor(id) {
    return state.ammo[id] || 0;
  }

  function isOwned(id) {
    return !!state.owned[id];
  }

  function giveWeapon(id, ammoBonus) {
    const def = WEAPON_DEFS[id];
    if (!def) return false;
    const firstTime = !state.owned[id];
    state.owned[id] = true;
    state.ammo[id] = (state.ammo[id] || 0) + (ammoBonus || def.crateAmmo);
    if (firstTime) state.current = id;
    playSound('pickup');
    return true;
  }

  function addAmmo(id, amount) {
    const def = WEAPON_DEFS[id];
    if (!def) return false;
    state.ammo[id] = (state.ammo[id] || 0) + Math.max(0, amount || 0);
    return true;
  }

  // Instant switch, on foot only. Returns true when the weapon changed.
  function selectWeapon(id) {
    const def = WEAPON_DEFS[id];
    if (!def || !state.owned[id]) return false;
    const p = game && game.player;
    if (p && p.onFoot === false) return false;
    if (state.current === id) return true;
    state.current = id;
    playSound('weapon-switch');
    return true;
  }

  function cycleWeapon() {
    const idx = WEAPON_ORDER.indexOf(state.current);
    for (let step = 1; step <= WEAPON_ORDER.length; step++) {
      const next = WEAPON_ORDER[(idx + step) % WEAPON_ORDER.length];
      if (state.owned[next]) {
        state.current = next;
        playSound('weapon-switch');
        return state.current;
      }
    }
    return state.current;
  }

  function canFire() {
    const def = currentDef();
    if (ammoFor(state.current) <= 0) return false;
    return now() - state.lastShotAt >= def.fireInterval;
  }

  // Fire one shot from the player's position toward aimAngle. Returns an
  // array of shot descriptors (one per pellet), or null when it cannot
  // fire (cooling down, out of ammo, or driving). Ammo is deducted here.
  function tryFire(aimAngle) {
    const p = playerPos();
    if (p.onFoot === false) return null;
    const def = currentDef();
    if (ammoFor(state.current) <= 0) return null;
    if (now() - state.lastShotAt < def.fireInterval) return null;
    state.lastShotAt = now();
    state.ammo[state.current] -= 1;
    state.shotsFired += 1;
    playSound('shoot-' + state.current);
    const shots = [];
    for (let i = 0; i < def.pellets; i++) {
      const jitter = (rng() - 0.5) * 2 * def.spread;
      shots.push({
        x: p.x,
        y: p.y,
        angle: aimAngle + jitter,
        damage: def.damage,
        range: def.range,
        speed: def.bulletSpeed,
        kind: state.current,
        pellet: i,
      });
    }
    return shots;
  }

  // Enemy fire: enemies use the pistol only, one bullet, pistol damage.
  function enemyShot(x, y, angle) {
    const def = WEAPON_DEFS.pistol;
    return {
      x,
      y,
      angle,
      damage: def.damage,
      range: def.range,
      speed: def.bulletSpeed,
      kind: 'pistol',
      pellet: 0,
      fromEnemy: true,
    };
  }

  function nearestCrate(maxDistance) {
    const p = playerPos();
    let best = null;
    let bestD = maxDistance || Infinity;
    for (const c of state.crates) {
      if (c.taken) continue;
      const dx = c.x - p.x;
      const dy = c.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  function nearestAmmoPickup(maxDistance) {
    const p = playerPos();
    let best = null;
    let bestD = maxDistance || Infinity;
    for (const a of state.ammoPickups) {
      if (a.taken) continue;
      const dx = a.x - p.x;
      const dy = a.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  function needsAmmo() {
    return ammoFor(state.current) <= LOW_AMMO_THRESHOLD;
  }

  function update(dt) {
    spawnWorldCrates();
    spawnArenaCrates();
    const p = playerPos();
    if (p.onFoot === false) return state;
    for (const c of state.crates) {
      if (c.taken) continue;
      const dx = c.x - p.x;
      const dy = c.y - p.y;
      if (dx * dx + dy * dy < CRATE_PICKUP_RADIUS * CRATE_PICKUP_RADIUS) {
        c.taken = true;
        giveWeapon(c.kind);
        state.pickupsTaken += 1;
        if (game) game.lastPickup = { kind: c.kind, at: now() };
      }
    }
    for (const a of state.ammoPickups) {
      if (a.taken) continue;
      const dx = a.x - p.x;
      const dy = a.y - p.y;
      if (dx * dx + dy * dy < AMMO_PICKUP_RADIUS * AMMO_PICKUP_RADIUS) {
        a.taken = true;
        const def = WEAPON_DEFS[a.weapon];
        addAmmo(a.weapon, def ? def.pickupAmmo : 24);
        state.pickupsTaken += 1;
        playSound('pickup-ammo');
      }
    }
    return state;
  }

  // Keyboard handling: 1/2/3 select, Q cycles. Returns true when a key
  // was consumed. The main loop may call this with its own input object.
  function onKey(code) {
    if (code === 'Digit1') return selectWeapon('pistol');
    if (code === 'Digit2') return selectWeapon('smg');
    if (code === 'Digit3') return selectWeapon('shotgun');
    if (code === 'KeyQ') { cycleWeapon(); return true; }
    return false;
  }

  function hudText() {
    const def = currentDef();
    return { weapon: def.name, ammo: ammoFor(state.current), owned: { ...state.owned } };
  }

  function draw(ctx, camera) {
    if (!ctx) return;
    const camX = (camera && camera.x) || 0;
    const camY = (camera && camera.y) || 0;
    for (const c of state.crates) {
      if (c.taken) continue;
      const x = c.x - camX;
      const y = c.y - camY;
      ctx.fillStyle = '#7a5a1e';
      ctx.fillRect(x - 14, y - 10, 28, 20);
      ctx.fillStyle = '#c9a227';
      ctx.fillRect(x - 14, y - 2, 28, 4);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(c.kind === 'smg' ? 'SMG' : 'SG', x, y + 4);
    }
    for (const a of state.ammoPickups) {
      if (a.taken) continue;
      const x = a.x - camX;
      const y = a.y - camY;
      ctx.fillStyle = '#2e7d32';
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('AMMO', x, y + 3);
    }
  }

  function serialize() {
    return {
      current: state.current,
      owned: { ...state.owned },
      ammo: { ...state.ammo },
      cratesTaken: state.crates.filter((c) => c.taken).length,
    };
  }

  function restore(data) {
    if (!data || typeof data !== 'object') return false;
    if (data.current && WEAPON_DEFS[data.current]) state.current = data.current;
    if (data.owned) {
      for (const id of WEAPON_ORDER) {
        if (typeof data.owned[id] === 'boolean') state.owned[id] = data.owned[id];
      }
    }
    if (data.ammo) {
      for (const id of WEAPON_ORDER) {
        if (typeof data.ammo[id] === 'number') state.ammo[id] = data.ammo[id];
      }
    }
    if (!state.owned[state.current]) state.current = 'pistol';
    return true;
  }

  function snapshot() {
    return {
      current: state.current,
      ammo: { ...state.ammo },
      owned: { ...state.owned },
      crates: state.crates.length,
      cratesTaken: state.crates.filter((c) => c.taken).length,
      ammoPickups: state.ammoPickups.filter((a) => !a.taken).length,
      shotsFired: state.shotsFired,
      pickupsTaken: state.pickupsTaken,
    };
  }

  return {
    state,
    defs: WEAPON_DEFS,
    update,
    draw,
    onKey,
    tryFire,
    enemyShot,
    selectWeapon,
    cycleWeapon,
    giveWeapon,
    addAmmo,
    ammoFor,
    isOwned,
    currentDef,
    hudText,
    spawnWorldCrates,
    spawnArenaCrates,
    spawnAmmoPickup,
    nearestCrate,
    nearestAmmoPickup,
    needsAmmo,
    serialize,
    restore,
    snapshot,
  };
}

export default createWeaponSystem;
