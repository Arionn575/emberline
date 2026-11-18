// Emberline: boot and the one loop — a fixed 60 Hz simulation feeding a
// render at the display's rate. The match is a state machine: menu, buy
// phase, live round, round end, match end. One object, M, holds all match
// state; the runner, squad, arsenal and overlay are its modules.
// ?shot=start|play|end with &seed=N sets up a deterministic frame for a
// capture, renders it twice, then freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { COLORS } from './colors.js';
import { makeRng } from './rng.js';
import { buildArena, BOMB_SITES, SPAWN_POINTS } from './arena.js';
import { makeControls } from './controls.js';
import { makeRunner } from './movement.js';
import { makeArsenal, makeThrowables, GUNS, GRENADE_COST, ARMOR_COST } from './arsenal.js';
import { makeSquad } from './squad.js';
import { makeOverlay } from './overlay.js';
import { makeSound } from './sound.js';

const STEP = 1 / 60;
const BUY_SECS = 15;
const ROUND_SECS = 115;
const BOMB_SECS = 40;
const PLANT_SECS = 3;
const WIN_ROUNDS = 8;
const KILL_PAY = 300;
const WIN_PAY = 3250;
const LOSS_PAY = 1900;
const START_CASH = 800;
const BASE_FOV = 74;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const rng = makeRng(seed);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.dusk);
scene.fog = new THREE.Fog(new THREE.Color(COLORS.dusk), 30, 70);
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.05, 140);
scene.add(camera);

const arena = buildArena(scene);
const sound = makeSound();
const overlay = makeOverlay();
const arsenal = makeArsenal(camera);
const throwables = makeThrowables(scene, arena.colliders, arena.walls);
const runner = makeRunner(arena.colliders);
const controls = makeControls(renderer.domElement, onLockChange);
const raycaster = new THREE.Raycaster();
raycaster.far = 80;
const aimDir = new THREE.Vector3();
const muzzle = new THREE.Vector3();

// Bomb mesh: a small dark box with a blinking amber light, placed on plant.
const bombGroup = new THREE.Group();
const bombBox = new THREE.Mesh(
  new THREE.BoxGeometry(0.34, 0.18, 0.24),
  new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.dusk), roughness: 0.5, metalness: 0.4 }),
);
const bombLight = new THREE.Mesh(
  new THREE.SphereGeometry(0.045, 8, 8),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ember) }),
);
bombLight.position.y = 0.12;
bombGroup.add(bombBox, bombLight);
bombGroup.visible = false;
scene.add(bombGroup);

// Detonation flash for a bomb that goes off.
const blastMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ember), transparent: true, opacity: 0, depthWrite: false }),
);
blastMesh.visible = false;
scene.add(blastMesh);
let blastLeft = 0;

const M = {
  phase: 'menu',
  phaseTime: 0,
  round: 1,
  roundSite: 'A',
  score: { atk: 0, def: 0 },
  cash: START_CASH,
  health: 100,
  armor: 0,
  alive: true,
  kills: 0,
  deaths: 0,
  loadout: { weapons: ['pistol'], grenades: 0, armor: 0 },
  bomb: { state: 'none', site: null, pos: new THREE.Vector3(), timer: 0, beepSecond: -1 },
  plantT: 0,
  buyOpen: false,
  spectate: null,
  prevFiring: false,
  prevGrenade: false,
  prevBuy: false,
  prevKeys: new Set(),
};

const body = runner.body;

function hurtPlayer(amount) {
  if (!M.alive || M.phase !== 'live') return;
  let rest = amount;
  if (M.armor > 0) {
    const absorbed = Math.min(M.armor, Math.round(amount * 0.5));
    M.armor -= absorbed;
    rest = amount - absorbed;
  }
  M.health -= rest;
  overlay.setHealth(M.health, M.armor);
  if (M.health <= 0) {
    M.health = 0;
    M.alive = false;
    M.deaths += 1;
    arsenal.reset();
    M.loadout = { weapons: ['pistol'], grenades: 0, armor: 0 };
    overlay.setWeaponName(GUNS.pistol.label);
    overlay.setAmmo(arsenal.state.mag, arsenal.state.reserve);
    const mate = squad.bots.find((b) => b.team === 'atk' && b.alive);
    M.spectate = mate || null;
    overlay.showBanner('You are down', mate ? `Spectating ${mate.name}` : 'Your squad is gone');
    sound.roundLose();
  }
}

