// garage.js — Fixer Garage upgrades (prose spec §3.3).
// The Fixer Garage (the mission-giver location) becomes a real garage.
// Drive into the garage zone and press E (or a menu button) to open the
// upgrade menu (a DOM overlay, pausing the world). Spend cash on:
// Engine (3 levels, +top speed each), Armor (3 levels, damage
// resistance), Tires (2 levels, better handling/turning), Brakes (2
// levels, shorter stopping distance). Prices rise per level (roughly
// 800 / 1,500 / 2,500 for engine levels; armor and tires/brakes cheaper
// than engine). Upgrades apply to the player's CURRENT car and stay on
// that car (stored per car). Also offer paint: 6 colours for a small fee
// (visual only, separate from the Spray Shop, which still only clears
// heat). The garage menu shows current levels and cash. m11 requires a
// purchase. The autopilot's garage step: drive to the garage, open the
// menu, buy the cheapest available upgrade, close, continue.

export const GARAGE_ZONE_RADIUS = 140;

export const PAINT_COLORS = [
  { id: 'midnight', name: 'Midnight Blue', css: '#1d3557' },
  { id: 'crimson', name: 'Crimson', css: '#c1121f' },
  { id: 'sunset', name: 'Sunset Orange', css: '#f48c06' },
  { id: 'mint', name: 'Mint', css: '#2a9d8f' },
  { id: 'violet', name: 'Violet', css: '#7b2cbf' },
  { id: 'pearl', name: 'Pearl White', css: '#edf2f4' },
];
export const PAINT_PRICE = 200;

export const UPGRADE_DEFS = {
  engine: {
    name: 'Engine',
    desc: '+top speed each level',
    maxLevel: 3,
    prices: [800, 1500, 2500],
    // Applied to the car: top speed multiplier per level.
    topSpeedBonus: [0, 0.12, 0.25, 0.4],
  },
  armor: {
    name: 'Armor',
    desc: 'damage resistance',
    maxLevel: 3,
    prices: [500, 900, 1500],
    // Damage taken multiplier per level.
    damageTaken: [1, 0.85, 0.7, 0.55],
  },
  tires: {
    name: 'Tires',
    desc: 'better handling / turning',
    maxLevel: 2,
    prices: [400, 800],
    // Turn authority multiplier per level.
    turnBonus: [0, 0.2, 0.4],
  },
  brakes: {
    name: 'Brakes',
    desc: 'shorter stopping distance',
    maxLevel: 2,
    prices: [400, 800],
    // Braking force multiplier per level.
    brakeBonus: [0, 0.3, 0.6],
  },
};

export const UPGRADE_KEYS = ['engine', 'armor', 'tires', 'brakes'];

// A fresh per-car upgrade record. Stored on the car object itself so
// upgrades stay on that car when the player switches cars.
export function createCarUpgrades() {
  return { engine: 0, armor: 0, tires: 0, brakes: 0, paint: null };
}

