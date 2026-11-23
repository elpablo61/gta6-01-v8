// weapons.js — Weapon system (prose spec §3.2).
// Three weapons, one per key: 1 pistol (start weapon, 18 damage, medium
// rate, 48 starting ammo), 2 SMG (fast fire, 10 damage, large magazine),
// 3 shotgun (slow, 5 pellets x 8 damage, spread, short range). Q cycles
// to the next owned weapon. Each weapon has its own ammo count; the HUD
// shows the current weapon name + ammo large. Weapon crates in the world:
// an SMG crate and a shotgun crate at fixed spots (gun store, docks,
// hideout) plus crates inside the m10/m12 shootout arenas; walking over
// a crate picks the weapon up (and gives ammo). Ammo pickups in shootout
// arenas (autopilot grabs one when its current weapon's ammo <= 6).
// Enemies use the pistol only. Weapon switching works on foot and is
// instant (no animation lock).

export const WEAPON_DEFS = {
  pistol: {
    name: 'Pistol',
    key: '1',
    damage: 18,
    fireInterval: 0.28, // medium rate
    pellets: 1,
    spread: 0.03,
    range: 520,
    startAmmo: 48,
    crateAmmo: 48,
    pickupAmmo: 24,
  },
  smg: {
    name: 'SMG',
    key: '2',
    damage: 10,
    fireInterval: 0.08, // fast fire
    pellets: 1,
    spread: 0.09,
    range: 460,
    startAmmo: 0,
    crateAmmo: 120, // large magazine
    pickupAmmo: 60,
  },
  shotgun: {
    name: 'Shotgun',
    key: '3',
    damage: 8, // per pellet
    fireInterval: 0.85, // slow
    pellets: 5,
    spread: 0.28, // wide spread
    range: 260, // short range
    startAmmo: 0,
    crateAmmo: 24,
    pickupAmmo: 12,
  },
};

export const WEAPON_ORDER = ['pistol', 'smg', 'shotgun'];
export const LOW_AMMO_THRESHOLD = 6; // autopilot grabs arena ammo at <= 6

// Fixed world crate spots from the spec: gun store, docks, hideout.
// Positions are set by the game when it creates the world; the crate
// definitions here carry only the weapon and a label, so the world can
// place them wherever its map puts those landmarks.
export function createWeaponCrates(spots) {
  // spots: [{ id, kind: 'smg'|'shotgun', x, y }]
  return spots.map((s) => ({
    id: s.id,
    kind: s.kind,
    x: s.x,
    y: s.y,
    taken: false,
    radius: 26,
  }));
}

export function createWeapons() {
  const state = {
    current: 'pistol',
    owned: { pistol: true, smg: false, shotgun: false },
    ammo: { pistol: WEAPON_DEFS.pistol.startAmmo, smg: 0, shotgun: 0 },
    cooldown: 0, // seconds until the next shot is allowed
  };

  function def() {
    return WEAPON_DEFS[state.current];
  }

  function canFire() {
    return state.cooldown <= 0 && state.ammo[state.current] > 0;
  }

  // Fire one trigger pull. Returns an array of shot descriptors
  // ({ damage, spreadOffset, range }) — one per pellet — or null when
  // the weapon cannot fire (cooling down or empty). The caller applies
  // the shots to targets; this module owns rate, ammo and spread only.
  function fire() {
    if (!canFire()) return null;
    state.cooldown = def().fireInterval;
    state.ammo[state.current] -= 1;
    const shots = [];
    for (let i = 0; i < def().pellets; i++) {
      const offset = (Math.random() * 2 - 1) * def().spread;
      shots.push({ damage: def().damage, spreadOffset: offset, range: def().range });
    }
    return shots;
  }

  // Instant switch, on foot or anywhere; no animation lock.
  function select(kind) {
    if (!state.owned[kind]) return false;
    state.current = kind;
    return true;
  }

  // Q: cycle to the next owned weapon.
  function cycle() {
    const idx = WEAPON_ORDER.indexOf(state.current);
    for (let step = 1; step <= WEAPON_ORDER.length; step++) {
      const next = WEAPON_ORDER[(idx + step) % WEAPON_ORDER.length];
      if (state.owned[next]) {
        state.current = next;
        return next;
      }
    }
    return state.current;
  }

  // Handle number-key selection (1/2/3). Returns the selected kind
  // or null when the key is not a weapon key.
  function handleKey(key) {
    for (const kind of WEAPON_ORDER) {
      if (WEAPON_DEFS[kind].key === key) {
        select(kind);
        return kind;
      }
    }
    return null;
  }

  // Walking over a crate picks the weapon up and gives ammo.
  // Returns the crate's weapon kind, or null when nothing was picked.
  function pickupCrate(crates, playerX, playerY) {
    for (const crate of crates) {
      if (crate.taken) continue;
      const dx = crate.x - playerX;
      const dy = crate.y - playerY;
      if (dx * dx + dy * dy <= crate.radius * crate.radius) {
        crate.taken = true;
        state.owned[crate.kind] = true;
        state.ammo[crate.kind] += WEAPON_DEFS[crate.kind].crateAmmo;
        state.current = crate.kind;
        return crate.kind;
      }
    }
    return null;
  }

  // Arena ammo pickups: { x, y, kind, amount, taken, radius }.
  // The autopilot grabs one when its current weapon's ammo <= 6.
  function pickupAmmo(pickups, playerX, playerY) {
    for (const p of pickups) {
      if (p.taken) continue;
      const dx = p.x - playerX;
      const dy = p.y - playerY;
      if (dx * dx + dy * dy <= p.radius * p.radius) {
        p.taken = true;
        state.ammo[p.kind] = (state.ammo[p.kind] || 0) + p.amount;
        return p.kind;
      }
    }
    return null;
  }

  function addAmmo(kind, amount) {
    state.ammo[kind] = (state.ammo[kind] || 0) + amount;
  }

  function update(dt) {
    if (state.cooldown > 0) state.cooldown -= dt;
  }

  function hudText() {
    return `${def().name}  ${state.ammo[state.current]}`;
  }

  // Save/load payload (owned weapons + ammo + current selection).
  function serialize() {
    return {
      current: state.current,
      owned: { ...state.owned },
      ammo: { ...state.ammo },
    };
  }

  function deserialize(data) {
    if (!data) return;
    if (data.owned) state.owned = { ...state.owned, ...data.owned };
    if (data.ammo) state.ammo = { ...state.ammo, ...data.ammo };
    if (data.current && state.owned[data.current]) state.current = data.current;
  }

  return {
    state,
    def,
    canFire,
    fire,
    select,
    cycle,
    handleKey,
    pickupCrate,
    pickupAmmo,
    addAmmo,
    update,
    hudText,
    serialize,
    deserialize,
  };
}