const squad = makeSquad(scene, arena.colliders, arena.walls, rng, {
  onKill(killer, victim, head) {
    const killerTeam = killer === 'you' || ['Ash', 'Cinder', 'Flint', 'Slate'].includes(killer) ? 'atk' : 'def';
    overlay.addKill(killer, victim, killerTeam);
    if (killer === 'you') {
      M.cash += KILL_PAY;
      M.kills += 1;
      overlay.setMoney(M.cash);
      sound.kill();
    }
  },
  onDamagePlayer(amount, head, bot) {
    hurtPlayer(amount);
  },
  onDefused() {
    if (M.phase === 'live' && M.bomb.state === 'planted') finishRound('def', 'defuse');
  },
});

function syncCamera() {
  if (!M.alive && M.spectate) {
    const mate = M.spectate;
    camera.position.set(mate.pos.x, mate.pos.y + 1.5, mate.pos.z);
    camera.rotation.set(0, mate.yaw, 0, 'YXZ');
    return;
  }
  camera.position.set(body.position.x, body.position.y + body.eyeHeight, body.position.z);
  camera.rotation.set(body.pitch, body.yaw, 0, 'YXZ');
}

function lookAt(point) {
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eyeHeight);
  const dz = point.z - body.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

function playerChest() {
  return new THREE.Vector3(body.position.x, body.position.y + (body.crouched ? 0.8 : 1.2), body.position.z);
}

function fire(spread) {
  if (!arsenal.spendRound()) return false;
  camera.getWorldDirection(aimDir);
  aimDir.x += (rng() * 2 - 1) * spread;
  aimDir.y += (rng() * 2 - 1) * spread;
  aimDir.z += (rng() * 2 - 1) * spread;
  aimDir.normalize();
  muzzle.copy(camera.position).addScaledVector(aimDir, 0.5);
  scene.updateMatrixWorld(true);
  raycaster.set(camera.position, aimDir);
  const targets = arena.walls.concat(squad.hitMeshes);
  const hit = raycaster.intersectObjects(targets, false)[0];
  const end = hit ? hit.point : muzzle.clone().addScaledVector(aimDir, 60);
  squad.drawTracer(muzzle, end);
  if (hit && hit.object.userData.bot) {
    const bot = hit.object.userData.bot;
    const head = hit.object.userData.part === 'head';
    const spec = arsenal.spec();
    const killed = squad.hurt(bot, head ? spec.head : spec.damage, null, head);
    overlay.hitMarker(killed, 4000);
    sound.hit();
  }
  arsenal.fire();
  runner.kick(0.009 + rng() * 0.004, (rng() * 2 - 1) * 0.004);
  overlay.setAmmo(arsenal.state.mag, arsenal.state.reserve);
  sound.shot();
  squad.hearShot(body.position, 'atk', elapsed);
  return true;
}

function tossGrenade() {
  if (M.loadout.grenades <= 0) return;
  M.loadout.grenades -= 1;
  arsenal.state.grenades = 0;
  camera.getWorldDirection(aimDir);
  throwables.throwFrom(camera.position.clone(), aimDir.clone());
}

function siteUnderPlayer() {
  for (const site of Object.values(BOMB_SITES)) {
    const d = Math.hypot(body.position.x - site.x, body.position.z - site.z);
    if (d <= site.radius) return site;
  }
  return null;
}

function plantBombAt(site, pos) {
  M.bomb.state = 'planted';
  M.bomb.site = site;
  M.bomb.pos.copy(pos);
  M.bomb.timer = BOMB_SECS;
  M.bomb.beepSecond = -1;
  bombGroup.position.copy(pos);
  bombGroup.visible = true;
  overlay.setBombStatus(`BOMB PLANTED AT SITE ${site.id} — ${BOMB_SECS}s`, true);
  sound.plant();
  dispatchDefenders(site);
}

