// Crescent Bay — keyboard + mouse input. Fresh from prose spec §1.
// On foot: WASD / arrows move, mouse aims, click shoots, Shift sprints.
// Driving: E enters / exits a car, Space is the handbrake. Weapon keys
// 1 / 2 / 3, Q cycles weapons, R cycles the radio, E also accepts a
// dialog and opens the Fixer Garage menu. Esc / P pauses.
//
// One rule from the v1 rebuild notes shapes this whole module: a very
// quick mouse click must never be lost. The per-frame "just pressed"
// edge flags are therefore cleared ONLY at the end of the frame update
// (input.endFrame()), after all gameplay code has read them — never
// before — and a mouse press sets its edge flag immediately when the
// event fires. The main loop must call endFrame() once per frame, and
// also when leaving the title screen or the paused state, so a stale
// edge never fires a shot a frame late.

export const KEY_BINDINGS = {
  moveUp: ['KeyW', 'ArrowUp'],
  moveDown: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyE'],
  handbrake: ['Space'],
  pause: ['Escape', 'KeyP'],
  accept: ['KeyE', 'Enter'],
  weaponPistol: ['Digit1'],
  weaponSmg: ['Digit2'],
  weaponShotgun: ['Digit3'],
  weaponCycle: ['KeyQ'],
  radioCycle: ['KeyR'],
};

// Keys whose browser default (scrolling, page navigation) must be
// suppressed while the game has focus.
export const PREVENT_DEFAULT_CODES = [
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
];

