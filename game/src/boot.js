// boot.js — the match flow for Emberline, written fresh.
//
// Boot wires the arena, the arsenal, the squads, and the HUD together
// and runs the match: menu, buy phase, live phase, round end, match
// end. It also owns the player: movement, shooting, planting, the
// sniper scope, grenades, and the debug handle the tests use.
import * as THREE from 'three';
import { buildArena, BOMB_SITES, SPAWN_POINTS } from './arena.js';
import { GUNS, GRENADE_COST, ARMOR_COST, GRENADE_RADIUS, GRENADE_MAX_DAMAGE, GRENADE_FUSE, makeArsenal } from './arsenal.js';
import { COLORS } from './colors.js';
import { makeControls } from './controls.js';
import { makeRunner } from './movement.js';
import { makeOverlay } from './overlay.js';
import { makeRng, pick } from './rng.js';
import { makeSound } from './sound.js';
import { makeSquad } from './squad.js';

// Match numbers: 15 s to buy, 115 s a round, first to 8 takes it.
// The bomb plants in 3 s, ticks for 40 s, and takes 12 s to defuse.
const BUY_SECONDS = 15;
const LIVE_SECONDS = 115;
const ROUND_END_SECONDS = 4;
const WIN_SCORE = 8;
const BOMB_SECONDS = 40;
const PLANT_SECONDS = 3;
const BASE_FOV = 74;
const SCOPE_FOV = 74 / 2.4;

const params = new URLSearchParams(location.search);
const shotKind = params.get('shot');
const seed = Number(params.get('seed') || 0) || ((Math.random() * 2 ** 31) | 0);
const rng = makeRng(seed);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.dusk);
scene.fog = new THREE.Fog(COLORS.dusk, 30, 90);

const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 220);
camera.rotation.order = 'YXZ';
scene.add(camera);

const arena = buildArena(scene);

// The modules boot wires together. The arsenal owns the guns and the
// grenade physics; the squad owns the bots; the runner owns the body.
const arsenal = makeArsenal(camera);
const runner = makeRunner(arena.colliders);
const overlay = makeOverlay();
const sound = makeSound();
const squad = makeSquad(scene, arena.colliders, arena.walls, rng);
const controls = makeControls(renderer.domElement, (locked) => {
  if (!locked && (M.phase === 'live' || M.phase === 'buy')) overlay.showPanel('paused');
});

// The match state. Tests read and write M directly, so this object is
// the live state, never a copy.
const M = {
  phase: 'menu',
  round: 1,
  score: { atk: 0, def: 0 },
  health: 100,
  armor: 0,
  alive: 6,
  cash: 800,
  bomb: { state: 'idle', site: null, timer: 0 },
  lastReason: '',
  phaseTime: 0,
  loadout: { grenades: 0, weapons: ['pistol'], armor: 0 },
};

let playerAlive = true;
let plantT = 0;
let lastBeepSecond = -1;
let fixedCam = null;
let buyVisible = false;

// The match flow. A match is a fresh economy and score; a round is a
// fresh spawn for everyone and a 15 s buy phase; live starts the clock.
function beginMatch() {
  M.score.atk = 0;
  M.score.def = 0;
  M.round = 1;
  M.cash = 800;
  M.health = 100;
  M.armor = 0;
  M.loadout = { grenades: 0, weapons: ['pistol'], armor: 0 };
  arsenal.reset();
  playerAlive = true;
  beginRound();
}

function beginRound() {
  const site = pick(rng, ['A', 'B']);
  squad.resetRound(site);
  runner.body.position.set(SPAWN_POINTS.atk[0][0], 0, SPAWN_POINTS.atk[0][1]);
  runner.body.velocity.set(0, 0, 0);
  runner.body.yaw = 0;
  runner.body.pitch = 0;
  M.health = 100;
  playerAlive = true;
  M.loadout.armor = M.armor > 0 ? 1 : 0;
  for (const id of M.loadout.weapons) arsenal.stock(id);
  M.bomb.state = 'idle';
  M.bomb.site = null;
  M.bomb.timer = 0;
  plantT = 0;
  throwables.clear();
  M.phase = 'buy';
  M.phaseTime = BUY_SECONDS;
  overlay.showBuy(M.cash, M.loadout);
  overlay.setBombStatus('PLANT THE BOMB AT SITE A OR B', false);
  overlay.hideProgress();
  overlay.hideBanner();
  buyVisible = true;
}