export function createGarage(world) {
  // world is expected to provide:
  //   world.garageX, world.garageY -> Fixer Garage zone centre
  //   world.playerCar() -> the player's current car object (or null)
  //   world.cash / world.addCash(amount) -> player's cash
  //   world.setPaused(bool) -> pause the world while the menu is open
  const garage = {
    open: false,
    purchasedThisVisit: false, // m11: true once any purchase is made
    totalPurchases: 0,
  };

  let menuEl = null;

  function carUpgrades() {
    const car = world.playerCar ? world.playerCar() : null;
    if (!car) return null;
    if (!car.upgrades) car.upgrades = createCarUpgrades();
    return car.upgrades;
  }

  function inZone() {
    const p = world.player;
    const dx = p.x - world.garageX;
    const dy = p.y - world.garageY;
    return dx * dx + dy * dy <= GARAGE_ZONE_RADIUS * GARAGE_ZONE_RADIUS;
  }

  function priceOf(kind) {
    const up = carUpgrades();
    if (!up) return null;
    const level = up[kind];
    const def = UPGRADE_DEFS[kind];
    if (level >= def.maxLevel) return null; // maxed out
    return def.prices[level];
  }

  // Buy one upgrade level for the current car. Returns true on success.
  function buy(kind) {
    const up = carUpgrades();
    if (!up) return false;
    const price = priceOf(kind);
    if (price === null) return false; // already maxed
    if (world.cash < price) return false;
    world.addCash(-price);
    up[kind] += 1;
    garage.purchasedThisVisit = true;
    garage.totalPurchases += 1;
    refreshMenu();
    return true;
  }

  // Paint the current car one of 6 colours, small fee, visual only.
  function buyPaint(colorId) {
    const up = carUpgrades();
    if (!up) return false;
    const color = PAINT_COLORS.find((c) => c.id === colorId);
    if (!color) return false;
    if (world.cash < PAINT_PRICE) return false;
    world.addCash(-PAINT_PRICE);
    up.paint = colorId;
    const car = world.playerCar();
    if (car) car.color = color.css;
    garage.purchasedThisVisit = true;
    garage.totalPurchases += 1;
    refreshMenu();
    return true;
  }

  // Cheapest available upgrade for the current car (autopilot's m11
  // step: buy the cheapest, close, continue).
  function cheapestAvailable() {
    let best = null;
    let bestPrice = Infinity;
    for (const kind of UPGRADE_KEYS) {
      const price = priceOf(kind);
      if (price !== null && price < bestPrice) {
        best = kind;
        bestPrice = price;
      }
    }
    return best;
  }

  function buyCheapest() {
    const kind = cheapestAvailable();
    if (!kind) return false;
    return buy(kind);
  }

  // --- DOM overlay menu (pauses the world while open) ---
  function openMenu() {
    if (garage.open) return;
    garage.open = true;
    garage.purchasedThisVisit = false;
    if (world.setPaused) world.setPaused(true);
    buildMenu();
  }

  function closeMenu() {
    if (!garage.open) return;
    garage.open = false;
    if (world.setPaused) world.setPaused(false);
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }

  function buildMenu() {
    menuEl = document.createElement('div');
    menuEl.id = 'garage-menu';
    menuEl.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.65);z-index:40;font-family:sans-serif;color:#fff;';
    refreshMenu();
    document.body.appendChild(menuEl);
  }

  function refreshMenu() {
    if (!menuEl) return;
    const up = carUpgrades();
    const cash = world.cash;
    let rows = '';
    for (const kind of UPGRADE_KEYS) {
      const def = UPGRADE_DEFS[kind];
      const level = up ? up[kind] : 0;
      const price = priceOf(kind);
      const label =
        price === null ? 'MAX' : `$${price}`;
      rows += `<div style="display:flex;justify-content:space-between;gap:16px;margin:6px 0;">
        <span>${def.name} — Lv ${level}/${def.maxLevel} <small style="opacity:.7">${def.desc}</small></span>
        <button data-upgrade="${kind}" ${price === null || cash < price ? 'disabled' : ''}
          style="padding:6px 14px;cursor:pointer;">${label}</button>
      </div>`;
    }
    let paints = '';
    for (const c of PAINT_COLORS) {
      paints += `<button data-paint="${c.id}" style="width:34px;height:34px;border-radius:50%;
        background:${c.css};border:2px solid #fff;margin:4px;cursor:pointer;" title="${c.name}"></button>`;
    }
    menuEl.innerHTML = `<div style="background:#14213d;border:2px solid #fca311;border-radius:12px;
        padding:24px;min-width:420px;">
      <h2 style="margin:0 0 4px;">Fixer Garage</h2>
      <p style="margin:0 0 12px;opacity:.8;">Cash: $${cash} &nbsp;·&nbsp; Paint $${PAINT_PRICE} (visual only)</p>
      ${rows}
      <div style="margin-top:12px;"><div>Paint:</div>${paints}</div>
      <button id="garage-close" style="margin-top:16px;padding:8px 20px;cursor:pointer;">Close (E)</button>
    </div>`;
    menuEl.querySelectorAll('[data-upgrade]').forEach((btn) => {
      btn.addEventListener('click', () => buy(btn.dataset.upgrade));
    });
    menuEl.querySelectorAll('[data-paint]').forEach((btn) => {
      btn.addEventListener('click', () => buyPaint(btn.dataset.paint));
    });
    const closeBtn = menuEl.querySelector('#garage-close');
    if (closeBtn) closeBtn.addEventListener('click', closeMenu);
  }

  // Called on the E key: open when in the zone, close when open.
  function onInteractKey() {
    if (garage.open) {
      closeMenu();
      return true;
    }
    if (inZone() && world.playerCar && world.playerCar()) {
      openMenu();
      return true;
    }
    return false;
  }

  function drawZoneHint(ctx, camera) {
    if (garage.open) return;
    const sx = world.garageX - camera.x;
    const sy = world.garageY - camera.y;
    ctx.strokeStyle = 'rgba(252, 163, 17, 0.7)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.arc(sx, sy, GARAGE_ZONE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (inZone()) {
      ctx.fillStyle = '#fca311';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Press E — Fixer Garage', sx, sy - GARAGE_ZONE_RADIUS - 10);
    }
  }

  return {
    garage,
    inZone,
    priceOf,
    buy,
    buyPaint,
    cheapestAvailable,
    buyCheapest,
    openMenu,
    closeMenu,
    onInteractKey,
    drawZoneHint,
  };
}
