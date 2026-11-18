// The player's body: walk, crouch, jump and gravity, resolved as a box
// against the arena's colliders one axis at a time, so a wall never
// swallows the player and the floor never reads as a wall.
import * as THREE from 'three';

const BODY_RADIUS = 0.34;
const TALL = 1.72;
const LOW = 1.12;
const EYE_TALL = 1.6;
const EYE_LOW = 1.02;
const WALK = 5.2;
const CROUCH_WALK = 2.4;
const GROUND_PULL = 42;
const AIR_PULL = 9;
const DRAG = 9;
const GRAVITY = 20;
const JUMP = 6.2;

export function makeRunner(colliders) {
  const runner = {
    position: new THREE.Vector3(0, 0, 9.5),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    eyeHeight: EYE_TALL,
    grounded: true,
    crouched: false,
    height: TALL,
  };
  const probe = new THREE.Box3();
  const wish = new THREE.Vector3();

  // lift keeps the feet and the crown out of the horizontal tests, so
  // standing on the floor is not read as walking into a wall. The probe is
  // inset by a hair, so the player does not wedge into a corner where the
  // box merely touches a wall.
  function blocked(x, y, z, height, lift) {
    probe.min.set(x - BODY_RADIUS + 0.02, y + lift, z - BODY_RADIUS + 0.02);
    probe.max.set(x + BODY_RADIUS - 0.02, y + height - lift, z + BODY_RADIUS - 0.02);
    for (const box of colliders) {
      if (probe.intersectsBox(box)) return box;
    }
    return null;
  }

  function look(dx, dy, sensitivity = 0.0022) {
    runner.yaw -= dx * sensitivity;
    runner.pitch = Math.max(-1.45, Math.min(1.45, runner.pitch - dy * sensitivity));
  }

  function kick(pitchUp, yawSide) {
    runner.pitch = Math.min(1.45, runner.pitch + pitchUp);
    runner.yaw += yawSide;
  }

  function update(dt, keys) {
    const wantCrouch = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    if (wantCrouch && !runner.crouched) {
      runner.crouched = true;
      runner.height = LOW;
    } else if (!wantCrouch && runner.crouched && !blocked(runner.position.x, runner.position.y, runner.position.z, TALL, 0.02)) {
      runner.crouched = false;
      runner.height = TALL;
    }
    const eyeTarget = runner.crouched ? EYE_LOW : EYE_TALL;
    runner.eyeHeight += (eyeTarget - runner.eyeHeight) * Math.min(1, dt * 12);

    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    wish.set(0, 0, 0);
    if (forward || strafe) {
      const sin = Math.sin(runner.yaw);
      const cos = Math.cos(runner.yaw);
      wish.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe).normalize();
    }

    const topSpeed = runner.crouched ? CROUCH_WALK : WALK;
    const pull = Math.min(1, (runner.grounded ? GROUND_PULL : AIR_PULL) * dt / topSpeed);
    runner.velocity.x += (wish.x * topSpeed - runner.velocity.x) * pull;
    runner.velocity.z += (wish.z * topSpeed - runner.velocity.z) * pull;
    if (runner.grounded && !wish.lengthSq()) {
      const damp = Math.max(0, 1 - DRAG * dt);
      runner.velocity.x *= damp;
      runner.velocity.z *= damp;
    }

    if (keys.has('Space') && runner.grounded) {
      runner.velocity.y = JUMP;
      runner.grounded = false;
    }
    runner.velocity.y -= GRAVITY * dt;

    const nextX = runner.position.x + runner.velocity.x * dt;
    if (!blocked(nextX, runner.position.y, runner.position.z, runner.height, 0.04)) runner.position.x = nextX;
    else runner.velocity.x = 0;
    const nextZ = runner.position.z + runner.velocity.z * dt;
    if (!blocked(runner.position.x, runner.position.y, nextZ, runner.height, 0.04)) runner.position.z = nextZ;
    else runner.velocity.z = 0;

    runner.position.y += runner.velocity.y * dt;
    runner.grounded = false;
    const hit = blocked(runner.position.x, runner.position.y, runner.position.z, runner.height, 0);
    if (hit && runner.velocity.y <= 0) {
      runner.position.y = hit.max.y;
      runner.velocity.y = 0;
      runner.grounded = true;
    } else if (hit) {
      runner.position.y = hit.min.y - runner.height;
      runner.velocity.y = 0;
    }
    if (runner.position.y < 0) {
      runner.position.y = 0;
      runner.velocity.y = 0;
      runner.grounded = true;
    }
    runner.velocity.y = Math.max(-30, runner.velocity.y);
  }

  return {
    body: runner,
    update,
    look,
    kick,
    speed() {
      return Math.hypot(runner.velocity.x, runner.velocity.z);
    },
  };
}