function beginLive() {
  if (M.phase === 'menu' || M.phase === 'matchEnd') beginMatch();
  else if (M.phase === 'roundEnd') beginRound();
  if (M.phase !== 'buy') return;
  M.phase = 'live';
  M.phaseTime = LIVE_SECONDS;
  overlay.hideBuy();
  buyVisible = false;
  overlay.showBanner(`Round ${M.round}`, 'Plant the bomb at Site A or B.');
}

function closeRound(winner, reason) {
  if (M.phase !== 'live') return;
  M.score[winner] += 1;
  M.cash += winner === 'atk' ? 3250 : 1900;
  M.lastReason = reason;
  M.round += 1;
  M.phase = 'roundEnd';
  M.phaseTime = ROUND_END_SECONDS;
  plantT = 0;
  overlay.hideProgress();
  overlay.hideBuy();
  buyVisible = false;
  const label = winner === 'atk' ? 'EMBER' : 'VEX';
  const why = reason === 'bomb' ? 'The bomb detonated.' : reason === 'defused' ? 'The bomb was defused.' : reason === 'timeout' ? 'Time ran out.' : 'One squad was eliminated.';
  overlay.showBanner(`Round to ${label}`, why);
  if (winner === 'atk') sound.roundWin();
  else sound.roundLose();
}

function closeMatch(winner) {
  M.phase = 'matchEnd';
  // Free the mouse so the match-over panel's button can be clicked:
  // pointer lock would otherwise keep sending clicks to the canvas.
  controls.release();
  overlay.showPanel(winner === 'atk' ? 'matchWin' : 'matchLose', `${M.score.atk}–${M.score.def}`);
  if (winner === 'atk') sound.roundWin();
  else sound.roundLose();
}

function doPlant(site) {
  if (M.bomb.state === 'planted') return;
  M.bomb.state = 'planted';
  M.bomb.site = site;
  M.bomb.timer = BOMB_SECONDS;
  lastBeepSecond = -1;
  squad.onPlanted(site);
  overlay.setBombStatus(`BOMB PLANTED AT SITE ${site}`, true);
  overlay.showBanner('Bomb planted', 'Defend it until it blows.');
  overlay.hideProgress();
  sound.plant();
}

// The player's shot: a ray from the camera with the gun's spread. The
// nearest wall stops it; a bot in front of the wall takes the hit, and
// a hit high on the figure counts as a headshot.
const raycaster = new THREE.Raycaster();
const shotDir = new THREE.Vector3();

function tryFire() {
  if (!arsenal.canFire()) return;
  arsenal.fire();
  if (!arsenal.spendRound()) return;
  const spec = arsenal.spec();
  const spread = arsenal.spreadFor(runner.speed());
  camera.updateMatrixWorld(true);
  camera.getWorldDirection(shotDir);
  shotDir.x += (rng() - 0.5) * 2 * spread;
  shotDir.y += (rng() - 0.5) * 2 * spread;
  shotDir.z += (rng() - 0.5) * 2 * spread;
  shotDir.normalize();
  raycaster.set(camera.position, shotDir);
  raycaster.far = 120;
  const wallHits = raycaster.intersectObjects(arena.walls, false);
  const wallDist = wallHits.length ? wallHits[0].distance : Infinity;
  const botHit = squad.raycastBots(raycaster);
  sound.shot();
  runner.kick(0.011, (rng() - 0.5) * 0.008);
  if (botHit && botHit.distance < wallDist) {
    const head = botHit.point.y > botHit.bot.pos.y + 1.38;
    const died = squad.hurtBot(botHit.bot, head ? spec.head : spec.damage, 'player');
    overlay.hitMarker(died);
    sound.hit();
    if (died) sound.kill();
  }
}

