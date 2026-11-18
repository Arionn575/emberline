// Keyboard and mouse, and the pointer lock that turns the mouse into look.
// Plain browser APIs only: the game asks the canvas for pointer lock and
// reads movementX/Y while it holds it. Right mouse is the sniper scope.
export function makeControls(canvas, onLockChange) {
  const keys = new Set();
  const state = { keys, locked: false, firing: false, scoping: false, lookX: 0, lookY: 0, wheel: 0 };

  function setKey(event, down) {
    if (down) keys.add(event.code);
    else keys.delete(event.code);
    if (event.code === 'Space') event.preventDefault();
  }

  window.addEventListener('keydown', (event) => setKey(event, true));
  window.addEventListener('keyup', (event) => setKey(event, false));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('mousemove', (event) => {
    if (!state.locked) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  });
  window.addEventListener('mousedown', (event) => {
    if (!state.locked) return;
    if (event.button === 0) state.firing = true;
    if (event.button === 2) state.scoping = true;
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.firing = false;
    if (event.button === 2) state.scoping = false;
  });
  window.addEventListener('contextmenu', (event) => {
    if (state.locked) event.preventDefault();
  });
  window.addEventListener('wheel', (event) => {
    if (state.locked) state.wheel += event.deltaY > 0 ? 1 : -1;
  });
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      keys.clear();
      state.firing = false;
      state.scoping = false;
    }
    onLockChange(state.locked);
  });

  return {
    state,
    lock() {
      canvas.requestPointerLock();
    },
    drainLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    drainWheel() {
      const w = state.wheel;
      state.wheel = 0;
      return w;
    },
  };
}