function dispatchDefenders(site) {
  const defuser = squad.nearestDefender(site);
  if (defuser) squad.dispatchDefuser(defuser, site);
  // A second defender pushes to the site as cover for the defuser.
  const cover = squad.bots
    .filter((b) => b.team === 'def' && b.alive && b !== defuser && !b.defuseSite)
    .sort((a, b) => {
      const da = Math.hypot(a.pos.x - site.x, a.pos.z - site.z);
      const db = Math.hypot(b.pos.x - site.x, b.pos.z - site.z);
      return da - db;
    })[0];
  if (cover) squad.dispatchCover(cover, site);
  // And the two nearest attackers rotate back to guard the planted bomb,
  // so the defuse is a fight at the site, not a free walk.
  const guards = squad.bots
    .filter((b) => b.team === 'atk' && b.alive)
    .sort((a, b) => {
      const da = Math.hypot(a.pos.x - site.x, a.pos.z - site.z);
      const db = Math.hypot(b.pos.x - site.x, b.pos.z - site.z);
      return da - db;
    })
    .slice(0, 2);
  for (const guard of guards) squad.dispatchCover(guard, site);
}

function finishRound(winner, reason) {
  if (M.phase !== 'live') return;
  M.lastReason = reason;
  M.score[winner] += 1;
  M.cash += winner === 'atk' ? WIN_PAY : LOSS_PAY;
  overlay.setMoney(M.cash);
  overlay.setScore(M.score.atk, M.score.def);
  const reasons = {
    elim: winner === 'atk' ? 'VEX squad eliminated' : 'Ember squad eliminated',
    bomb: 'Bomb detonated',
    defuse: 'Bomb defused',
    time: 'Time expired — bomb never planted',
  };
  overlay.showBanner(winner === 'atk' ? 'ROUND WON' : 'ROUND LOST', reasons[reason] || reason);
  if (winner === 'atk') sound.roundWin();
  else sound.roundLose();
  bombGroup.visible = false;
  M.bomb.state = 'none';
  M.phase = 'roundEnd';
  M.phaseTime = 4;
  M.buyOpen = false;
  overlay.hideBuy();
  overlay.hideProgress();
}

function beginRound(n) {
  M.round = n;
  M.roundSite = ['A', 'B', 'mid'][Math.floor(rng() * 3)];
  squad.reset(M.roundSite);
  throwables.clear();
  body.position.set(SPAWN_POINTS.atk[0][0], 0, SPAWN_POINTS.atk[0][1]);
  body.velocity.set(0, 0, 0);
  body.yaw = 0;
  body.pitch = 0;
  M.health = 100;
  M.alive = true;
  M.spectate = null;
  M.bomb.state = 'carried';
  M.bomb.site = null;
  M.plantT = 0;
  bombGroup.visible = false;
  M.phase = 'buy';
  M.phaseTime = BUY_SECS;
  M.buyOpen = true;
  overlay.setHealth(M.health, M.armor);
  overlay.setAmmo(arsenal.state.mag, arsenal.state.reserve);
  overlay.setMoney(M.cash);
  overlay.setScore(M.score.atk, M.score.def);
  overlay.setBombStatus(`YOU CARRY THE BOMB — PLANT AT SITE ${M.roundSite === 'mid' ? 'A OR B' : M.roundSite}`, false);
  overlay.showBuy(M.cash, M.loadout);
  overlay.hideBanner();
  syncCamera();
}

function beginMatch() {
  M.score = { atk: 0, def: 0 };
  M.cash = START_CASH;
  M.kills = 0;
  M.deaths = 0;
  M.armor = 0;
  M.loadout = { weapons: ['pistol'], grenades: 0, armor: 0 };
  arsenal.reset();
  overlay.setWeaponName(GUNS.pistol.label);
  beginRound(1);
}

function finishMatch() {
  M.phase = 'matchEnd';
  if (document.pointerLockElement) document.exitPointerLock();
  overlay.setScope(false);
  overlay.showPanel(M.score.atk >= WIN_ROUNDS ? 'matchWin' : 'matchLose', `${M.score.atk}–${M.score.def}`);
}