// Damage to the player. Kevlar soaks half of each hit until it is gone.
function applyPlayerDamage(amount) {
  if (!playerAlive || M.phase !== 'live') return;
  let rest = amount;
  if (M.armor > 0) {
    const soaked = Math.min(M.armor, Math.ceil(amount / 2));
    M.armor -= soaked;
    rest -= soaked;
    if (M.armor === 0) M.loadout.armor = 0;
  }
  M.health -= rest;
  if (M.health <= 0) {
    M.health = 0;
    playerAlive = false;
    overlay.showBanner('You are down', 'Your squad fights on without you.');
  }
}

// Grenades, kept simple on purpose: a straight throw along the aim
// direction with gravity, a short fuse, then a spherical blast whose
// damage falls off with distance. No wall test: the blast reaches
// everyone inside its radius.
const liveGrenades = [];
const grenadeGeo = new THREE.SphereGeometry(0.09, 10, 8);
const grenadeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.dusk), roughness: 0.4, metalness: 0.6 });
const blastGeo = new THREE.SphereGeometry(1, 16, 12);
const blastMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ember), transparent: true, opacity: 0, depthWrite: false });
const blastMesh = new THREE.Mesh(blastGeo, blastMat);
blastMesh.visible = false;
scene.add(blastMesh);
let blastLeft = 0;

function detonateGrenade(g) {
  blastMesh.position.copy(g.pos);
  blastMesh.visible = true;
  blastLeft = 0.25;
  for (const bot of squad.bots) {
    if (!bot.alive) continue;
    const d = Math.hypot(bot.pos.x - g.pos.x, 1.1 - g.pos.y, bot.pos.z - g.pos.z);
    if (d > GRENADE_RADIUS) continue;
    const amount = d < 2.5 ? 999 : Math.max(10, Math.round(GRENADE_MAX_DAMAGE * (1 - d / GRENADE_RADIUS)));
    squad.hurtBot(bot, amount, 'player');
  }
  if (playerAlive) {
    const pd = Math.hypot(runner.body.position.x - g.pos.x, 1.1 - g.pos.y, runner.body.position.z - g.pos.z);
    if (pd <= GRENADE_RADIUS) applyPlayerDamage(Math.max(10, Math.round(GRENADE_MAX_DAMAGE * (1 - pd / GRENADE_RADIUS))));
  }
  sound.explosion();
}

const throwables = {
  throwFrom(origin, direction) {
    const mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
    mesh.castShadow = true;
    scene.add(mesh);
    liveGrenades.push({
      mesh,
      pos: origin.clone(),
      vel: direction.clone().multiplyScalar(14).add(new THREE.Vector3(0, 3.5, 0)),
      fuse: GRENADE_FUSE,
    });
  },
  update(dt) {
    if (blastLeft > 0) {
      blastLeft -= dt;
      const k = Math.max(0, blastLeft / 0.25);
      blastMesh.scale.setScalar(1 + (1 - k) * 4);
      blastMat.opacity = k * 0.7;
      if (blastLeft <= 0) blastMesh.visible = false;
    }
    for (let i = liveGrenades.length - 1; i >= 0; i -= 1) {
      const g = liveGrenades[i];
      g.fuse -= dt;
      g.vel.y -= 12 * dt;
      g.pos.addScaledVector(g.vel, dt);
      if (g.pos.y < 0.09) {
        g.pos.y = 0.09;
        g.vel.y = Math.abs(g.vel.y) * 0.4;
        g.vel.x *= 0.7;
        g.vel.z *= 0.7;
      }
      g.pos.x = Math.max(-23.5, Math.min(23.5, g.pos.x));
      g.pos.z = Math.max(-17.5, Math.min(17.5, g.pos.z));
      g.mesh.position.copy(g.pos);
      if (g.fuse <= 0) {
        detonateGrenade(g);
        scene.remove(g.mesh);
        liveGrenades.splice(i, 1);
      }
    }
  },
  liveCount() {
    return liveGrenades.length;
  },
  clear() {
    for (const g of liveGrenades) scene.remove(g.mesh);
    liveGrenades.length = 0;
    blastMesh.visible = false;
    blastLeft = 0;
  },
};

