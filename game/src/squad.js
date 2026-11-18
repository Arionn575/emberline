// The squad: 5v5, the player plus four amber teammates against five blue
// defenders. Each bot is a box-built figure with a torso and a head hitbox.
// A bot walks a seeded waypoint chain along a lane, holds a position, and
// engages what it can see: a line-of-sight raycast, a reaction delay,
// burst fire with spread, reloads, and a retreat when hurt. Bot shots are
// real hitscan: a ray against the target's hitboxes, blocked by walls first.
// When the bomb is planted, the nearest defender runs to defuse it while a
// second defender covers the site — and a kneeling defuser is a hard target,
// so defuses sometimes succeed.
import * as THREE from 'three';
import { COLORS } from './colors.js';
import { PATHS, SPAWN_POINTS, BOMB_SITES } from './arena.js';

const BODY_R = 0.34;
const BODY_H = 1.72;
const EYE_H = 1.5;
const WALK_SPEED = 3.4;
const MAG_SIZE = 30;
const SHOT_GAP = 0.12;
const RELOAD_SECS = 1.9;
const BODY_DAMAGE = 20;
const HEAD_DAMAGE = 60;
const DEFUSE_SECS = 12;

const MATES = ['Ash', 'Cinder', 'Flint', 'Slate'];
const FOES = ['Rook', 'Hawk', 'Onyx', 'Blaze', 'Frost'];

