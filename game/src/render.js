// render.js — the Canvas 2D renderer for Crescent Bay.
//
// Two layers, as the prose spec's performance lesson demands: the whole
// static city is painted once into a 1600 x 1600 offscreen canvas (half
// scale of the 3200 world) and blitted each frame, so only the moving
// things — cars, people, police, the helicopter, bullets, pickups — are
// drawn per frame. A full-city repaint every frame stalled software
// rendering in an earlier build; this module never does one.
//
// The HUD is drawn on the canvas (spec section 1): wanted stars at least
// 36 px, the objective banner at least 28 px bold over a dark scrim in
// the lower-left, the minimap at least 180 px in the upper-right, a thick
// health bar, and large cash / speed / ammo readouts. Title, pause and
// game-over screens are DOM overlays owned by index.html; the renderer
// only paints the world behind them.
//
// The renderer reads one `game` state object. Every list it draws is
// optional (missing means empty) so a partially wired build still draws.
//
//   game.world        { buildings, lamps, parkedBays, pier } (world.js)
//   game.camera       { x, y, width, height } — top-left of the view
//   game.player       { x, y, angle, health, maxHealth, cash, speed,
//                       onFoot, weaponName, ammo, color }
//   game.cars         [{ x, y, angle, color, kind, headlights }]
//   game.pedestrians  [{ x, y, angle, color, speed }]
//   game.police       [{ x, y, angle, kind }]  (kind: 'foot' | 'car')
//   game.enemies      [{ x, y, angle, hp, color }]
//   game.helicopter   { x, y, smoking, spotlightX, spotlightY } | null
//   game.bullets      [{ x, y, angle }]
//   game.pickups      [{ x, y, kind, color }]  (kind: 'health'|'ammo'|'crate')
//   game.particles    [{ x, y, color, size, life }]
//   game.heat, game.stars, game.objective { text, x, y } | null,
//   game.timeHour, game.daylight, game.radio { name, level },
//   game.missionName, game.missionTimer, game.state

import { WORLD_SIZE, ROAD_LINES, ROAD_WIDTH, BEACH_START, WATER_START, districtAt, daylightAt } from './world.js';

const STATIC_SCALE = 0.5;
const STATIC_SIZE = WORLD_SIZE * STATIC_SCALE;

const DISTRICT_GROUND = {
  northside: '#b7c48a',
  oldtown: '#b09a7e',
  downtown: '#9aa3ad',
  waterfront: '#e3d3a4',
  docks: '#8d9299',
};