// Buying. In the buy phase the number keys buy and equip; in a live
// round they only switch between weapons already owned.
function pressDigit(id) {
  if (M.phase === 'buy') {
    if (!M.loadout.weapons.includes(id)) {
      if (M.cash < GUNS[id].price) return;
      M.cash -= GUNS[id].price;
      M.loadout.weapons.push(id);
      arsenal.stock(id);
    }
    arsenal.equip(id);
    overlay.showBuy(M.cash, M.loadout);
  } else if (M.phase === 'live' && M.loadout.weapons.includes(id)) {
    arsenal.equip(id);
  }
}

function buyGrenade() {
  if (M.phase !== 'buy' || M.cash < GRENADE_COST || M.loadout.grenades >= 2) return;
  M.cash -= GRENADE_COST;
  M.loadout.grenades += 1;
  overlay.showBuy(M.cash, M.loadout);
}

function buyArmor() {
  if (M.phase !== 'buy' || M.cash < ARMOR_COST || M.armor > 0) return;
  M.cash -= ARMOR_COST;
  M.armor = 50;
  M.loadout.armor = 1;
  overlay.showBuy(M.cash, M.loadout);
}

// Throwing: the grenade count lives in the loadout, which tests may set
// directly, so the arsenal's count is synced from it before throwing.
function throwGrenade() {
  arsenal.state.grenades = M.loadout.grenades;
  if (arsenal.state.grenades <= 0 || !playerAlive || M.phase !== 'live') return;
  const dir = new THREE.Vector3();
  camera.updateMatrixWorld(true);
  camera.getWorldDirection(dir);
  throwables.throwFrom(camera.position.clone(), dir);
  arsenal.state.grenades -= 1;
  M.loadout.grenades = arsenal.state.grenades;
}

// Planting by the player: hold E near a site for three seconds. The
// progress bar shows the channel; leaving the site wipes it.
function plantTick(dt) {
  if (M.bomb.state !== 'idle' || !controls.state.keys.has('KeyE')) {
    if (plantT > 0) overlay.hideProgress();
    plantT = 0;
    return;
  }
  let near = null;
  for (const site of Object.values(BOMB_SITES)) {
    const d = Math.hypot(runner.body.position.x - site.x, runner.body.position.z - site.z);
    if (d < site.radius) near = site;
  }
  if (!near) {
    if (plantT > 0) overlay.hideProgress();
    plantT = 0;
    return;
  }
  plantT += dt;
  overlay.showProgress('Planting the bomb', Math.min(1, plantT / PLANT_SECONDS));
  if (plantT >= PLANT_SECONDS) doPlant(near.id);
}

// Scoping: only the sniper zooms, to about 31 degrees from 74.
function isScoping() {
  return controls.state.scoping && arsenal.state.id === 'sniper';
}

function scopeState() {
  const scoping = isScoping();
  return { fov: scoping ? SCOPE_FOV : BASE_FOV, scoping, scopeHidden: !scoping, weapon: arsenal.state.id };
}

// Keyboard: number keys buy or switch, R reloads, G throws or buys a
// grenade, V buys armour, B shows or hides the buy panel.
window.addEventListener('keydown', (event) => {
  if (event.repeat || (M.phase !== 'buy' && M.phase !== 'live')) return;
  if (event.code === 'Digit1') pressDigit('rifle');
  else if (event.code === 'Digit2') pressDigit('smg');
  else if (event.code === 'Digit3') pressDigit('sniper');
  else if (event.code === 'Digit4') pressDigit('pistol');
  else if (event.code === 'KeyR') { arsenal.reload(); sound.reload(); }
  else if (event.code === 'KeyG') {
    if (M.phase === 'buy') buyGrenade();
    else throwGrenade();
  } else if (event.code === 'KeyV' && M.phase === 'buy') buyArmor();
  else if (event.code === 'KeyB' && M.phase === 'buy') {
    buyVisible = !buyVisible;
    if (buyVisible) overlay.showBuy(M.cash, M.loadout);
    else overlay.hideBuy();
  }
});

