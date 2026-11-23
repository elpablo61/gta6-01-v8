// Fixer Garage upgrades — Crescent Bay. Fresh from prose spec §3.3.
// The Fixer Garage (the mission-giver location) is a real garage. Drive
// into the garage zone and press E (or the menu button) to open the upgrade
// menu — a DOM overlay that pauses the world. Spend cash on upgrades for
// the player's CURRENT car; upgrades stay on that car (stored per car):
//   Engine — 3 levels, +top speed each level. Prices 800 / 1500 / 2500.
//   Armor  — 3 levels, damage resistance. Cheaper than engine.
//   Tires  — 2 levels, better handling / turning. Cheaper than engine.
//   Brakes — 2 levels, shorter stopping distance. Cheaper than engine.
// Paint is also on offer: 6 colours for a small fee, visual only. Paint
// is separate from the Spray Shop, which still only clears heat. The menu
// shows current levels and cash. Mission m11 needs at least one purchase.
// The autopilot's garage step: drive to the garage, open the menu, buy the
// cheapest available upgrade, close, continue.
//
// Shared-state contract (read defensively; missing fields get defaults):
//   game.player  { x, y, cash, car } — Rook; car is the current car object.
//   game.world.landmarks.fixerGarage { x, y } — garage zone centre; when
//                absent, DEFAULT_GARAGE_SPOT below is used instead.
//   game.paused  — set true while the menu is open, restored on close.
//   game.mission { id } — 'm11' reads hasPurchased() to complete.
//   game.audio   { play(name) } — optional sound hook.
// Upgrades live on the car object as car.upgrades { engine, armor, tires,
// brakes, paint }. A car without that field gets a fresh level-0 record.
// applyToCar(car) returns the numeric modifiers the driving code applies:
// topSpeedBonus, damageResistance (0..1), turnBonus, brakeBonus.
// The DOM overlay is built lazily (guarded: no document in Node). In a
// headless environment the same buy logic runs through the virtual menu
// state (menuRows), so tests can drive purchases without a browser.

export const GARAGE_UPGRADE_DEFS = {
  engine: {
    id: 'engine',
    name: 'Engine',
    blurb: '+top speed each level',
    levels: 3,
    prices: [800, 1500, 2500],
    topSpeedBonusPerLevel: 70,
  },
  armor: {
    id: 'armor',
    name: 'Armor',
    blurb: 'damage resistance',
    levels: 3,
    prices: [500, 900, 1500],
    resistancePerLevel: 0.15,
  },
  tires: {
    id: 'tires',
    name: 'Tires',
    blurb: 'better handling and turning',
    levels: 2,
    prices: [400, 800],
    turnBonusPerLevel: 0.25,
  },
  brakes: {
    id: 'brakes',
    name: 'Brakes',
    blurb: 'shorter stopping distance',
    levels: 2,
    prices: [350, 700],
    brakeBonusPerLevel: 0.3,
  },
};

export const GARAGE_UPGRADE_ORDER = ['engine', 'armor', 'tires', 'brakes'];

export const GARAGE_PAINT_COLORS = [
  { id: 'crimson', name: 'Crimson', color: '#c0392b', price: 150 },
  { id: 'sunset', name: 'Sunset', color: '#e67e22', price: 150 },
  { id: 'banana', name: 'Banana', color: '#f1c40f', price: 150 },
  { id: 'teal', name: 'Teal', color: '#1abc9c', price: 150 },
  { id: 'ocean', name: 'Ocean', color: '#2471a3', price: 150 },
  { id: 'grape', name: 'Grape', color: '#8e44ad', price: 150 },
];

export const GARAGE_ZONE_RADIUS = 150;
export const DEFAULT_GARAGE_SPOT = { x: 600, y: 1000, label: 'fixer garage' };

export function emptyCarUpgrades() {
  return { engine: 0, armor: 0, tires: 0, brakes: 0, paint: null };
}

export function carUpgrades(car) {
  if (!car) return emptyCarUpgrades();
  if (!car.upgrades || typeof car.upgrades !== 'object') {
    car.upgrades = emptyCarUpgrades();
  }
  const u = car.upgrades;
  if (typeof u.engine !== 'number') u.engine = 0;
  if (typeof u.armor !== 'number') u.armor = 0;
  if (typeof u.tires !== 'number') u.tires = 0;
  if (typeof u.brakes !== 'number') u.brakes = 0;
  if (!('paint' in u)) u.paint = null;
  return u;
}

// Numeric modifiers the driving code applies for one car.
export function garageModifiersForCar(car) {
  const u = carUpgrades(car);
  return {
    topSpeedBonus: u.engine * GARAGE_UPGRADE_DEFS.engine.topSpeedBonusPerLevel,
    damageResistance: Math.min(
      0.6,
      u.armor * GARAGE_UPGRADE_DEFS.armor.resistancePerLevel,
    ),
    turnBonus: u.tires * GARAGE_UPGRADE_DEFS.tires.turnBonusPerLevel,
    brakeBonus: u.brakes * GARAGE_UPGRADE_DEFS.brakes.brakeBonusPerLevel,
    paint: u.paint,
  };
}