// Slab-method ray vs axis-aligned box; returns the hit distance or Infinity.
function rayHitsBox(origin, dir, min, max) {
  let tmin = 0;
  let tmax = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-8) {
      if (o < min[axis] || o > max[axis]) return Infinity;
    } else {
      let t1 = (min[axis] - o) / d;
      let t2 = (max[axis] - o) / d;
      if (t1 > t2) {
        const t = t1;
        t1 = t2;
        t2 = t;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

export function makeSquad(scene, colliders, walls, rng, hooks) {
  const raycaster = new THREE.Raycaster();
  raycaster.far = 60;
  const eye = new THREE.Vector3();
  const chest = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const muzzle = new THREE.Vector3();
  const probe = new THREE.Box3();
  const scratch = new THREE.Vector3();
  const boxMin = new THREE.Vector3();
  const boxMax = new THREE.Vector3();

  const teamMat = {
    atk: new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.emberTeam), roughness: 0.6, metalness: 0.05 }),
    def: new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.vex), roughness: 0.6, metalness: 0.05 }),
  };
  const headMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.paper), roughness: 0.5, metalness: 0.05 });
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.timber), roughness: 0.85 });
  const torsoGeo = new THREE.BoxGeometry(0.52, 0.72, 0.3);
  const headGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
  const legGeo = new THREE.BoxGeometry(0.16, 0.5, 0.16);
  const gunGeo = new THREE.BoxGeometry(0.07, 0.09, 0.55);
  const flashGeo = new THREE.PlaneGeometry(0.34, 0.34);
  const flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ember), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });

  // Tracer pool: 16 preallocated streaks, reused, never allocated in play.
  const tracers = [];
  const tracerGeo = new THREE.BoxGeometry(0.03, 0.03, 1);
  for (let i = 0; i < 16; i += 1) {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ember), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(tracerGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    tracers.push({ mesh, life: 0 });
  }
  let tracerNext = 0;

  function drawTracer(from, to) {
    const tracer = tracers[tracerNext];
    tracerNext = (tracerNext + 1) % tracers.length;
    const length = from.distanceTo(to);
    if (length < 0.1) return;
    tracer.mesh.position.copy(from).add(to).multiplyScalar(0.5);
    tracer.mesh.lookAt(to);
    tracer.mesh.scale.set(1, 1, length);
    tracer.mesh.visible = true;
    tracer.life = 0.08;
  }

  const bots = [];
  const hitMeshes = [];

  function buildBot(team, name, spawn, index) {
    const group = new THREE.Group();
    const legL = new THREE.Mesh(legGeo, darkMat);
    legL.position.set(-0.11, 0.25, 0);
    const legR = new THREE.Mesh(legGeo, darkMat);
    legR.position.set(0.11, 0.25, 0);
    const torso = new THREE.Mesh(torsoGeo, teamMat[team]);
    torso.position.y = 0.86;
    torso.userData.part = 'torso';
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.44;
    head.userData.part = 'head';
    const gun = new THREE.Mesh(gunGeo, darkMat);
    gun.position.set(0.2, 1.15, -0.3);
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.set(0.2, 1.15, -0.62);
    flash.visible = false;
    group.add(legL, legR, torso, head, gun, flash);
    group.traverse((mesh) => {
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    group.position.set(spawn[0], 0, spawn[1]);
    scene.add(group);

    const bot = {
      team, name, group, torso, head, flash, index,
      pos: group.position,
      yaw: team === 'atk' ? 0 : Math.PI,
      vel: new THREE.Vector3(),
      health: 100, alive: true,
      mode: 'push', path: [], stepIndex: 0, holdSpot: null, holdYaw: 0,
      skill: 0.55 + rng() * 0.4,
      reaction: 0.35 + rng() * 0.3,
      contact: null, contactIsPlayer: false, lastSeen: -10, actAt: 0,
      burst: 0, burstRest: 0, cooldown: 0, mag: MAG_SIZE, reloading: 0,
      flashLeft: 0, fall: 0, phase: rng() * 6.28, heard: null, defuseT: 0,
      strafeDir: rng() > 0.5 ? 1 : -1, defuseSite: null, siteJob: null,
      stuckT: 0, lastWpDist: Infinity, sidestepLeft: 0, sidestepX: 0, sidestepZ: 0,
    };
    torso.userData.bot = bot;
    head.userData.bot = bot;
    hitMeshes.push(torso, head);
    bots.push(bot);
    return bot;
  }

  for (let i = 0; i < 4; i += 1) buildBot('atk', MATES[i], SPAWN_POINTS.atk[i + 1], i);
  for (let i = 0; i < 5; i += 1) buildBot('def', FOES[i], SPAWN_POINTS.def[i], i);

  // The probe is inset by a hair, so a bot sliding along a wall does not
  // wedge itself in the corner where its box merely touches the wall.
  function blockedAt(x, z) {
    probe.min.set(x - BODY_R + 0.02, 0.04, z - BODY_R + 0.02);
    probe.max.set(x + BODY_R - 0.02, 1.7, z + BODY_R - 0.02);
    for (const box of colliders) if (probe.intersectsBox(box)) return true;
    return false;
  }

  function walk(bot, dt) {
    const nextX = bot.pos.x + bot.vel.x * dt;
    if (!blockedAt(nextX, bot.pos.z)) bot.pos.x = nextX;
    else bot.vel.x = 0;
    const nextZ = bot.pos.z + bot.vel.z * dt;
    if (!blockedAt(bot.pos.x, nextZ)) bot.pos.z = nextZ;
    else bot.vel.z = 0;
  }

  // Line of sight from a bot's eye to a point: true when no wall is closer.
  function clearShot(from, to) {
    eye.copy(from);
    dir.copy(to).sub(from);
    const dist = dir.length();
    dir.normalize();
    raycaster.set(eye, dir);
    raycaster.far = dist;
    return raycaster.intersectObjects(walls, false).length === 0;
  }

  function chestOf(bot) {
    return chest.set(bot.pos.x, bot.pos.y + 1.1, bot.pos.z);
  }

  // Pick the nearest visible enemy: other-team bots, plus the player when
  // this bot is a defender. Returns {bot, isPlayer, point, dist}.
  function spotEnemies(bot, player, time) {
    let best = null;
    let bestDist = 42;
    const forward = scratch.set(-Math.sin(bot.yaw), 0, -Math.cos(bot.yaw));
    const consider = (point, dist, isPlayer, target) => {
      if (dist >= bestDist) return;
      dir.copy(point).sub(eye.set(bot.pos.x, bot.pos.y + EYE_H, bot.pos.z)).normalize();
      if (!bot.heard || time - bot.heard.t > 3) {
        if (dir.dot(forward) < 0.25) return;
      }
      if (!clearShot(eye, point)) return;
      bestDist = dist;
      best = { target, isPlayer, point: point.clone(), dist: bestDist };
    };
    for (const other of bots) {
      if (!other.alive || other.team === bot.team) continue;
      const point = chestOf(other);
      consider(point, eye.set(bot.pos.x, bot.pos.y + EYE_H, bot.pos.z).distanceTo(point), false, other);
    }
    if (bot.team === 'def' && player.alive) {
      const point = new THREE.Vector3(player.pos.x, player.pos.y + (player.crouching ? 0.8 : 1.2), player.pos.z);
      consider(point, eye.set(bot.pos.x, bot.pos.y + EYE_H, bot.pos.z).distanceTo(point), true, null);
    }
    return best;
  }

  function fireAt(bot, contact, time) {
    // Aim at the chest with an error that grows with distance, target
    // speed and the bot's (lack of) skill. A kneeling defuser is a small,
    // hard target, so shots at one spread wider.
    const aim = contact.isPlayer
      ? new THREE.Vector3(contact.point.x, contact.point.y, contact.point.z)
      : chestOf(contact.target);
    const dist = bot.pos.distanceTo(aim);
    const speed = contact.isPlayer ? contact.speed : Math.hypot(contact.target.vel.x, contact.target.vel.z);
    let error = (0.015 + dist * 0.0011 + speed * 0.006) * (1.5 - bot.skill);
    if (!contact.isPlayer && contact.target.mode === 'defuse') error *= 1.3;
    muzzle.set(bot.pos.x - Math.sin(bot.yaw) * 0.5, bot.pos.y + 1.35, bot.pos.z - Math.cos(bot.yaw) * 0.5);
    dir.copy(aim).sub(muzzle).normalize();
    dir.x += (rng() * 2 - 1) * error;
    dir.y += (rng() * 2 - 1) * error;
    dir.z += (rng() * 2 - 1) * error;
    dir.normalize();

    // Walls first: the shot stops at the nearest wall.
    raycaster.set(muzzle, dir);
    raycaster.far = 60;
    const wallHits = raycaster.intersectObjects(walls, false);
    const wallDist = wallHits.length ? wallHits[0].distance : Infinity;
    let end = scratch.copy(muzzle).addScaledVector(dir, Math.min(wallDist, 60));

    if (contact.isPlayer) {
      const p = contact.point;
      const crouch = contact.crouching;
      const bodyTop = crouch ? 1.12 : 1.45;
      const headTop = crouch ? 1.12 : BODY_H;
      boxMin.set(p.x - BODY_R, p.y, p.z - BODY_R);
      boxMax.set(p.x + BODY_R, p.y + bodyTop, p.z + BODY_R);
      const bodyT = rayHitsBox(muzzle, dir, boxMin, boxMax);
      boxMin.set(p.x - 0.2, p.y + bodyTop, p.z - 0.2);
      boxMax.set(p.x + 0.2, p.y + headTop, p.z + 0.2);
      const headT = rayHitsBox(muzzle, dir, boxMin, boxMax);
      const hitT = Math.min(bodyT, headT);
      if (hitT < wallDist && hitT < Infinity) {
        end = scratch.copy(muzzle).addScaledVector(dir, hitT);
        hooks.onDamagePlayer(headT < bodyT ? HEAD_DAMAGE : BODY_DAMAGE, headT < bodyT, bot);
      }
    } else {
      raycaster.set(muzzle, dir);
      const hits = raycaster.intersectObjects([contact.target.torso, contact.target.head], false);
      if (hits.length && hits[0].distance < wallDist) {
        end = scratch.copy(muzzle).addScaledVector(dir, hits[0].distance);
        const head = hits[0].object.userData.part === 'head';
        hurt(contact.target, head ? HEAD_DAMAGE : BODY_DAMAGE, bot, head);
      }
    }
    drawTracer(muzzle, end);
    bot.flash.visible = true;
    bot.flashLeft = 0.06;
  }

  function hurt(bot, amount, attacker, head) {
    if (!bot.alive) return false;
    bot.health -= amount;
    if (bot.mode === 'defuse') {
      // Being shot breaks the defuse off and the progress is lost: a
      // defuser needs a clear window to finish, so a guarded bomb is a
      // real fight and a lone defuser usually fails.
      bot.defuseT = 0;
      bot.mode = 'fight';
    }
    if (bot.health > 0) return false;
    bot.alive = false;
    bot.mode = 'dead';
    bot.fall = 0;
    bot.vel.set(0, 0, 0);
    hooks.onKill(attacker ? attacker.name : 'you', bot.name, !!head);
    return true;
  }

  // A straight line to a bomb site can cross a lane wall, and bots have no
  // pathfinding, so a bot sent to a site goes by the top connector at
  // z=-5 (the gap in both lane dividers, z in [-6, -2]). The first leg is
  // deliberately diagonal and clears the walls a head-on walk would hit:
  // the mid wall at z=-7 (x -4..4) and the mid door at z=0 (x -7..2). A bot
  // north of the yard goes west around the mid wall first, then east or
  // west along the connector; a bot south of it goes around the mid door.
  // The connector legs run at z=-5, which also clears the lane crates at
  // z=-4. Every leg is diagonal, so a bot that does meet a wall slides
  // along it instead of pushing head-on.
  function routeToSite(bot, site) {
    const laneX = site.id === 'A' ? -14 : 14;
    if (bot.pos.z > 0) {
      // A bot south of the yard is an attacker rotating back to guard the
      // bomb: it takes its own team's lane route, which is laid out to
      // clear every wall, instead of the connector.
      return (site.id === 'A' ? PATHS.pushA : PATHS.pushB).slice();
    }
    if (site.id === 'A') return [[-8, -5], [laneX, -5], [site.x, site.z]];
    return [[-8, -5], [8, -5], [laneX, -5], [site.x, site.z]];
  }

  function assignPath(bot, siteId) {
    if (bot.team === 'def') {
      // Defenders split: two hold A, two hold B, one watches mid.
      const site = bot.index < 2 ? 'A' : bot.index < 4 ? 'B' : 'mid';
      const spots = site === 'A' ? PATHS.watchA : site === 'B' ? PATHS.watchB : PATHS.watchMid;
      bot.holdSpot = spots[bot.index % spots.length];
      bot.path = [[bot.holdSpot[0], bot.holdSpot[1]]];
      bot.stepIndex = 0;
      bot.mode = 'push';
      return;
    }
    if (siteId === 'A') bot.path = PATHS.pushA;
    else if (siteId === 'B') bot.path = PATHS.pushB;
    else bot.path = PATHS.pushMid.concat(rng() > 0.5 ? PATHS.midToA : PATHS.midToB);
    bot.stepIndex = 0;
    bot.mode = 'push';
  }

  function reset(roundSite) {
    for (const bot of bots) {
      const spawn = bot.team === 'atk' ? SPAWN_POINTS.atk[bot.index + 1] : SPAWN_POINTS.def[bot.index];
      bot.pos.set(spawn[0], 0, spawn[1]);
      bot.yaw = bot.team === 'atk' ? 0 : Math.PI;
      bot.vel.set(0, 0, 0);
      bot.health = 100;
      bot.alive = true;
      bot.group.rotation.set(0, bot.yaw, 0);
      bot.group.position.copy(bot.pos);
      bot.contact = null;
      bot.mag = MAG_SIZE;
      bot.reloading = 0;
      bot.cooldown = 0;
      bot.burst = 0;
      bot.burstRest = 0;
      bot.fall = 0;
      bot.defuseT = 0;
      bot.heard = null;
      bot.defuseSite = null;
      bot.siteJob = null;
      bot.stuckT = 0;
      bot.lastWpDist = Infinity;
      bot.sidestepLeft = 0;
      assignPath(bot, roundSite);
    }
    for (const tracer of tracers) {
      tracer.mesh.visible = false;
      tracer.life = 0;
    }
  }

  function update(dt, time, player) {
    for (const tracer of tracers) {
      if (tracer.life > 0) {
        tracer.life -= dt;
        tracer.mesh.material.opacity = Math.max(0, tracer.life / 0.08) * 0.85;
        if (tracer.life <= 0) tracer.mesh.visible = false;
      }
    }
    for (const bot of bots) {
      if (bot.flashLeft > 0) {
        bot.flashLeft -= dt;
        if (bot.flashLeft <= 0) bot.flash.visible = false;
      }
      if (!bot.alive) {
        bot.fall = Math.min(1, bot.fall + dt / 0.4);
        bot.group.rotation.x = -bot.fall * 1.45;
        continue;
      }
      bot.group.rotation.y = bot.yaw;

      // A bot with a job at the bomb site — the defuser, its cover, or an
      // attacker rotating back to guard it — ignores distant contacts and
      // keeps moving; it only stops to fight what is close enough to
      // kill it. Otherwise every bot gets bogged down in a lane fight
      // and the bomb is never contested.
      if (time - bot.lastSeen > 0.12 + bot.index * 0.02 || bot.contact) {
        const found = spotEnemies(bot, player, time);
        const ignore = found && bot.siteJob && found.dist > 8;
        if (found && !ignore) {
          if (!bot.contact) bot.actAt = time + bot.reaction;
          bot.contact = found;
          bot.lastSeen = time;
          if (bot.mode !== 'defuse') bot.mode = 'fight';
        } else if (bot.contact && time - bot.lastSeen > 1.5) {
          bot.contact = null;
          if (bot.defuseSite) {
            // A defuser who lost its target goes back to the bomb: near
            // enough to kneel and resume, else walk back to the site.
            const d = Math.hypot(bot.pos.x - bot.defuseSite.x, bot.pos.z - bot.defuseSite.z);
            bot.path = routeToSite(bot, bot.defuseSite);
            bot.stepIndex = 0;
            bot.mode = d < 1.6 ? 'defuse' : 'push';
          } else if (bot.siteJob) {
            // A site guard who lost its target goes back to the site.
            bot.path = routeToSite(bot, bot.siteJob);
            bot.stepIndex = 0;
            bot.mode = 'push';
          } else {
            bot.mode = bot.path && bot.stepIndex < bot.path.length ? 'push' : 'guard';
          }
        }
      }

      if (bot.mode === 'fight' && bot.contact) {
        const targetPos = bot.contact.isPlayer
          ? new THREE.Vector3(bot.contact.point.x, bot.pos.y, bot.contact.point.z)
          : bot.contact.target.pos;
        const dx = targetPos.x - bot.pos.x;
        const dz = targetPos.z - bot.pos.z;
        bot.yaw = Math.atan2(-dx, -dz);
        // Strafe slowly while firing so a bot is not a static target.
        const strafe = Math.sin(time * 1.3 + bot.phase) * bot.strafeDir * 1.1;
        bot.vel.set(-Math.cos(bot.yaw) * strafe, 0, Math.sin(bot.yaw) * strafe);
        walk(bot, dt);
        if (time >= bot.actAt) {
          bot.cooldown -= dt;
          if (bot.reloading > 0) {
            bot.reloading -= dt;
            if (bot.reloading <= 0) bot.mag = MAG_SIZE;
          } else if (bot.burstRest > 0) {
            bot.burstRest -= dt;
          } else if (bot.cooldown <= 0 && bot.mag > 0) {
            bot.cooldown = SHOT_GAP;
            bot.mag -= 1;
            bot.burst += 1;
            fireAt(bot, bot.contact, time);
            if (bot.burst >= 3 + Math.floor(rng() * 3)) {
              bot.burst = 0;
              bot.burstRest = 0.6 + rng() * 0.5;
            }
            if (bot.mag === 0) bot.reloading = RELOAD_SECS;
          }
        }
      } else if (bot.mode === 'push' && bot.path) {
        const wp = bot.path[bot.stepIndex];
        if (!wp) {
          bot.mode = 'guard';
          bot.holdYaw = bot.yaw;
        } else if (bot.sidestepLeft > 0) {
          // Sidestepping around an obstacle that wedged the bot: walk
          // sideways for a short burst, then re-aim at the waypoint.
          bot.sidestepLeft -= dt;
          bot.vel.set(bot.sidestepX * WALK_SPEED, 0, bot.sidestepZ * WALK_SPEED);
          bot.yaw = Math.atan2(-bot.vel.x, -bot.vel.z);
          walk(bot, dt);
          bot.lastWpDist = Infinity;
        } else {
          const dx = wp[0] - bot.pos.x;
          const dz = wp[1] - bot.pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 0.6) {
            bot.stepIndex += 1;
            bot.stuckT = 0;
            bot.lastWpDist = Infinity;
          } else {
            // A waypoint straight behind an obstacle leaves the bot with
            // no sideways velocity to slide around it, so it wedges: if
            // it makes no progress for a while, sidestep perpendicular
            // to the waypoint direction until it clears the obstacle.
            if (dist < bot.lastWpDist - 0.01) {
              bot.stuckT = 0;
              bot.lastWpDist = dist;
            } else {
              bot.stuckT += dt;
            }
            if (bot.stuckT > 1.2) {
              const side = rng() > 0.5 ? 1 : -1;
              bot.sidestepX = (-dz / dist) * side;
              bot.sidestepZ = (dx / dist) * side;
              bot.sidestepLeft = 0.9;
              bot.stuckT = 0;
            }
            bot.yaw = Math.atan2(-dx, -dz);
            bot.vel.set((dx / dist) * WALK_SPEED, 0, (dz / dist) * WALK_SPEED);
            walk(bot, dt);
          }
        }
      } else if (bot.mode === 'guard') {
        bot.vel.set(0, 0, 0);
        bot.yaw = bot.holdYaw + Math.sin(time * 0.5 + bot.phase) * 0.9;
      } else if (bot.mode === 'defuse') {
        bot.vel.set(0, 0, 0);
        bot.defuseT += dt;
        if (bot.defuseT >= DEFUSE_SECS) hooks.onDefused();
      }

      // Low health: fall back toward the team's spawn for a few seconds.
      if (bot.alive && bot.health < 35 && bot.mode !== 'defuse' && bot.mode !== 'fight') {
        const back = bot.team === 'atk' ? 1 : -1;
        bot.vel.set(0, 0, back * WALK_SPEED * 0.6);
        walk(bot, dt);
      }
    }
  }

  return {
    bots,
    hitMeshes,
    hurt,
    reset,
    update,
    drawTracer,
    aliveCount(team) {
      return bots.filter((bot) => bot.team === team && bot.alive).length;
    },
    nearestDefender(site) {
      let best = null;
      let bestDist = Infinity;
      for (const bot of bots) {
        if (bot.team !== 'def' || !bot.alive) continue;
        const d = Math.hypot(bot.pos.x - site.x, bot.pos.z - site.z);
        if (d < bestDist) {
          bestDist = d;
          best = bot;
        }
      }
      return best;
    },
    dispatchDefuser(bot, site) {
      bot.contact = null;
      bot.defuseT = 0;
      bot.defuseSite = site;
      bot.siteJob = site;
      bot.path = routeToSite(bot, site);
      bot.stepIndex = 0;
      bot.mode = 'push';
    },
    dispatchCover(bot, site) {
      bot.contact = null;
      bot.siteJob = site;
      bot.path = routeToSite(bot, site);
      bot.stepIndex = 0;
      bot.mode = 'push';
    },
    tickDefuse(dt) {
      for (const bot of bots) {
        if (!bot.alive || bot.team !== 'def' || !bot.defuseSite) continue;
        const site = bot.defuseSite;
        const d = Math.hypot(bot.pos.x - site.x, bot.pos.z - site.z);
        if (d < 1.6 && (bot.mode === 'push' || bot.mode === 'guard')) {
          bot.mode = 'defuse';
          bot.vel.set(0, 0, 0);
        }
      }
    },
    hearShot(pos, team, time) {
      for (const bot of bots) {
        if (bot.team === team || !bot.alive) continue;
        if (bot.pos.distanceTo(pos) < 18) bot.heard = { pos: pos.clone(), t: time };
      }
    },
  };
}