function buyItem(code) {
  const map = { Digit1: 'rifle', Digit2: 'smg', Digit3: 'sniper', Digit4: 'pistol', KeyG: 'grenade', KeyV: 'armor' };
  const id = map[code];
  if (!id) return;
  if (id === 'grenade') {
    if (M.loadout.grenades > 0 || M.cash < GRENADE_COST) return;
    M.cash -= GRENADE_COST;
    M.loadout.grenades = 1;
    arsenal.state.grenades = 1;
  } else if (id === 'armor') {
    if (M.armor > 0 || M.cash < ARMOR_COST) return;
    M.cash -= ARMOR_COST;
    M.armor = 50;
    M.loadout.armor = 50;
    overlay.setHealth(M.health, M.armor);
  } else {
    const spec = GUNS[id];
    if (M.loadout.weapons.includes(id) || M.cash < spec.price) return;
    M.cash -= spec.price;
    M.loadout.weapons.push(id);
    arsenal.stock(id);
    arsenal.equip(id);
    overlay.setWeaponName(spec.label);
    overlay.setAmmo(arsenal.state.mag, arsenal.state.reserve);
  }
  overlay.setMoney(M.cash);
  overlay.showBuy(M.cash, M.loadout);
}

function switchGun(code) {
  const order = ['pistol', 'rifle', 'smg', 'sniper'];
  const map = { Digit1: 'rifle', Digit2: 'smg', Digit3: 'sniper', Digit4: 'pistol' };
  const id = map[code];
  if (id && M.loadout.weapons.includes(id) && arsenal.equip(id)) {
    overlay.setWeaponName(GUNS[id].label);
    overlay.setAmmo(arsenal.state.mag, arsenal.state.reserve);
  } else if (code === 'wheel') {
    const current = order.indexOf(arsenal.state.id);
    for (let i = 1; i <= order.length; i += 1) {
      const next = order[(current + i) % order.length];
      if (M.loadout.weapons.includes(next)) {
        arsenal.equip(next);
        overlay.setWeaponName(GUNS[next].label);
        overlay.setAmmo(arsenal.state.mag, arsenal.state.reserve);
        break;
      }
    }
  }
}

let elapsed = 0;