// createInput(canvas) owns all raw input state for one game session.
// It attaches DOM listeners lazily (guarded: in Node, with no document,
// the object still works as a pure state bag that tests drive by calling
// press() / release() / setMouse() directly). Call attach() once the
// canvas exists; call detach() on teardown; call endFrame() at the end
// of every frame update.
export function createInput(canvas) {
  const down = new Set();
  const justPressed = new Set();
  const justReleased = new Set();

  const mouse = {
    x: 0,
    y: 0,
    down: false,
    justPressed: false,
    justReleased: false,
    // Last world-space aim point, filled in by aimAngle().
    worldX: 0,
    worldY: 0,
  };

  let attached = false;
  let canvasEl = canvas || null;
  let onKeyCallback = null;

  function isDown(code) {
    return down.has(code);
  }

  function isPressed(code) {
    return justPressed.has(code);
  }

  function isReleased(code) {
    return justReleased.has(code);
  }

  // Read-and-clear one edge flag: true only on the first frame that
  // asks for it, so a single key press can never double-fire.
  function consumePressed(code) {
    if (justPressed.has(code)) {
      justPressed.delete(code);
      return true;
    }
    return false;
  }

  function consumeReleased(code) {
    if (justReleased.has(code)) {
      justReleased.delete(code);
      return true;
    }
    return false;
  }

  function press(code) {
    if (!code) return;
    if (!down.has(code)) justPressed.add(code);
    down.add(code);
  }

  function release(code) {
    if (!code) return;
    down.delete(code);
    justReleased.add(code);
  }

  function clearAll() {
    down.clear();
    justPressed.clear();
    justReleased.clear();
    mouse.down = false;
    mouse.justPressed = false;
    mouse.justReleased = false;
  }

  // End of frame: drop every edge flag. Gameplay code reads edges
  // during the frame; nothing after this point may see them. Called by
  // the main loop after all updates, and on the title-screen and paused
  // early exits so a press made on a menu never leaks into gameplay.
  function endFrame() {
    justPressed.clear();
    justReleased.clear();
    mouse.justPressed = false;
    mouse.justReleased = false;
  }

  // Movement vector from WASD / arrows, normalised to length <= 1.
  // Returns { x, y } in world axes (y grows downward, like the canvas).
  function moveVector() {
    let x = 0;
    let y = 0;
    if (isDown('KeyA') || isDown('ArrowLeft')) x -= 1;
    if (isDown('KeyD') || isDown('ArrowRight')) x += 1;
    if (isDown('KeyW') || isDown('ArrowUp')) y -= 1;
    if (isDown('KeyS') || isDown('ArrowDown')) y += 1;
    if (x !== 0 && y !== 0) {
      const inv = 1 / Math.sqrt(2);
      x *= inv;
      y *= inv;
    }
    return { x, y };
  }

  function isSprinting() {
    return isDown('ShiftLeft') || isDown('ShiftRight');
  }

  function isHandbrake() {
    return isDown('Space');
  }

  // Driving input: forward / reverse throttle and steering, from the
  // same keys the on-foot movement uses. Up / W accelerates, Down / S
  // brakes and reverses, Left / Right steer.
  function driveVector() {
    let throttle = 0;
    let steer = 0;
    if (isDown('KeyW') || isDown('ArrowUp')) throttle += 1;
    if (isDown('KeyS') || isDown('ArrowDown')) throttle -= 1;
    if (isDown('KeyA') || isDown('ArrowLeft')) steer -= 1;
    if (isDown('KeyD') || isDown('ArrowRight')) steer += 1;
    return { throttle, steer, handbrake: isHandbrake() };
  }

  // Mouse position in canvas (screen) pixels, updated by the listener
  // and by setMouse() for scripted tests.
  function setMouse(x, y) {
    mouse.x = x;
    mouse.y = y;
  }

  function mouseDown() {
    mouse.down = true;
    mouse.justPressed = true;
  }

  function mouseUp() {
    mouse.down = false;
    mouse.justReleased = true;
  }

  // Aim angle from a world point toward the mouse. The camera maps
  // screen pixels to world coordinates; when no camera is given the
  // mouse position itself is treated as world coordinates (tests).
  function aimAngle(fromX, fromY, camera) {
    let wx = mouse.x;
    let wy = mouse.y;
    if (camera && typeof camera.screenToWorld === 'function') {
      const p = camera.screenToWorld(mouse.x, mouse.y);
      wx = p.x;
      wy = p.y;
    } else if (camera && typeof camera.x === 'number') {
      wx = mouse.x + camera.x;
      wy = mouse.y + camera.y;
    }
    mouse.worldX = wx;
    mouse.worldY = wy;
    return Math.atan2(wy - fromY, wx - fromX);
  }

  function mouseWorld(camera) {
    if (camera && typeof camera.screenToWorld === 'function') {
      return camera.screenToWorld(mouse.x, mouse.y);
    }
    if (camera && typeof camera.x === 'number') {
      return { x: mouse.x + camera.x, y: mouse.y + camera.y };
    }
    return { x: mouse.x, y: mouse.y };
  }

  // Any of the interact / accept keys pressed this frame.
  function interactPressed() {
    return isPressed('KeyE') || isPressed('Enter');
  }

  function pausePressed() {
    return isPressed('Escape') || isPressed('KeyP');
  }

  function onKeyDown(event) {
    const code = event && event.code;
    if (!code) return;
    if (PREVENT_DEFAULT_CODES.indexOf(code) >= 0 && event.preventDefault) {
      event.preventDefault();
    }
    press(code);
    if (typeof onKeyCallback === 'function') {
      try {
        onKeyCallback(code, event);
      } catch (e) {
        // A callback failure must never break raw input.
      }
    }
  }

  function onKeyUp(event) {
    const code = event && event.code;
    if (!code) return;
    release(code);
  }

  function onMouseMove(event) {
    if (!canvasEl || typeof canvasEl.getBoundingClientRect !== 'function') {
      mouse.x = (event && event.clientX) || 0;
      mouse.y = (event && event.clientY) || 0;
      return;
    }
    const rect = canvasEl.getBoundingClientRect();
    mouse.x = event.clientX - rect.left;
    mouse.y = event.clientY - rect.top;
  }

  function onMouseDown(event) {
    // Set the edge flag IMMEDIATELY, in the event handler — a click
    // that begins and ends inside one frame still registers a shot.
    mouseDown();
    if (event && event.preventDefault) event.preventDefault();
  }

  function onMouseUp() {
    mouseUp();
  }

  function onBlur() {
    // Losing focus releases every held key so Rook never keeps walking
    // (or driving) after the player alt-tabs away.
    clearAll();
  }

  function onContextMenu(event) {
    if (event && event.preventDefault) event.preventDefault();
  }

  function attach(targetCanvas) {
    if (attached) return true;
    if (targetCanvas) canvasEl = targetCanvas;
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return false;
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    if (canvasEl) {
      canvasEl.addEventListener('mousemove', onMouseMove);
      canvasEl.addEventListener('mousedown', onMouseDown);
      canvasEl.addEventListener('mouseup', onMouseUp);
      canvasEl.addEventListener('contextmenu', onContextMenu);
    }
    attached = true;
    return true;
  }

  function detach() {
    if (!attached) return;
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    }
    if (canvasEl) {
      canvasEl.removeEventListener('mousemove', onMouseMove);
      canvasEl.removeEventListener('mousedown', onMouseDown);
      canvasEl.removeEventListener('mouseup', onMouseUp);
      canvasEl.removeEventListener('contextmenu', onContextMenu);
    }
    attached = false;
  }

  // Optional single callback invoked for every keydown (used by the
  // main loop to route weapon / radio / garage keys without polling).
  function setKeyCallback(fn) {
    onKeyCallback = typeof fn === 'function' ? fn : null;
  }

  function snapshot() {
    return {
      keysDown: Array.from(down),
      pressed: Array.from(justPressed),
      mouse: { x: mouse.x, y: mouse.y, down: mouse.down },
      attached,
    };
  }

  return {
    down,
    justPressed,
    justReleased,
    mouse,
    isDown,
    isPressed,
    isReleased,
    consumePressed,
    consumeReleased,
    press,
    release,
    clearAll,
    endFrame,
    moveVector,
    driveVector,
    isSprinting,
    isHandbrake,
    setMouse,
    mouseDown,
    mouseUp,
    aimAngle,
    mouseWorld,
    interactPressed,
    pausePressed,
    attach,
    detach,
    setKeyCallback,
    snapshot,
  };
}

export default createInput;
