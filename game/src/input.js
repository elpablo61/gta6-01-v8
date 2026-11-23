// input.js — keyboard, mouse and touch input for Crescent Bay.
//
// One Input object owns every device. The game loop reads it once a frame
// through `update()` (which moves this frame's presses into the edge
// buffer), then asks `isDown` for held keys and `pressed` for keys that
// went down this frame only. Touch builds a virtual joystick on the left
// half of the screen and action buttons on the right, so the same queries
// answer for a phone as for a keyboard.
//
// Bindings (from the prose spec, section 1):
//   WASD / arrows ......... move on foot, steer and drive in a car
//   Shift ................. sprint on foot
//   Mouse ................. aim; left click shoots
//   E ..................... enter / exit a car, accept a dialog, open the
//                           garage, pick up
//   1 / 2 / 3 ............. pistol / SMG / shotgun
//   Q ..................... cycle to the next owned weapon
//   R ..................... cycle the radio station
//   P or Escape ........... pause
//   M ..................... mute

export const KEY_BINDINGS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyE'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  cycleWeapon: ['KeyQ'],
  radio: ['KeyR'],
  pause: ['KeyP', 'Escape'],
  mute: ['KeyM'],
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas || null;
    this.keys = new Set();
    this.justPressed = new Set();
    this.justReleased = new Set();

    // Mouse, in canvas pixels and in world units (filled by the game
    // each frame from the camera).
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseWorldX = 0;
    this.mouseWorldY = 0;
    this.mouseDown = false;
    this.mouseClicked = false;

    // Touch state: a virtual stick and held action buttons.
    this.touchActive = false;
    this.stickId = null;
    this.stickBaseX = 0;
    this.stickBaseY = 0;
    this.stickX = 0;
    this.stickY = 0;
    this.touchButtons = new Set();

    this._onKeyDown = (event) => this._keyDown(event);
    this._onKeyUp = (event) => this._keyUp(event);
    this._onMouseMove = (event) => this._mouseMove(event);
    this._onMouseDown = (event) => this._mouseDown(event);
    this._onMouseUp = (event) => this._mouseUp(event);
    this._onTouchStart = (event) => this._touchStart(event);
    this._onTouchMove = (event) => this._touchMove(event);
    this._onTouchEnd = (event) => this._touchEnd(event);
    this._onBlur = () => this._blur();
    this._onContextMenu = (event) => event.preventDefault();

    this.attached = false;
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    if (this.canvas) {
      this.canvas.addEventListener('mousemove', this._onMouseMove);
      this.canvas.addEventListener('mousedown', this._onMouseDown);
      window.addEventListener('mouseup', this._onMouseUp);
      this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
      this.canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
      this.canvas.addEventListener('touchend', this._onTouchEnd, { passive: false });
      this.canvas.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
      this.canvas.addEventListener('contextmenu', this._onContextMenu);
    }
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    if (this.canvas) {
      this.canvas.removeEventListener('mousemove', this._onMouseMove);
      this.canvas.removeEventListener('mousedown', this._onMouseDown);
      window.removeEventListener('mouseup', this._onMouseUp);
      this.canvas.removeEventListener('touchstart', this._onTouchStart);
      this.canvas.removeEventListener('touchmove', this._onTouchMove);
      this.canvas.removeEventListener('touchend', this._onTouchEnd);
      this.canvas.removeEventListener('touchcancel', this._onTouchEnd);
      this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    }
  }

  // Call once per frame, after the game has read the presses: it clears
  // the edge buffers so `pressed` is true for exactly one frame.
  update() {
    this.justPressed.clear();
    this.justReleased.clear();
    this.mouseClicked = false;
  }

  _keyDown(event) {
    if (event.repeat) return;
    this.keys.add(event.code);
    this.justPressed.add(event.code);
    // Keep the page from scrolling on game keys.
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) {
      event.preventDefault();
    }
  }

  _keyUp(event) {
    this.keys.delete(event.code);
    this.justReleased.add(event.code);
  }

  _blur() {
    this.keys.clear();
    this.mouseDown = false;
    this.touchButtons.clear();
    this.stickId = null;
    this.touchActive = false;
  }

  _canvasPos(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (this.canvas.width / rect.width),
      y: (event.clientY - rect.top) * (this.canvas.height / rect.height),
    };
  }

  _mouseMove(event) {
    const pos = this._canvasPos(event);
    this.mouseX = pos.x;
    this.mouseY = pos.y;
  }

  _mouseDown(event) {
    if (event.button !== 0) return;
    const pos = this._canvasPos(event);
    this.mouseX = pos.x;
    this.mouseY = pos.y;
    this.mouseDown = true;
    this.mouseClicked = true;
  }

  _mouseUp(event) {
    if (event.button !== 0) return;
    this.mouseDown = false;
  }

  _touchStart(event) {
    event.preventDefault();
    this.touchActive = true;
    for (const touch of event.changedTouches) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (touch.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (touch.clientY - rect.top) * (this.canvas.height / rect.height);
      if (x < this.canvas.width * 0.5 && this.stickId === null) {
        this.stickId = touch.identifier;
        this.stickBaseX = x;
        this.stickBaseY = y;
        this.stickX = 0;
        this.stickY = 0;
      } else {
        // Right half: upper area shoots, lower area interacts.
        if (y < this.canvas.height * 0.5) this.touchButtons.add('shoot');
        else this.touchButtons.add('interact');
      }
    }
  }

  _touchMove(event) {
    event.preventDefault();
    for (const touch of event.changedTouches) {
      if (touch.identifier !== this.stickId) continue;
      const rect = this.canvas.getBoundingClientRect();
      const x = (touch.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (touch.clientY - rect.top) * (this.canvas.height / rect.height);
      const dx = x - this.stickBaseX;
      const dy = y - this.stickBaseY;
      const len = Math.hypot(dx, dy);
      const max = 64;
      const scale = len > max ? max / len : 1;
      this.stickX = (dx * scale) / max;
      this.stickY = (dy * scale) / max;
    }
  }

  _touchEnd(event) {
    for (const touch of event.changedTouches) {
      if (touch.identifier === this.stickId) {
        this.stickId = null;
        this.stickX = 0;
        this.stickY = 0;
      }
    }
    if (event.touches.length === 0) {
      this.touchButtons.clear();
      this.touchActive = false;
    }
  }

  // --- Queries -----------------------------------------------------------

  isDown(code) {
    return this.keys.has(code);
  }

  pressed(code) {
    return this.justPressed.has(code);
  }

  // True while any key of a named action is held.
  actionDown(action) {
    const codes = KEY_BINDINGS[action] || [];
    for (const code of codes) if (this.keys.has(code)) return true;
    if (action === 'shoot') return this.mouseDown || this.touchButtons.has('shoot');
    if (action === 'interact') return this.touchButtons.has('interact');
    return false;
  }

  // True on the frame any key of a named action went down.
  actionPressed(action) {
    const codes = KEY_BINDINGS[action] || [];
    for (const code of codes) if (this.justPressed.has(code)) return true;
    return false;
  }

  // Movement axis from keys or the touch stick: x right, y down, each
  // in [-1, 1]. On foot this is a direction; in a car x steers and y is
  // throttle / brake.
  moveAxis() {
    let x = 0;
    let y = 0;
    if (this.actionDown('left')) x -= 1;
    if (this.actionDown('right')) x += 1;
    if (this.actionDown('up')) y -= 1;
    if (this.actionDown('down')) y += 1;
    if (this.stickId !== null) {
      x += this.stickX;
      y += this.stickY;
    }
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  // Aim angle in world space, from the player position toward the mouse
  // (or toward the movement direction when no mouse is present).
  aimAngle(playerX, playerY) {
    const dx = this.mouseWorldX - playerX;
    const dy = this.mouseWorldY - playerY;
    if (Math.hypot(dx, dy) < 4) return 0;
    return Math.atan2(dy, dx);
  }

  // The game fills the mouse's world position each frame from the camera.
  setMouseWorld(x, y) {
    this.mouseWorldX = x;
    this.mouseWorldY = y;
  }
}

// A single shared input for the page. main.js creates and attaches it.
export function createInput(canvas) {
  return new Input(canvas);
}