function shadeColor(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * factor)));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.staticLayer = null;
    this.world = null;
  }

  resize(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  // Paint the static city once. Called when the world is built and again
  // only if the world itself changes.
  buildStaticLayer(world) {
    this.world = world;
    const layer = document.createElement('canvas');
    layer.width = STATIC_SIZE;
    layer.height = STATIC_SIZE;
    const g = layer.getContext('2d');

    // Ground, district by district, in 400-unit blocks.
    for (let bx = 0; bx < 8; bx++) {
      for (let by = 0; by < 8; by++) {
        const x = bx * 400;
        const y = by * 400;
        const district = districtAt(x + 200, y + 200);
        g.fillStyle = DISTRICT_GROUND[district];
        g.fillRect(x * STATIC_SCALE, y * STATIC_SCALE, 400 * STATIC_SCALE, 400 * STATIC_SCALE);
      }
    }

    // Water and beach at the east edge.
    g.fillStyle = '#e8d9a8';
    g.fillRect(BEACH_START * STATIC_SCALE, 0, (WATER_START - BEACH_START) * STATIC_SCALE, STATIC_SIZE);
    g.fillStyle = '#2f7fb8';
    g.fillRect(WATER_START * STATIC_SCALE, 0, (WORLD_SIZE - WATER_START) * STATIC_SCALE, STATIC_SIZE);
    g.fillStyle = 'rgba(255,255,255,0.25)';
    for (let y = 0; y < WORLD_SIZE; y += 90) {
      g.fillRect(WATER_START * STATIC_SCALE, y * STATIC_SCALE, 26 * STATIC_SCALE, 3);
    }

    // Roads: dark asphalt with a pale centre line and sidewalks.
    for (const line of ROAD_LINES) {
      g.fillStyle = '#c9c2b4';
      g.fillRect(0, (line - ROAD_WIDTH / 2 - 10) * STATIC_SCALE, STATIC_SIZE, (ROAD_WIDTH + 20) * STATIC_SCALE);
      g.fillRect((line - ROAD_WIDTH / 2 - 10) * STATIC_SCALE, 0, (ROAD_WIDTH + 20) * STATIC_SCALE, STATIC_SIZE);
      g.fillStyle = '#3c3f45';
      g.fillRect(0, (line - ROAD_WIDTH / 2) * STATIC_SCALE, STATIC_SIZE, ROAD_WIDTH * STATIC_SCALE);
      g.fillRect((line - ROAD_WIDTH / 2) * STATIC_SCALE, 0, ROAD_WIDTH * STATIC_SCALE, STATIC_SIZE);
      g.fillStyle = '#d8d23e';
      g.fillRect(0, (line - 2) * STATIC_SCALE, STATIC_SIZE, 4 * STATIC_SCALE);
      g.fillRect((line - 2) * STATIC_SCALE, 0, 4 * STATIC_SCALE, STATIC_SIZE);
    }

    // The pier reaching into the water from the marina.
    if (world.pier) {
      g.fillStyle = '#8a6f4d';
      g.fillRect(
        world.pier.x0 * STATIC_SCALE, world.pier.y0 * STATIC_SCALE,
        (world.pier.x1 - world.pier.x0) * STATIC_SCALE,
        (world.pier.y1 - world.pier.y0) * STATIC_SCALE,
      );
      g.fillStyle = '#6f5840';
      for (let x = world.pier.x0 + 20; x < world.pier.x1; x += 40) {
        g.fillRect(x * STATIC_SCALE, world.pier.y0 * STATIC_SCALE, 3, (world.pier.y1 - world.pier.y0) * STATIC_SCALE);
      }
    }

    // Buildings, 2.5D: a blue-purple shadow to the south-east (sun from
    // the north-west), the body, darker south and east sides, and a
    // lighter roof with a rim.
    for (const b of world.buildings || []) {
      const h = b.height * STATIC_SCALE;
      const x = b.x * STATIC_SCALE;
      const y = b.y * STATIC_SCALE;
      const w = b.w * STATIC_SCALE;
      const d = b.h * STATIC_SCALE;
      g.fillStyle = 'rgba(70,70,160,0.30)';
      g.fillRect(x + h * 0.35, y + h * 0.35, w, d);
      g.fillStyle = shadeColor(b.color, 0.55);
      g.fillRect(x, y + d, w, h * 0.45);
      g.fillStyle = shadeColor(b.color, 0.7);
      g.fillRect(x + w, y, h * 0.45, d);
      g.fillStyle = b.color;
      g.fillRect(x, y, w, d);
      g.fillStyle = shadeColor(b.color, 1.25);
      g.fillRect(x + 2, y + 2, w - 4, d - 4);
      g.strokeStyle = 'rgba(0,0,0,0.25)';
      g.lineWidth = 1;
      g.strokeRect(x, y, w, d);
      // Roof details: a darker inset for towers, a pale cap for houses.
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(x + w * 0.2, y + d * 0.2, w * 0.25, d * 0.25);
    }

    // Street lamps as small posts with a pale head.
    g.fillStyle = '#3a3a3a';
    for (const lamp of world.lamps || []) {
      g.fillRect(lamp.x * STATIC_SCALE - 2, lamp.y * STATIC_SCALE - 2, 4, 4);
    }

    this.staticLayer = layer;
  }

  // --- One frame ---------------------------------------------------------

  render(game, dt) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    const cam = game.camera;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (this.staticLayer) {
      ctx.drawImage(
        this.staticLayer,
        cam.x * STATIC_SCALE, cam.y * STATIC_SCALE,
        cam.width * STATIC_SCALE, cam.height * STATIC_SCALE,
        0, 0, canvas.width, canvas.height,
      );
    }

    const scale = canvas.width / cam.width;
    const toScreenX = (x) => (x - cam.x) * scale;
    const toScreenY = (y) => (y - cam.y) * scale;

    ctx.save();
    // Parked bays.
    for (const bay of (this.world && this.world.parkedBays) || []) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(toScreenX(bay.x) - 24 * scale, toScreenY(bay.y) - 12 * scale, 48 * scale, 24 * scale);
    }
    // Pickups and weapon crates.
    for (const p of game.pickups || []) this._drawPickup(ctx, p, toScreenX, toScreenY, scale);
    // Cars (traffic, parked, player car is drawn with the player).
    for (const car of game.cars || []) this._drawCar(ctx, car, toScreenX, toScreenY, scale);
    // Pedestrians.
    for (const ped of game.pedestrians || []) this._drawPerson(ctx, ped, toScreenX, toScreenY, scale);
    // Enemies.
    for (const e of game.enemies || []) this._drawEnemy(ctx, e, toScreenX, toScreenY, scale);
    // Police.
    for (const cop of game.police || []) {
      if (cop.kind === 'car') this._drawCar(ctx, cop, toScreenX, toScreenY, scale);
      else this._drawPerson(ctx, cop, toScreenX, toScreenY, scale);
    }
    // The player (on foot, or driving — the car is drawn under them).
    if (game.player) this._drawPlayer(ctx, game.player, toScreenX, toScreenY, scale);
    // Bullets and particles.
    for (const b of game.bullets || []) {
      ctx.strokeStyle = '#ffe14d';
      ctx.lineWidth = Math.max(2, 3 * scale);
      const bx = toScreenX(b.x);
      const by = toScreenY(b.y);
      ctx.beginPath();
      ctx.moveTo(bx - Math.cos(b.angle) * 14 * scale, by - Math.sin(b.angle) * 14 * scale);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    for (const p of game.particles || []) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(toScreenX(p.x) - p.size / 2, toScreenY(p.y) - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    // Helicopter: shadow and spotlight on the ground, body above.
    if (game.helicopter) this._drawHelicopter(ctx, game.helicopter, toScreenX, toScreenY, scale, dt);
    ctx.restore();

    // Night: a dark blue tint plus headlight cones and lamp pools.
    const daylight = game.daylight !== undefined ? game.daylight : daylightAt(game.timeHour || 12);
    if (daylight < 0.85) {
      ctx.fillStyle = 'rgba(8,12,40,' + (0.55 * (1 - daylight)).toFixed(3) + ')';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const glow = (x, y, radius, alpha) => {
        const grad = ctx.createRadialGradient(x, y, 4, x, y, radius);
        grad.addColorStop(0, 'rgba(255,240,180,' + alpha + ')');
        grad.addColorStop(1, 'rgba(255,240,180,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      };
      for (const lamp of (this.world && this.world.lamps) || []) {
        const lx = toScreenX(lamp.x);
        const ly = toScreenY(lamp.y);
        if (lx > -80 && lx < canvas.width + 80 && ly > -80 && ly < canvas.height + 80) {
          glow(lx, ly, 90 * scale, 0.35);
        }
      }
      for (const car of game.cars || []) {
        if (!car.headlights) continue;
        const hx = toScreenX(car.x + Math.cos(car.angle) * 30);
        const hy = toScreenY(car.y + Math.sin(car.angle) * 30);
        glow(hx, hy, 110 * scale, 0.5);
      }
      if (game.player && game.player.car) {
        const p = game.player;
        glow(toScreenX(p.x + Math.cos(p.angle) * 30), toScreenY(p.y + Math.sin(p.angle) * 30), 120 * scale, 0.55);
      }
      ctx.restore();
    }

    // Mission marker: a tall pulsing beacon over the objective point.
    if (game.objective && game.objective.x !== undefined) {
      const mx = toScreenX(game.objective.x);
      const my = toScreenY(game.objective.y);
      if (mx > -60 && mx < canvas.width + 60 && my > -60 && my < canvas.height + 60) {
        const pulse = 0.6 + 0.4 * Math.sin((game.time || 0) * 4);
        ctx.strokeStyle = 'rgba(255,214,64,' + pulse.toFixed(2) + ')';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(mx, my, 26 * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#ffd640';
        ctx.beginPath();
        ctx.arc(mx, my, 6 * scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (game.state === 'playing' || game.state === 'paused') this._drawHud(ctx, game);
  }

  // --- Entities ----------------------------------------------------------

  _drawCar(ctx, car, toScreenX, toScreenY, scale) {
    const x = toScreenX(car.x);
    const y = toScreenY(car.y);
    const len = (car.length || 46) * scale;
    const wid = (car.width || 22) * scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(car.angle || 0);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-len / 2 + 3, -wid / 2 + 3, len, wid);
    ctx.fillStyle = car.color || '#c0392b';
    ctx.beginPath();
    ctx.roundRect(-len / 2, -wid / 2, len, wid, 6 * scale);
    ctx.fill();
    ctx.fillStyle = 'rgba(20,30,45,0.85)';
    ctx.beginPath();
    ctx.roundRect(-len * 0.18, -wid * 0.32, len * 0.36, wid * 0.64, 3 * scale);
    ctx.fill();
    ctx.fillStyle = '#ffe9a8';
    ctx.fillRect(len / 2 - 3 * scale, -wid / 2 + 2 * scale, 3 * scale, 4 * scale);
    ctx.fillRect(len / 2 - 3 * scale, wid / 2 - 6 * scale, 3 * scale, 4 * scale);
    if (car.kind === 'police') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-len * 0.1, -wid / 2, len * 0.2, wid);
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(-len * 0.32, -wid / 2 - 2 * scale, 8 * scale, 4 * scale);
      ctx.fillStyle = '#2f7bff';
      ctx.fillRect(-len * 0.32, wid / 2 - 2 * scale, 8 * scale, 4 * scale);
    }
    ctx.restore();
  }

  _drawPerson(ctx, person, toScreenX, toScreenY, scale) {
    const x = toScreenX(person.x);
    const y = toScreenY(person.y);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(2, 3, 9 * scale, 6 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = person.color || '#e8e0d0';
    ctx.beginPath();
    ctx.arc(0, 0, 8 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = person.shirt || '#4a7fb5';
    ctx.beginPath();
    ctx.arc(0, 0, 5 * scale, 0, Math.PI * 2);
    ctx.fill();
    // Facing tick.
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(person.angle || 0) * 10 * scale, Math.sin(person.angle || 0) * 10 * scale);
    ctx.stroke();
    ctx.restore();
  }

  _drawEnemy(ctx, enemy, toScreenX, toScreenY, scale) {
    this._drawPerson(ctx, { ...enemy, color: '#d8d8d8', shirt: '#a83232' }, toScreenX, toScreenY, scale);
    if (enemy.hp !== undefined && enemy.maxHp) {
      const x = toScreenX(enemy.x);
      const y = toScreenY(enemy.y);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x - 14 * scale, y - 18 * scale, 28 * scale, 4 * scale);
      ctx.fillStyle = '#ff4d4d';
      ctx.fillRect(x - 14 * scale, y - 18 * scale, 28 * scale * Math.max(0, enemy.hp / enemy.maxHp), 4 * scale);
    }
  }

  _drawPlayer(ctx, player, toScreenX, toScreenY, scale) {
    if (!player.onFoot && player.car) {
      this._drawCar(ctx, player.car, toScreenX, toScreenY, scale);
      return;
    }
    const x = toScreenX(player.x);
    const y = toScreenY(player.y);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(2, 3, 10 * scale, 7 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    // Rook: teal jacket, dark hair, a gun barrel showing the aim.
    ctx.fillStyle = '#1f8a70';
    ctx.beginPath();
    ctx.arc(0, 0, 9 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#22242a';
    ctx.beginPath();
    ctx.arc(0, 0, 5 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2b2b2b';
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(player.angle || 0) * 16 * scale, Math.sin(player.angle || 0) * 16 * scale);
    ctx.stroke();
    ctx.restore();
  }

  _drawPickup(ctx, pickup, toScreenX, toScreenY, scale) {
    const x = toScreenX(pickup.x);
    const y = toScreenY(pickup.y);
    const bob = Math.sin((pickup.bob || 0) + (pickup.x || 0)) * 2;
    ctx.save();
    ctx.translate(x, y + bob);
    if (pickup.kind === 'crate') {
      ctx.fillStyle = '#8a6f3c';
      ctx.fillRect(-11 * scale, -11 * scale, 22 * scale, 22 * scale);
      ctx.strokeStyle = '#5d4a26';
      ctx.lineWidth = 2;
      ctx.strokeRect(-11 * scale, -11 * scale, 22 * scale, 22 * scale);
      ctx.fillStyle = '#ffe14d';
      ctx.font = 'bold ' + Math.round(13 * scale) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pickup.label || 'W', 0, 0);
    } else {
      ctx.fillStyle = pickup.color || (pickup.kind === 'health' ? '#3ddc5f' : '#ffd640');
      ctx.beginPath();
      ctx.arc(0, 0, 9 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1c1c1c';
      ctx.font = 'bold ' + Math.round(12 * scale) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pickup.kind === 'health' ? '+' : 'A', 0, 0);
    }
    ctx.restore();
  }

  _drawHelicopter(ctx, heli, toScreenX, toScreenY, scale, dt) {
    // Ground shadow and spotlight first (they sit on the world).
    const sx = toScreenX(heli.shadowX !== undefined ? heli.shadowX : heli.x);
    const sy = toScreenY(heli.shadowY !== undefined ? heli.shadowY : heli.y);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(sx, sy, 34 * scale, 18 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    if (heli.spotlightX !== undefined) {
      const lx = toScreenX(heli.spotlightX);
      const ly = toScreenY(heli.spotlightY);
      const grad = ctx.createRadialGradient(lx, ly, 6, lx, ly, 90 * scale);
      grad.addColorStop(0, 'rgba(255,250,200,0.5)');
      grad.addColorStop(1, 'rgba(255,250,200,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(lx, ly, 90 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    // Body, drawn offset up-left so it reads as flying above its shadow.
    const hx = toScreenX(heli.x) - 26 * scale;
    const hy = toScreenY(heli.y) - 34 * scale;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(heli.angle || 0);
    ctx.fillStyle = heli.smoking ? '#5a5a5a' : '#2e4a6b';
    ctx.beginPath();
    ctx.roundRect(-22 * scale, -10 * scale, 44 * scale, 20 * scale, 8 * scale);
    ctx.fill();
    ctx.fillStyle = '#9fd4ff';
    ctx.beginPath();
    ctx.roundRect(6 * scale, -7 * scale, 12 * scale, 14 * scale, 4 * scale);
    ctx.fill();
    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(-30 * scale, -3 * scale, 10 * scale, 6 * scale);
    // Rotor blur: a translucent disc spinning with time.
    ctx.strokeStyle = 'rgba(200,200,200,0.55)';
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.ellipse(0, 0, 34 * scale, 6 * scale, Math.sin((heli.rotor || 0)) * 0.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // Smoke trail while damaged.
    if (heli.smoking) {
      ctx.fillStyle = 'rgba(90,90,90,0.5)';
      ctx.beginPath();
      ctx.arc(hx - 18 * scale, hy + 6 * scale, 8 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // --- HUD (canvas) ------------------------------------------------------

  _drawHud(ctx, game) {
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Wanted stars, upper-left, at least 36 px each.
    const stars = game.stars || 0;
    const starSize = 38;
    for (let i = 0; i < 5; i++) {
      const x = 24 + i * (starSize + 6);
      const y = 26;
      ctx.font = starSize + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = i < stars ? '#ffd640' : 'rgba(255,255,255,0.25)';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 4;
      ctx.strokeText('★', x, y);
      ctx.fillText('★', x, y);
    }

    // Cash, speed and ammo, large, upper-left under the stars.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 5;
    const cashText = '$' + Math.floor(game.player ? game.player.cash || 0 : 0).toLocaleString('en-US');
    ctx.strokeText(cashText, 22, 84);
    ctx.fillText(cashText, 22, 84);
    const speed = game.player ? Math.round(Math.abs(game.player.speed || 0)) : 0;
    ctx.font = 'bold 22px sans-serif';
    ctx.strokeText(speed + ' mph', 22, 114);
    ctx.fillText(speed + ' mph', 22, 114);

    // Weapon name + ammo, large, lower-right.
    if (game.player && game.player.weaponName) {
      ctx.textAlign = 'right';
      ctx.font = 'bold 26px sans-serif';
      const weaponText = game.player.weaponName + '  ' + (game.player.ammo ?? '—');
      ctx.strokeText(weaponText, w - 22, h - 24);
      ctx.fillStyle = '#ffe14d';
      ctx.fillText(weaponText, w - 22, h - 24);
    }

    // Health bar, thick, lower-left above the objective banner.
    const health = game.player ? (game.player.health || 0) / (game.player.maxHealth || 100) : 1;
    const barW = 260;
    const barH = 18;
    const barX = 22;
    const barY = h - 118;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(barX - 3, barY - 3, barW + 6, barH + 6);
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = health > 0.5 ? '#3ddc5f' : health > 0.25 ? '#ffb02e' : '#ff4d4d';
    ctx.fillRect(barX, barY, barW * Math.max(0, Math.min(1, health)), barH);

    // Objective banner: at least 28 px bold over a dark scrim,
    // lower-left.
    if (game.objective && game.objective.text) {
      const text = game.objective.text;
      ctx.font = 'bold 28px sans-serif';
      const tw = ctx.measureText(text).width;
      const bx = 18;
      const by = h - 84;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(bx, by, tw + 28, 40);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(text, bx + 14, by + 29);
    }

    // Mission name + timer, top-centre.
    if (game.missionName) {
      ctx.textAlign = 'center';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 4;
      ctx.strokeText(game.missionName, w / 2, 30);
      ctx.fillText(game.missionName, w / 2, 30);
      if (game.missionTimer !== undefined && game.missionTimer !== null) {
        const t = Math.max(0, Math.ceil(game.missionTimer));
        const timerText = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
        ctx.font = 'bold 20px sans-serif';
        ctx.strokeText(timerText, w / 2, 56);
        ctx.fillStyle = t < 30 ? '#ff6b5e' : '#ffffff';
        ctx.fillText(timerText, w / 2, 56);
      }
    }

    // Radio: station name plus a small animated equalizer, top-right
    // below the minimap.
    if (game.radio && game.radio.name) {
      const bars = 5;
      const eqX = w - 208;
      const eqY = 212;
      ctx.textAlign = 'left';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText('♪ ' + game.radio.name, eqX, eqY);
      for (let i = 0; i < bars; i++) {
        const level = game.radio.levels ? game.radio.levels[i] || 0.3 : 0.3 + 0.3 * Math.abs(Math.sin((game.time || 0) * 6 + i));
        const bh = 4 + level * 14;
        ctx.fillStyle = '#7fe3c0';
        ctx.fillRect(eqX + i * 12, eqY + 8 - bh + 14, 8, bh);
      }
    }

    // Minimap, at least 180 px, upper-right.
    this._drawMinimap(ctx, game, w - 208, 16, 192);
  }

  _drawMinimap(ctx, game, x, y, size) {
    const scale = size / WORLD_SIZE;
    ctx.save();
    ctx.fillStyle = 'rgba(10,14,24,0.78)';
    ctx.fillRect(x - 4, y - 4, size + 8, size + 8);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 4, y - 4, size + 8, size + 8);
    // Water strip.
    ctx.fillStyle = '#2f7fb8';
    ctx.fillRect(x + WATER_START * scale, y, (WORLD_SIZE - WATER_START) * scale, size);
    // Roads.
    ctx.strokeStyle = '#c8c8c8';
    ctx.lineWidth = 2;
    for (const line of ROAD_LINES) {
      ctx.beginPath();
      ctx.moveTo(x, y + line * scale);
      ctx.lineTo(x + size, y + line * scale);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + line * scale, y);
      ctx.lineTo(x + line * scale, y + size);
      ctx.stroke();
    }
    // Mission objective marker.
    if (game.objective && game.objective.x !== undefined) {
      ctx.fillStyle = '#ffd640';
      ctx.beginPath();
      ctx.arc(x + game.objective.x * scale, y + game.objective.y * scale, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Police dots.
    ctx.fillStyle = '#4d9fff';
    for (const cop of game.police || []) {
      ctx.beginPath();
      ctx.arc(x + cop.x * scale, y + cop.y * scale, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Helicopter.
    if (game.helicopter) {
      ctx.fillStyle = '#ff8c1a';
      ctx.beginPath();
      ctx.arc(x + game.helicopter.x * scale, y + game.helicopter.y * scale, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Player: white dot with a dark ring, always on top.
    if (game.player) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x + game.player.x * scale, y + game.player.y * scale, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

export function createRenderer(canvas) {
  return new Renderer(canvas);
}