function tick(dt) {
  elapsed += dt;
  const keys = controls.state.keys;

  if (M.phase === 'buy') {
    M.phaseTime -= dt;
    overlay.setTimer(M.phaseTime);
    if (keys.has('KeyB') && !M.prevBuy) {
      M.buyOpen = !M.buyOpen;
      if (M.buyOpen) overlay.showBuy(M.cash, M.loadout);
      else overlay.hideBuy();
    }
    M.prevBuy = keys.has('KeyB');
    if (M.buyOpen) {
      for (const code of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyG', 'KeyV']) {
        if (keys.has(code) && !M.prevKeys.has(code)) buyItem(code);
      }
    }
    if (M.phaseTime <= 0) {
      M.phase = 'live';
      M.phaseTime = ROUND_SECS;
      M.buyOpen = false;
      overlay.hideBuy();
      overlay.setBombStatus(`PLANT THE BOMB AT SITE ${M.roundSite === 'mid' ? 'A OR B' : M.roundSite}`, false);
    }
  } else if (M.phase === 'live') {
    M.phaseTime -= dt;
    overlay.setTimer(M.phaseTime);

    // Bomb countdown and beeps.
    if (M.bomb.state === 'planted') {
      M.bomb.timer -= dt;
      const whole = Math.ceil(M.bomb.timer);
      if (whole !== M.bomb.beepSecond) {
        M.bomb.beepSecond = whole;
        bombLight.visible = !bombLight.visible;
        if (whole <= 10) sound.bombBeep();
      }
      overlay.setBombStatus(`BOMB PLANTED AT SITE ${M.bomb.site.id} — ${whole}s`, true);
      if (M.bomb.timer <= 0) {
        blastMesh.position.copy(M.bomb.pos).setY(1);
        blastMesh.visible = true;
        blastLeft = 0.5;
        bombGroup.visible = false;
        sound.explosion();
        finishRound('atk', 'bomb');
      }
    }

    // A planted bomb needs a defuser: send the nearest alive defender.
    if (M.bomb.state === 'planted' && !squad.bots.some((b) => b.team === 'def' && b.alive && b.defuseSite)) {
      dispatchDefenders(M.bomb.site);
    }

    // Player movement, shooting and actions, only while alive. The look
    // delta is consumed every step so it never piles up while spectating.
    const look = controls.drainLook();
    if (M.alive) {
      runner.look(look.x, look.y);
      runner.update(dt, keys);
      arsenal.update(dt);

      // Sniper scope on right mouse: the view narrows and a scope ring
      // covers the screen edges, so aiming feels like aiming.
      const spec = arsenal.spec();
      const scoping = controls.state.scoping && spec.zoom > 1;
      const targetFov = scoping ? BASE_FOV / spec.zoom : BASE_FOV;
      if (Math.abs(camera.fov - targetFov) > 0.1) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
      }
      overlay.setScope(scoping);

      const firing = controls.state.firing;
      if (firing && arsenal.canFire() && (spec.auto || !M.prevFiring)) {
        fire(arsenal.spreadFor(runner.speed()) * (scoping ? 0.3 : 1));
      }
      M.prevFiring = firing;
      if (keys.has('KeyR')) arsenal.reload();
      if (keys.has('KeyG') && !M.prevGrenade) tossGrenade();
      M.prevGrenade = keys.has('KeyG');
      const wheel = controls.drainWheel();
      if (wheel !== 0) switchGun('wheel');
      for (const code of ['Digit1', 'Digit2', 'Digit3', 'Digit4']) {
        if (keys.has(code) && !M.prevKeys.has(code)) switchGun(code);
      }

      // Planting: hold E inside a bomb site while carrying the bomb.
      const site = siteUnderPlayer();
      if (M.bomb.state === 'carried' && site && keys.has('KeyE')) {
        M.plantT += dt;
        overlay.showProgress(`PLANTING BOMB — SITE ${site.id}`, M.plantT / PLANT_SECS);
        if (M.plantT >= PLANT_SECS) {
          overlay.hideProgress();
          plantBombAt(site, body.position.clone());
        }
      } else {
        if (M.plantT > 0) overlay.hideProgress();
        M.plantT = 0;
      }
    }

    squad.update(dt, elapsed, {
      pos: body.position, crouching: body.crouched, alive: M.alive,
      speed: runner.speed(), height: body.height,
    });
    squad.tickDefuse(dt);
    throwables.update(dt, (blast) => {
      for (const bot of squad.bots) {
        if (!bot.alive) continue;
        blast.check(new THREE.Vector3(bot.pos.x, bot.pos.y + 1.1, bot.pos.z), false, bot);
      }
      blast.check(playerChest(), true, null);
      for (const hit of blast.hits) {
        if (hit.isPlayer) hurtPlayer(hit.amount);
        else squad.hurt(hit.target, hit.amount, null, false);
      }
      sound.explosion();
    });

    // Round end by elimination or by the clock.
    if (M.phase === 'live') {
      if (M.bomb.state !== 'planted') {
        if (squad.aliveCount('def') === 0) finishRound('atk', 'elim');
        else if (squad.aliveCount('atk') === 0 && !M.alive) finishRound('def', 'elim');
        else if (M.phaseTime <= 0) finishRound('def', 'time');
      }
    }
  } else if (M.phase === 'roundEnd') {
    M.phaseTime -= dt;
    overlay.setTimer(0);
    if (M.phaseTime <= 0) {
      if (M.score.atk >= WIN_ROUNDS || M.score.def >= WIN_ROUNDS) finishMatch();
      else beginRound(M.round + 1);
    }
  }

  if (blastLeft > 0) {
    blastLeft -= dt;
    const k = Math.max(0, blastLeft / 0.5);
    blastMesh.scale.setScalar(1 + (1 - k) * 8);
    blastMesh.material.opacity = k * 0.6;
    if (blastLeft <= 0) blastMesh.visible = false;
  }

  M.prevKeys = new Set(keys);
  syncCamera();
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen) {
    if (M.phase === 'live' || M.phase === 'buy' || M.phase === 'roundEnd') {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= STEP && steps < 5) {
        tick(STEP);
        accumulator -= STEP;
        steps += 1;
      }
      if (accumulator > STEP * 5) accumulator = 0;
    }
    syncCamera();
  }
  renderer.render(scene, camera);
}

function settle(steps) {
  for (let i = 0; i < steps; i += 1) tick(STEP);
}