// The play button: start a match from the menu or after a match, or
// resume from pause. Locking the pointer is best effort; the game
// starts even where the browser refuses it.
overlay.onPlay(() => {
  sound.unlock();
  controls.lock();
  if (M.phase === 'menu' || M.phase === 'matchEnd') {
    overlay.hidePanel();
    beginMatch();
  } else {
    overlay.hidePanel();
  }
});

// Aim the player's view at a point, for the tests and the shot scenes.
function lookAt(target) {
  const p = runner.body.position;
  const dx = target.x - p.x;
  const dy = (target.y ?? 1.2) - (p.y + runner.body.eyeHeight);
  const dz = target.z - p.z;
  runner.body.yaw = Math.atan2(-dx, -dz);
  runner.body.pitch = Math.max(-1.45, Math.min(1.45, Math.atan2(dy, Math.hypot(dx, dz))));
}

// Test helper: plant the bomb at a site, starting a live round first
// if the match is not already running.
function plantAtSite(site) {
  if (M.phase === 'menu' || M.phase === 'matchEnd') beginMatch();
  if (M.phase === 'buy' || M.phase === 'roundEnd') beginLive();
  if (M.phase !== 'live') return;
  doPlant(site);
}

// Bot events, drained once a frame: hits on the player, kills, plants,
// and defuses. A kill by the player pays $300.
function drainSquadEvents() {
  for (const event of squad.takeEvents()) {
    if (event.kind === 'playerHit') {
      applyPlayerDamage(event.amount);
    } else if (event.kind === 'botDown') {
      if (event.killer === 'player') {
        M.cash += 300;
        overlay.addKill('You', event.bot.name, 'atk');
      } else {
        overlay.addKill(event.killer.name, event.bot.name, event.killer.team);
      }
    } else if (event.kind === 'planted') {
      doPlant(event.site);
    } else if (event.kind === 'defused') {
      M.bomb.state = 'defused';
      closeRound('def', 'defused');
    } else if (event.kind === 'shotFired') {
      const d = Math.hypot(event.bot.pos.x - runner.body.position.x, event.bot.pos.z - runner.body.position.z);
      if (d < 25) sound.enemyShot();
    }
  }
}

// The HUD, pushed every frame. The overlay ignores values that did not
// change, so this is cheap.
function syncHud() {
  overlay.setAmmo(arsenal.state.mag, arsenal.state.reserve);
  overlay.setWeaponName(arsenal.spec().label);
  overlay.setMoney(M.cash);
  overlay.setHealth(M.health, M.armor);
  overlay.setTimer(M.bomb.state === 'planted' ? M.bomb.timer : M.phaseTime);
  overlay.setScore(M.score.atk, M.score.def);
  if (M.bomb.state === 'planted') {
    overlay.setBombStatus(`BOMB PLANTED — SITE ${M.bomb.site} — ${Math.ceil(M.bomb.timer)}s`, true);
  } else if (M.bomb.state === 'exploded') {
    overlay.setBombStatus('BOMB DETONATED', true);
  } else if (M.bomb.state === 'defused') {
    overlay.setBombStatus('BOMB DEFUSED', false);
  } else {
    overlay.setBombStatus('PLANT THE BOMB AT SITE A OR B', false);
  }
  let defuser = null;
  for (const bot of squad.bots) {
    if (bot.alive && bot.mode === 'defuse') { defuser = bot; break; }
  }
  if (defuser) overlay.showProgress('Defusing the bomb', Math.min(1, defuser.defuseT / 12));
  else if (M.bomb.state !== 'planted' || plantT === 0) overlay.hideProgress();
}
// The camera follows the player's body, or a fixed shot pose.
function syncCamera() {
  if (fixedCam) {
    camera.position.copy(fixedCam.pos);
    camera.lookAt(fixedCam.look);
  } else {
    camera.position.set(runner.body.position.x, runner.body.position.y + runner.body.eyeHeight, runner.body.position.z);
    camera.rotation.y = runner.body.yaw;
    camera.rotation.x = runner.body.pitch;
  }
  const want = isScoping() ? SCOPE_FOV : BASE_FOV;
  if (camera.fov !== want) {
    camera.fov = want;
    camera.updateProjectionMatrix();
  }
  overlay.setScope(isScoping());
}