export function createFixerGarage(game) {
  const state = {
    open: false,
    purchases: 0,
    purchasesThisVisit: 0,
    lastPurchase: null,
    wasPausedBeforeOpen: false,
    menuElement: null,
    menuRows: [],
  };

  function playerCar() {
    const p = game && game.player;
    if (!p) return null;
    if (p.car) return p.car;
    if (game && game.car) return game.car;
    return null;
  }

  function playerCash() {
    const p = game && game.player;
    if (p && typeof p.cash === 'number') return p.cash;
    if (game && typeof game.cash === 'number') return game.cash;
    return 0;
  }

  function setCash(amount) {
    const p = game && game.player;
    if (p && typeof p.cash === 'number') p.cash = amount;
    if (game && typeof game.cash === 'number') game.cash = amount;
  }

  function garageSpot() {
    const marks = game && game.world && game.world.landmarks;
    if (marks && marks.fixerGarage && typeof marks.fixerGarage.x === 'number') {
      return marks.fixerGarage;
    }
    return DEFAULT_GARAGE_SPOT;
  }

  function distanceToGarage() {
    const p = game && game.player;
    const g = garageSpot();
    if (!p || typeof p.x !== 'number') return Infinity;
    const dx = g.x - p.x;
    const dy = g.y - p.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function isPlayerInZone() {
    return distanceToGarage() <= GARAGE_ZONE_RADIUS;
  }

  function playSound(name) {
    if (game && game.audio && typeof game.audio.play === 'function') {
      try { game.audio.play(name); } catch (e) { /* sound is optional */ }
    }
  }

  function refreshMenuRows() {
    const car = playerCar();
    const u = carUpgrades(car);
    const cash = playerCash();
    state.menuRows = GARAGE_UPGRADE_ORDER.map((id) => {
      const def = GARAGE_UPGRADE_DEFS[id];
      const level = u[id];
      const maxed = level >= def.levels;
      const price = maxed ? null : def.prices[level];
      return {
        kind: 'upgrade',
        id,
        name: def.name,
        blurb: def.blurb,
        level,
        maxLevel: def.levels,
        price,
        affordable: price !== null && cash >= price,
        maxed,
      };
    });
    for (const paint of GARAGE_PAINT_COLORS) {
      state.menuRows.push({
        kind: 'paint',
        id: paint.id,
        name: paint.name + ' paint',
        blurb: 'visual only',
        color: paint.color,
        price: paint.price,
        affordable: cash >= paint.price,
        current: u.paint === paint.id,
      });
    }
    return state.menuRows;
  }

  function buyUpgrade(id) {
    const def = GARAGE_UPGRADE_DEFS[id];
    if (!def) return { ok: false, reason: 'unknown upgrade' };
    const car = playerCar();
    if (!car) return { ok: false, reason: 'no car' };
    const u = carUpgrades(car);
    if (u[id] >= def.levels) return { ok: false, reason: 'maxed out' };
    const price = def.prices[u[id]];
    if (playerCash() < price) return { ok: false, reason: 'not enough cash' };
    setCash(playerCash() - price);
    u[id] += 1;
    state.purchases += 1;
    state.purchasesThisVisit += 1;
    state.lastPurchase = { kind: 'upgrade', id, level: u[id], price, at: Date.now() };
    playSound('garage-buy');
    if (game) game.garagePurchase = state.lastPurchase;
    refreshMenuRows();
    renderMenu();
    return { ok: true, id, level: u[id], price };
  }

  function buyPaint(colorId) {
    const paint = GARAGE_PAINT_COLORS.find((c) => c.id === colorId);
    if (!paint) return { ok: false, reason: 'unknown paint' };
    const car = playerCar();
    if (!car) return { ok: false, reason: 'no car' };
    if (playerCash() < paint.price) return { ok: false, reason: 'not enough cash' };
    const u = carUpgrades(car);
    setCash(playerCash() - paint.price);
    u.paint = paint.id;
    car.color = paint.color;
    state.purchases += 1;
    state.purchasesThisVisit += 1;
    state.lastPurchase = { kind: 'paint', id: paint.id, price: paint.price, at: Date.now() };
    playSound('garage-buy');
    if (game) game.garagePurchase = state.lastPurchase;
    refreshMenuRows();
    renderMenu();
    return { ok: true, id: paint.id, price: paint.price };
  }

  // The autopilot's garage step: buy the cheapest available upgrade.
  function buyCheapestAvailable() {
    const car = playerCar();
    if (!car) return { ok: false, reason: 'no car' };
    const u = carUpgrades(car);
    const cash = playerCash();
    let best = null;
    for (const id of GARAGE_UPGRADE_ORDER) {
      const def = GARAGE_UPGRADE_DEFS[id];
      if (u[id] >= def.levels) continue;
      const price = def.prices[u[id]];
      if (cash < price) continue;
      if (!best || price < best.price) best = { id, price };
    }
    if (!best) return { ok: false, reason: 'nothing affordable' };
    return buyUpgrade(best.id);
  }

  function hasPurchased() {
    return state.purchases > 0;
  }

  function open() {
    if (state.open) return true;
    if (!isPlayerInZone()) return false;
    state.wasPausedBeforeOpen = !!(game && game.paused);
    if (game) game.paused = true;
    state.open = true;
    state.purchasesThisVisit = 0;
    refreshMenuRows();
    renderMenu();
    playSound('menu-open');
    if (game) game.garageOpen = true;
    return true;
  }

  function close() {
    if (!state.open) return false;
    state.open = false;
    if (game) {
      game.paused = state.wasPausedBeforeOpen;
      game.garageOpen = false;
    }
    removeMenu();
    playSound('menu-close');
    return true;
  }

  function toggle() {
    return state.open ? close() : open();
  }

  function update() {
    if (state.open) return state;
    return state;
  }

  // E opens the menu when the player is in the garage zone. The main loop
  // may call this with its own input object; it returns true when consumed.
  function onKey(code) {
    if (code === 'KeyE') {
      if (state.open) return close();
      if (isPlayerInZone()) return open();
    }
    if (code === 'Escape' && state.open) return close();
    return false;
  }

  function renderMenu() {
    if (typeof document === 'undefined') return;
    if (!state.open) return;
    let el = state.menuElement;
    if (!el) {
      el = document.createElement('div');
      el.id = 'garage-menu';
      el.className = 'overlay-menu';
      state.menuElement = el;
      const host = document.getElementById('game-root') || document.body;
      host.appendChild(el);
    }
    const car = playerCar();
    const u = carUpgrades(car);
    const cash = playerCash();
    const rows = refreshMenuRows();
    let html = '<h2>Fixer Garage</h2>';
    html += '<p class="garage-cash">Cash: $' + cash + '</p>';
    html += '<div class="garage-rows">';
    for (const row of rows) {
      if (row.kind === 'upgrade') {
        html += '<div class="garage-row"><span>' + row.name + ' — level ' + row.level +
          '/' + row.maxLevel + ' <em>' + row.blurb + '</em></span>';
        if (row.maxed) html += '<span>MAX</span>';
        else html += '<button data-buy="' + row.id + '"' + (row.affordable ? '' : ' disabled') +
          '>Buy $' + row.price + '</button>';
        html += '</div>';
      } else {
        html += '<div class="garage-row"><span style="color:' + row.color + '">\u25CF</span> ' +
          row.name + (row.current ? ' (on car)' : '') +
          '<button data-paint="' + row.id + '"' + (row.affordable ? '' : ' disabled') +
          '>Paint $' + row.price + '</button></div>';
      }
    }
    html += '</div><button data-close="1">Close (Esc)</button>';
    el.innerHTML = html;
    el.querySelectorAll('[data-buy]').forEach((btn) => {
      btn.addEventListener('click', () => buyUpgrade(btn.getAttribute('data-buy')));
    });
    el.querySelectorAll('[data-paint]').forEach((btn) => {
      btn.addEventListener('click', () => buyPaint(btn.getAttribute('data-paint')));
    });
    const closer = el.querySelector('[data-close]');
    if (closer) closer.addEventListener('click', () => close());
  }

  function removeMenu() {
    if (state.menuElement && state.menuElement.parentNode) {
      state.menuElement.parentNode.removeChild(state.menuElement);
    }
    state.menuElement = null;
  }

  function draw(ctx, camera) {
    if (!ctx) return;
    const g = garageSpot();
    const camX = (camera && camera.x) || 0;
    const camY = (camera && camera.y) || 0;
    const x = g.x - camX;
    const y = g.y - camY;
    ctx.strokeStyle = 'rgba(201, 162, 39, 0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, GARAGE_ZONE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#c9a227';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('FIXER GARAGE', x, y - GARAGE_ZONE_RADIUS - 8);
    if (isPlayerInZone() && !state.open) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('Press E — upgrades', x, y + 4);
    }
  }

  function snapshot() {
    const car = playerCar();
    return {
      open: state.open,
      inZone: isPlayerInZone(),
      cash: playerCash(),
      upgrades: car ? { ...carUpgrades(car) } : null,
      purchases: state.purchases,
      purchasesThisVisit: state.purchasesThisVisit,
      lastPurchase: state.lastPurchase,
    };
  }

  return {
    state,
    defs: GARAGE_UPGRADE_DEFS,
    paints: GARAGE_PAINT_COLORS,
    update,
    draw,
    onKey,
    open,
    close,
    toggle,
    buyUpgrade,
    buyPaint,
    buyCheapestAvailable,
    hasPurchased,
    isPlayerInZone,
    garageSpot,
    distanceToGarage,
    carUpgrades,
    modifiersForCar: garageModifiersForCar,
    menuRows: refreshMenuRows,
    snapshot,
  };
}

export default createFixerGarage;
