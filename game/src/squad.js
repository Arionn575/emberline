// squad.js — the two five-bot squads, written fresh for Emberline.
// This module owns what the bots do: walking their routes, shooting,
// planting the bomb, guarding it, and trying to defuse it. Boot owns
// the match clock and the player; bots report through an event queue
// that boot drains once a frame. Bot fields promised by the debug
// handle stay stable: name, team, alive, health, mode, pos, vel,
// defuseSite, defuseT, stepIndex, path.
import * as THREE from 'three';
import { BOMB_SITES, PATHS, SPAWN_POINTS } from './arena.js';
import { COLORS } from './colors.js';
import { pick } from './rng.js';

const BOT_HEALTH = 100;
const WALK_SPEED = 3.1;
const SPEED_SPREAD = 0.45;
const THINK_EVERY = 0.14;

const ATK_NAMES = ['Ash', 'Blaze', 'Cinder', 'Flint', 'Slate'];
const DEF_NAMES = ['Rook', 'Heron', 'Onyx', 'Wren', 'Kite'];

export function makeSquad(scene, colliders, walls, rng) {
  const bots = [];
  const queue = [];
  const eye = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const sight = new THREE.Raycaster();

  function makeBot(name, team, index) {
    return {
      name, team, alive: true, health: BOT_HEALTH,
      mode: 'hold', job: 'hold',
      pos: new THREE.Vector3(0, 0, 0),
      vel: new THREE.Vector3(),
      path: [], stepIndex: 0,
      defuseSite: null, defuseT: 0, plantT: 0,
      skill: 0.55 + rng() * 0.3,
      speed: WALK_SPEED + (rng() - 0.5) * 2 * SPEED_SPREAD,
      fireTimer: 0, thinkTimer: rng() * THINK_EVERY,
      loseTimer: 0, stuckTimer: 0,
      target: null, targetDist: Infinity, targetSite: null,
      guardSpot: null, mesh: null, yaw: 0,
      prevX: 0, prevZ: 0, index,
    };
  }

  for (let i = 0; i < 5; i += 1) bots.push(makeBot(ATK_NAMES[i], 'atk', i));
  for (let i = 0; i < 5; i += 1) bots.push(makeBot(DEF_NAMES[i], 'def', i));

  let attackSite = 'A';
  let plantedSite = null;
  // A bot's figure is a few boxes: team-coloured torso, dark limbs, a
  // pale visor slit, and a gun held forward. The group faces +z, so
  // its yaw is atan2(dx, dz) of the way it walks or aims.
  function buildFigure(team) {
    const group = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({
      color: new THREE.Color(team === 'atk' ? COLORS.emberTeam : COLORS.vex),
      roughness: 0.85,
    });
    const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.dusk), roughness: 0.9 });
    const pale = new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.paper) });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.72, 0.34), cloth);
    torso.position.y = 1.08;
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.3), dark);
    hips.position.y = 0.42;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), dark);
    head.position.y = 1.66;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 0.05), pale);
    visor.position.set(0, 1.68, 0.17);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.62), dark);
    gun.position.set(0.2, 1.18, 0.3);
    group.add(torso, hips, head, visor, gun);
    group.traverse((mesh) => { if (mesh.isMesh) mesh.castShadow = true; });
    return group;
  }

  for (const bot of bots) {
    bot.mesh = buildFigure(bot.team);
    bot.mesh.userData.bot = bot;
    scene.add(bot.mesh);
  }

  // Routes are picked from the arena's waypoint chains. Attackers push a
  // lane toward the round's site; most take the direct lane, some swing
  // through the middle and cut across. Defenders walk to a hold point
  // and watch a lane.
  function laneTo(site) {
    if (site === 'A') return rng() < 0.6 ? PATHS.pushA : PATHS.pushMid.concat(PATHS.midToA);
    return rng() < 0.6 ? PATHS.pushB : PATHS.pushMid.concat(PATHS.midToB);
  }

  function routeToSite(from, site) {
    const target = BOMB_SITES[site];
    const near = Math.hypot(from.x - target.x, from.z - target.z) < 9;
    if (near) return [[target.x, target.z]];
    return site === 'A' ? PATHS.midToA.slice() : PATHS.midToB.slice();
  }

  // The push lane from the waypoint nearest the bot, so a rotating
  // attacker rejoins its lane instead of cutting across the walls.
  function laneFrom(bot, site) {
    const lane = site === 'A' ? PATHS.pushA : PATHS.pushB;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < lane.length; i += 1) {
      const d = Math.hypot(lane[i][0] - bot.pos.x, lane[i][1] - bot.pos.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    return lane.slice(best);
  }

  function resetBot(bot, spawn) {
    bot.pos.set(spawn[0], 0, spawn[1]);
    bot.prevX = spawn[0];
    bot.prevZ = spawn[1];
    bot.vel.set(0, 0, 0);
    bot.alive = true;
    bot.health = BOT_HEALTH;
    bot.target = null;
    bot.targetDist = Infinity;
    bot.defuseSite = null;
    bot.defuseT = 0;
    bot.plantT = 0;
    bot.fireTimer = 0;
    bot.loseTimer = 0;
    bot.stuckTimer = 0;
    bot.guardSpot = null;
    bot.mesh.visible = true;
    bot.mesh.rotation.set(0, 0, 0);
    bot.mesh.position.set(spawn[0], 0, spawn[1]);
  }

  // A fresh round: everyone back at their spawn, healthy, with a new
  // job. The attacking squad picks one site for the round and pushes
  // it; defenders spread across the three watch routes.
  function resetRound(site) {
    attackSite = site;
    plantedSite = null;
    const watchRoutes = [PATHS.watchA, PATHS.watchB, PATHS.watchMid, PATHS.watchA, PATHS.watchB];
    // Shuffle the watch routes so the same defender does not always
    // take the same lane.
    for (let i = watchRoutes.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const swap = watchRoutes[i];
      watchRoutes[i] = watchRoutes[j];
      watchRoutes[j] = swap;
    }
    let atk = 0;
    let def = 0;
    for (const bot of bots) {
      if (bot.team === 'atk') {
        resetBot(bot, SPAWN_POINTS.atk[atk]);
        bot.targetSite = site;
        bot.path = laneTo(site).slice();
        bot.stepIndex = 0;
        bot.job = 'push';
        bot.mode = 'push';
        atk += 1;
      } else {
        resetBot(bot, SPAWN_POINTS.def[def]);
        bot.targetSite = null;
        bot.path = watchRoutes[def].slice();
        bot.stepIndex = 0;
        bot.job = 'hold';
        bot.mode = 'rotate';
        def += 1;
      }
    }
  }

  // Movement: a bot is a circle of BODY_RADIUS at ground level. A box
  // blocks the bot when it overlaps the bot's height band, so the floor
  // never counts as a wall. Each axis is tested on its own, so a bot
  // slides along a wall instead of stopping dead on it.
  const ARENA_X = 23.4;
  const ARENA_Z = 17.4;
  const ARRIVE_DIST = 0.4;
  const BODY_RADIUS = 0.36;

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function hitsWall(x, z) {
    for (const box of colliders) {
      if (box.min.y >= 1.7 || box.max.y <= 0.05) continue;
      if (x > box.min.x - BODY_RADIUS && x < box.max.x + BODY_RADIUS
        && z > box.min.z - BODY_RADIUS && z < box.max.z + BODY_RADIUS) return true;
    }
    return false;
  }

  function moveBot(bot, mx, mz, dt) {
    const nx = bot.pos.x + mx;
    if (!hitsWall(nx, bot.pos.z)) bot.pos.x = nx;
    const nz = bot.pos.z + mz;
    if (!hitsWall(bot.pos.x, nz)) bot.pos.z = nz;
    bot.pos.x = clamp(bot.pos.x, -ARENA_X, ARENA_X);
    bot.pos.z = clamp(bot.pos.z, -ARENA_Z, ARENA_Z);
    bot.vel.set((bot.pos.x - bot.prevX) / dt, 0, (bot.pos.z - bot.prevZ) / dt);
    bot.prevX = bot.pos.x;
    bot.prevZ = bot.pos.z;
  }

  // Walk the next waypoint. Returns true when the chain is finished.
  function stepToward(bot, dt) {
    const wp = bot.path[bot.stepIndex];
    if (!wp) return true;
    const dx = wp[0] - bot.pos.x;
    const dz = wp[1] - bot.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < ARRIVE_DIST) {
      bot.stepIndex += 1;
      return bot.stepIndex >= bot.path.length;
    }
    const stride = bot.speed * dt;
    moveBot(bot, (dx / dist) * stride, (dz / dist) * stride, dt);
    bot.yaw = Math.atan2(dx, dz);
    return false;
  }

  const SHOT_RANGE = 30;

  // Sight: a ray from the bot's eyes to the target's chest. Walls stop
  // it; anything else does not. Only the arena walls are tested, so a
  // bot never hides behind another bot.
  function sees(from, targetPos, chestY) {
    eye.set(from.x, 1.5, from.z);
    aim.set(targetPos.x - from.x, chestY - 1.5, targetPos.z - from.z);
    const dist = aim.length();
    if (dist > SHOT_RANGE) return false;
    sight.set(eye, aim.normalize());
    sight.far = dist;
    return sight.intersectObjects(walls, false).length === 0;
  }

  // Pick the nearest visible enemy. The player counts as an enemy for
  // the defenders and as a friend for the attackers.
  function scan(bot, ctx) {
    let best = null;
    let bestDist = Infinity;
    let bestEff = Infinity;
    if (ctx.playerAlive && bot.team === 'def') {
      const d = Math.hypot(ctx.playerPos.x - bot.pos.x, ctx.playerPos.z - bot.pos.z);
      if (d < SHOT_RANGE && sees(bot.pos, ctx.playerPos, 1.1)) {
        best = { kind: 'player' };
        bestDist = d;
        bestEff = d;
      }
    }
    for (const other of bots) {
      if (!other.alive || other.team === bot.team) continue;
      const d = Math.hypot(other.pos.x - bot.pos.x, other.pos.z - bot.pos.z);
      // Attackers would rather stop the defuse than win a duel: a bot
      // mid-defuse counts as much closer than it really is.
      const eff = (bot.team === 'atk' && other.mode === 'defuse') ? d * 0.45 : d;
      if (eff >= bestEff || d >= SHOT_RANGE) continue;
      if (!sees(bot.pos, other.pos, 1.1)) continue;
      best = { kind: 'bot', bot: other };
      bestDist = d;
      bestEff = eff;
    }
    bot.target = best;
    bot.targetDist = bestDist;
  }

  const SHOT_GAP = 0.62;
  const HIT_BASE = 0.5;
  const DAMAGE_BASE = 17;
  const DAMAGE_SKILL = 10;
  // Defenders hold their ground: a steadier aim and heavier rounds for
  // the squad defending the yard.
  const DEF_AIM_EDGE = 0.1;
  const DEF_HIT_EDGE = 5;

  // Hurt a bot. A hit while planting or defusing wipes that progress.
  // Death tips the figure over and reports the kill to boot.
  function hurtBot(bot, amount, killer) {
    if (!bot.alive) return false;
    bot.health -= amount;
    if (bot.mode === 'defuse') bot.defuseT = 0;
    if (bot.mode === 'plant') bot.plantT = 0;
    if (bot.health <= 0) {
      bot.health = 0;
      bot.alive = false;
      bot.mode = 'dead';
      bot.target = null;
      bot.mesh.rotation.z = Math.PI / 2;
      bot.mesh.position.y = 0.35;
      queue.push({ kind: 'botDown', bot, killer });
      return true;
    }
    return false;
  }

  // One shot at the bot's current target. Hit chance falls with range
  // and when the target is moving; damage grows a little with skill.
  function shootAt(bot, dt, ctx) {
    bot.fireTimer -= dt;
    if (!bot.target || bot.fireTimer > 0) return;
    bot.fireTimer = SHOT_GAP + rng() * 0.35 - bot.skill * 0.15;
    const playerSpeed = ctx.playerVel ? Math.hypot(ctx.playerVel.x, ctx.playerVel.z) : 0;
    const moving = bot.target.kind === 'player'
      ? playerSpeed > 2
      : Math.hypot(bot.target.bot.vel.x, bot.target.bot.vel.z) > 1;
    let chance = HIT_BASE + bot.skill * 0.15 - bot.targetDist * 0.008 - (moving ? 0.12 : 0);
    if (bot.team === 'def') chance += DEF_AIM_EDGE;
    chance = clamp(chance, 0.12, 0.78);
    let damage = Math.round(DAMAGE_BASE + bot.skill * DAMAGE_SKILL + rng() * 6);
    if (bot.team === 'def') damage += DEF_HIT_EDGE;
    if (rng() < chance) {
      if (bot.target.kind === 'player') {
        queue.push({ kind: 'playerHit', amount: damage, by: bot });
      } else {
        hurtBot(bot.target.bot, damage, bot);
      }
    }
    queue.push({ kind: 'shotFired', bot });
  }

  const PLANT_SECONDS = 3;
  const DEFUSE_SECONDS = 12;
  const GUARD_OFFSETS = [[5, 2], [-5, 2], [2, 6], [-2, -6], [5, -3], [-5, -3]];

  // The bomb is planted. Defenders rotate to the site; one of them is
  // picked to defuse while the rest cover. The two nearest attackers
  // fall back to guard spots; the rest hold where they are.
  function onPlanted(site) {
    plantedSite = site;
    const target = BOMB_SITES[site];
    let defuser = null;
    let defuserDist = Infinity;
    for (const bot of bots) {
      if (!bot.alive) continue;
      if (bot.team === 'def') {
        const d = Math.hypot(bot.pos.x - target.x, bot.pos.z - target.z);
        if (d < defuserDist) { defuserDist = d; defuser = bot; }
      }
    }
    const guards = [];
    for (const bot of bots) {
      if (!bot.alive || bot.team !== 'atk') continue;
      guards.push(bot);
    }
    guards.sort((a, b) => {
      const da = Math.hypot(a.pos.x - target.x, a.pos.z - target.z);
      const db = Math.hypot(b.pos.x - target.x, b.pos.z - target.z);
      return da - db;
    });
    for (const bot of bots) {
      if (!bot.alive) continue;
      if (bot.team === 'def') {
        bot.defuseSite = bot === defuser ? site : null;
        bot.defuseT = 0;
        bot.job = bot === defuser ? 'defuse' : 'cover';
        bot.mode = 'rotate';
        bot.path = routeToSite(bot.pos, site);
        bot.stepIndex = 0;
      } else {
        // Every attacker rotates to the site along a real route (never
        // a straight line across the walls); the two nearest guard it,
        // the rest hold just off it and shoot.
        const gi = guards.indexOf(bot);
        const spot = GUARD_OFFSETS[gi % GUARD_OFFSETS.length];
        bot.guardSpot = [target.x + spot[0], target.z + spot[1]];
        bot.job = gi < 2 ? 'guard' : 'hold';
        bot.mode = 'rotate';
        bot.path = laneFrom(bot, site).concat([bot.guardSpot]);
        bot.stepIndex = 0;
      }
    }
  }

  // One bot, one frame. Think on a staggered tick, fight when a target
  // is visible, otherwise walk the job's route. Planting and defusing
  // are channels: stand still, count up, and a hit wipes the count.
  function updateBot(bot, dt, ctx) {
    if (!bot.alive) return;
    bot.thinkTimer -= dt;
    if (bot.thinkTimer <= 0) {
      bot.thinkTimer = THINK_EVERY + rng() * 0.06;
      scan(bot, ctx);
    }
    const hasTarget = !!bot.target;
    if (hasTarget) {
      bot.loseTimer = 0;
      const aimAt = bot.target.kind === 'player' ? ctx.playerPos : bot.target.bot.pos;
      bot.yaw = Math.atan2(aimAt.x - bot.pos.x, aimAt.z - bot.pos.z);
      if (bot.mode !== 'plant' && bot.mode !== 'defuse') {
        // A bot on defuse duty walks on to the bomb and fires on the
        // move instead of stopping to trade shots on the way there.
        const onDefuseDuty = bot.job === 'defuse' && bot.defuseSite !== null;
        if (!onDefuseDuty) bot.mode = 'fight';
        shootAt(bot, dt, ctx);
      }
    } else {
      bot.loseTimer += dt;
      if (bot.mode === 'fight' && bot.loseTimer > 1.2) {
        // Resume the walk the fight interrupted: a bot still mid-route
        // goes back to walking it, a bot that already arrived stays put.
        const stillWalking = bot.stepIndex < bot.path.length
          && (bot.job === 'guard' || bot.job === 'hold' || bot.job === 'cover' || bot.job === 'defuse');
        bot.mode = stillWalking ? 'rotate' : bot.job;
      }
    }
    if (bot.mode === 'push') {
      if (stepToward(bot, dt)) arriveAttacker(bot);
    } else if (bot.mode === 'rotate') {
      if (stepToward(bot, dt)) bot.mode = bot.job;
    } else if (bot.mode === 'plant') {
      bot.plantT += dt;
      if (bot.plantT >= PLANT_SECONDS) {
        queue.push({ kind: 'planted', site: bot.targetSite });
        bot.mode = 'guard';
        bot.job = 'guard';
      }
    } else if (bot.mode === 'defuse') {
      bot.defuseT += dt;
      if (bot.defuseT >= DEFUSE_SECONDS) {
        queue.push({ kind: 'defused', site: bot.defuseSite });
        bot.defuseT = 0;
        bot.mode = 'cover';
        bot.job = 'cover';
      }
    }
    // Unstick: a bot wedged on a corner skips to the next waypoint.
    if ((bot.mode === 'push' || bot.mode === 'rotate') && !hasTarget) {
      const speed = Math.hypot(bot.vel.x, bot.vel.z);
      bot.stuckTimer = speed < 0.05 ? bot.stuckTimer + dt : 0;
      if (bot.stuckTimer > 1.5) {
        bot.stepIndex += 1;
        bot.stuckTimer = 0;
      }
    }
    bot.mesh.position.set(bot.pos.x, 0, bot.pos.z);
    bot.mesh.rotation.y = bot.yaw;
  }

  // An attacker finished its route. At the site it starts planting;
  // anywhere else it holds and watches.
  function arriveAttacker(bot) {
    const site = BOMB_SITES[bot.targetSite];
    const d = Math.hypot(bot.pos.x - site.x, bot.pos.z - site.z);
    if (d < site.radius && plantedSite === null) {
      bot.mode = 'plant';
      bot.plantT = 0;
    } else {
      bot.mode = 'hold';
    }
  }

  // If the defuser dies, the nearest living defender takes over the
  // defuse. Without this the round could stall with a planted bomb.
  function ensureDefuser() {
    if (!plantedSite) return;
    for (const bot of bots) {
      if (bot.alive && bot.team === 'def' && bot.defuseSite === plantedSite) return;
    }
    let next = null;
    let nextDist = Infinity;
    for (const bot of bots) {
      if (!bot.alive || bot.team !== 'def') continue;
      const d = Math.hypot(bot.pos.x - BOMB_SITES[plantedSite].x, bot.pos.z - BOMB_SITES[plantedSite].z);
      if (d < nextDist) { nextDist = d; next = bot; }
    }
    if (next) {
      next.defuseSite = plantedSite;
      next.defuseT = 0;
      next.job = 'defuse';
      next.mode = 'rotate';
      next.path = routeToSite(next.pos, plantedSite);
      next.stepIndex = 0;
    }
  }

  function update(dt, ctx) {
    if (ctx.phase !== 'live') return;
    if (ctx.planted) ensureDefuser();
    for (const bot of bots) updateBot(bot, dt, ctx);
  }

  // Find the nearest living bot a ray hits, for the player's shots.
  // The ray may hit any child mesh; the bot is found by walking up
  // to the figure group that carries it.
  function raycastBots(raycaster) {
    const figures = [];
    for (const bot of bots) if (bot.alive) figures.push(bot.mesh);
    const hits = raycaster.intersectObjects(figures, true);
    for (const hit of hits) {
      let node = hit.object;
      while (node && !node.userData.bot) node = node.parent;
      if (node && node.userData.bot && node.userData.bot.alive) {
        return { bot: node.userData.bot, point: hit.point, distance: hit.distance };
      }
    }
    return null;
  }

  // Test and scene helper: drop every bot of one team at once.
  function killAll(team, killer) {
    for (const bot of bots) {
      if (bot.team === team && bot.alive) hurtBot(bot, 10000, killer);
    }
  }

  return {
    bots,
    aliveCount(team) {
      let n = 0;
      for (const bot of bots) if (bot.alive && bot.team === team) n += 1;
      return n;
    },
    resetRound,
    update,
    hurtBot,
    raycastBots,
    onPlanted,
    killAll,
    takeEvents() {
      return queue.splice(0);
    },
  };
}