// One live-phase step: the player, the bots, the bomb, and the checks
// that end the round.
function liveStep(dt) {
  if (playerAlive) {
    const look = controls.drainLook();
    runner.look(look.x, look.y);
    runner.update(dt, controls.state.keys);
    if (controls.state.firing) tryFire();
    plantTick(dt);
  }
  arsenal.update(dt);
  throwables.update(dt);
  squad.update(dt, {
    phase: M.phase,
    playerPos: runner.body.position,
    playerVel: runner.body.velocity,
    playerAlive,
    planted: M.bomb.state === 'planted',
    site: M.bomb.site,
  });
  drainSquadEvents();
  if (M.bomb.state === 'planted') {
    M.bomb.timer -= dt;
    const whole = Math.ceil(M.bomb.timer);
    if (M.bomb.timer <= 10 && whole !== lastBeepSecond) { lastBeepSecond = whole; sound.bombBeep(); }
    if (M.bomb.timer <= 0) {
      M.bomb.state = 'exploded';
      sound.explosion();
      closeRound('atk', 'bomb');
    }
  } else {
    M.phaseTime -= dt;
    if (M.phaseTime <= 0) closeRound('def', 'timeout');
  }
  if (M.phase === 'live') {
    const atkGone = !playerAlive && squad.aliveCount('atk') === 0;
    const defGone = squad.aliveCount('def') === 0;
    if (defGone) closeRound('atk', 'elimination');
    else if (atkGone && M.bomb.state !== 'planted') closeRound('def', 'elimination');
  }
}
// One simulation step. The render loop calls it with real time; the
// tests call it in fixed slices through advance().
function update(dt) {
  dt = Math.min(dt, 0.05);
  if (M.phase === 'buy') {
    M.phaseTime -= dt;
    if (M.phaseTime <= 0) beginLive();
  } else if (M.phase === 'live') {
    liveStep(dt);
  } else if (M.phase === 'roundEnd') {
    M.phaseTime -= dt;
    if (M.phaseTime <= 0) {
      if (M.score.atk >= WIN_SCORE || M.score.def >= WIN_SCORE) {
        closeMatch(M.score.atk >= WIN_SCORE ? 'atk' : 'def');
      } else {
        beginRound();
      }
    }
  }
  arsenal.state.grenades = M.loadout.grenades;
  M.alive = (playerAlive ? 1 : 0) + squad.aliveCount('atk');
  syncCamera();
  syncHud();
}

// Test helper: step the simulation forward by a number of seconds in
// fixed slices, without rendering.
function advance(seconds) {
  const step = 1 / 60;
  let left = seconds;
  while (left > 0) {
    const dt = Math.min(step, left);
    update(dt);
    left -= dt;
  }
}
// The three deterministic screenshot scenes (?shot=start|play|end).
function setupShot(kind) {
  if (kind === 'start') {
    fixedCam = { pos: new THREE.Vector3(15, 8.5, 15), look: new THREE.Vector3(-6, 0.5, -8) };
    overlay.showPanel('start');
  } else if (kind === 'play') {
    beginMatch();
    beginLive();
    overlay.hidePanel();
    advance(10);
  } else if (kind === 'end') {
    beginMatch();
    M.score.atk = 7; M.score.def = 5;
    beginRound();
    beginLive();
    squad.killAll('def', 'player');
    let guard = 0;
    while (M.phase !== 'matchEnd' && guard < 30) { advance(1); guard += 1; }
  }
  renderer.render(scene, camera);
  window.__shotReady = true;
}

// The debug handle the automated tests use. Every member is the live
// object, so a test that writes M.cash writes the game's own state.
window.__emberline = {
  M, squad, runner, camera, advance,
  startLive: beginLive, plantAtSite, lookAt, scopeState,
  arsenal, throwables, controls,
};

if (shotKind) setupShot(shotKind);
else overlay.showPanel('start');

// The render loop: step, then draw. The menu scene idles behind the
// panel; the match runs in real time.
let lastNow = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastNow) / 1000);
  lastNow = now;
  update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