function runShot(name) {
  overlay.hidePanel();
  beginMatch();
  if (name === 'start') {
    // Spawn view down mid with the buy menu open and teammates beside.
    body.position.set(0, 0, 15);
    body.yaw = 0;
    body.pitch = 0;
    settle(20);
    overlay.showBuy(M.cash, M.loadout);
    lookAt(new THREE.Vector3(0, 1.5, -6));
  } else if (name === 'play') {
    // Mid-round firefight, staged at the Site A entrance: the defenders
    // hold inside the site and the player pushes in with the team.
    M.phase = 'live';
    M.phaseTime = ROUND_SECS - 20;
    M.buyOpen = false;
    overlay.hideBuy();
    body.position.set(-10, 0, -3);
    body.yaw = 0.93;
    body.pitch = 0;
    settle(60 * 3);
    // Aim at the nearest defender with a clear line of sight, so the
    // scripted shots land on a bot instead of a wall.
    let target = null;
    let targetDist = Infinity;
    for (const bot of squad.bots) {
      if (bot.team !== 'def' || !bot.alive) continue;
      const point = new THREE.Vector3(bot.pos.x, bot.pos.y + 1.1, bot.pos.z);
      const dist = body.position.distanceTo(point);
      if (dist >= targetDist) continue;
      aimDir.copy(point).sub(camera.position).normalize();
      raycaster.set(camera.position, aimDir);
      raycaster.far = dist;
      if (raycaster.intersectObjects(arena.walls, false).length) continue;
      target = bot;
      targetDist = dist;
    }
    if (target) {
      lookAt(new THREE.Vector3(target.pos.x, target.pos.y + 1.1, target.pos.z));
      for (let round = 0; round < 3; round += 1) {
        fire(0);
        settle(8);
      }
    }
    settle(12);
  } else {
    // Match won: the panel up over the yard, score 8–3, player at Site A.
    M.phase = 'live';
    M.phaseTime = ROUND_SECS - 40;
    M.buyOpen = false;
    overlay.hideBuy();
    M.score.atk = 7;
    M.score.def = 3;
    overlay.setScore(7, 3);
    body.position.set(-14, 0, -5);
    settle(30);
    for (const bot of squad.bots) {
      if (bot.team === 'def' && bot.alive) squad.hurt(bot, 200, null, false);
    }
    finishRound('atk', 'elim');
    settle(60 * 4 + 5);
    // finishRound left us in roundEnd; the match-end panel shows now.
    overlay.setScore(M.score.atk, M.score.def);
    lookAt(new THREE.Vector3(-18, 1.2, -9));
    settle(10);
  }
  overlay.setScore(M.score.atk, M.score.def);
  overlay.setAmmo(arsenal.state.mag, arsenal.state.reserve);
  overlay.setMoney(M.cash);
  overlay.setHealth(M.health, M.armor);
  paintTwiceThenReady();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

let frozen = false;
let accumulator = 0;
let lastTime = performance.now();

overlay.setAmmo(arsenal.state.mag, arsenal.state.reserve);
overlay.setMoney(M.cash);
overlay.setHealth(M.health, M.armor);
overlay.setScore(0, 0);
overlay.setTimer(ROUND_SECS);
overlay.onPlay(() => {
  sound.unlock();
  if (shot) return;
  if (M.phase === 'matchEnd' || M.phase === 'menu') {
    beginMatch();
  }
  controls.lock();
});

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    overlay.hidePanel();
  } else if (M.phase === 'live' || M.phase === 'buy') {
    overlay.showPanel('paused');
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

syncCamera();
if (shot) runShot(shot);
else requestAnimationFrame(frame);

// Debug handle for local playtesting: lets a test read match state and bot
// positions, and advance the fixed-step simulation deterministically (the
// headless software renderer runs far below 60 fps, so the live loop would
// otherwise run in slow motion). It changes nothing about the game itself.
window.__emberline = {
  M, squad, runner, arsenal, throwables, camera, controls, arena,
  advance(seconds) {
    const n = Math.round(seconds / STEP);
    for (let i = 0; i < n; i += 1) tick(STEP);
  },
  lookAt,
  fire,
  plantAtSite(siteId) {
    const site = BOMB_SITES[siteId];
    if (!site || M.phase !== 'live') return false;
    plantBombAt(site, new THREE.Vector3(site.x, 0, site.z));
    return true;
  },
  scopeState() {
    return {
      fov: camera.fov,
      scoping: controls.state.scoping,
      scopeHidden: document.getElementById('scope').hidden,
      weapon: arsenal.state.id,
    };
  },
  startLive() {
    M.phase = 'live';
    M.phaseTime = ROUND_SECS;
    overlay.hideBuy();
  },
};
