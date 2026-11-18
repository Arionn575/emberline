// The arsenal: one table owns every gun's numbers, so the buy menu, the
// HUD and the gun all read the same stats. Four guns plus a grenade. Each
// gun has a box-built view model, a magazine, a reload, and spread that
// punishes firing on the move. The sniper zooms 2.4x on right mouse.
// The grenade is a small physics object: it arcs, bounces, then bursts
// after a 1.5 s fuse, hurting anything within 5 m that it can see.
import * as THREE from 'three';
import { COLORS } from './colors.js';

export const GUNS = {
  pistol: { label: 'P9 Sidearm', price: 0, mag: 12, reserve: 48, gap: 0.18, reload: 1.2, damage: 20, head: 60, still: 0.004, moving: 0.03, auto: false, zoom: 1 },
  rifle: { label: 'AR-7 Carbine', price: 2700, mag: 30, reserve: 90, gap: 0.096, reload: 1.9, damage: 34, head: 100, still: 0.0022, moving: 0.028, auto: true, zoom: 1 },
  smg: { label: 'VK-9 Striker', price: 1500, mag: 25, reserve: 100, gap: 0.06, reload: 1.6, damage: 25, head: 75, still: 0.006, moving: 0.04, auto: true, zoom: 1 },
  sniper: { label: 'LR-50 Longshot', price: 4750, mag: 5, reserve: 15, gap: 1.1, reload: 2.8, damage: 90, head: 150, still: 0.0005, moving: 0.05, auto: false, zoom: 2.4 },
};
export const GRENADE_COST = 300;
export const ARMOR_COST = 650;
export const GRENADE_RADIUS = 5;
export const GRENADE_MAX_DAMAGE = 90;
export const GRENADE_FUSE = 1.5;

export function makeArsenal(camera) {
  const gripMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.timber), roughness: 0.7, metalness: 0.2 });
  const steelMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.paper), roughness: 0.5, metalness: 0.35 });
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.dusk), roughness: 0.6, metalness: 0.2 });

  function piece(w, h, d, x, y, z, mat) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    return mesh;
  }

  // Each view model is a few boxes bolted together; the sniper gets a long
  // barrel and a scope tube so it reads as a long gun at a glance.
  function buildModel(id) {
    const model = new THREE.Group();
    if (id === 'pistol') {
      model.add(piece(0.07, 0.1, 0.3, 0, 0, -0.12, steelMat));
      model.add(piece(0.06, 0.045, 0.2, 0, 0.07, -0.1, darkMat));
      model.add(piece(0.06, 0.14, 0.09, 0, -0.1, 0.05, gripMat));
    } else if (id === 'rifle') {
      model.add(piece(0.09, 0.1, 0.42, 0, 0, 0, steelMat));
      model.add(piece(0.045, 0.045, 0.4, 0, 0.025, -0.38, gripMat));
      model.add(piece(0.075, 0.08, 0.22, 0, -0.02, 0.3, gripMat));
    } else if (id === 'smg') {
      model.add(piece(0.08, 0.09, 0.34, 0, 0, 0, steelMat));
      model.add(piece(0.04, 0.04, 0.34, 0, 0.02, -0.32, darkMat));
      model.add(piece(0.05, 0.16, 0.06, 0, -0.1, -0.02, gripMat));
    } else {
      model.add(piece(0.07, 0.09, 0.5, 0, 0, -0.05, steelMat));
      model.add(piece(0.03, 0.03, 0.62, 0, 0.03, -0.45, darkMat));
      model.add(piece(0.06, 0.07, 0.16, 0, 0.09, -0.05, darkMat));
      model.add(piece(0.07, 0.1, 0.2, 0, -0.02, 0.28, gripMat));
    }
    model.position.set(0.24, -0.2, -0.42);
    model.visible = false;
    camera.add(model);
    return model;
  }

  const models = {};
  for (const id of Object.keys(GUNS)) models[id] = buildModel(id);

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ember), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.24, -0.18, -0.95);
  flash.visible = false;
  camera.add(flash);

  const flashLight = new THREE.PointLight(new THREE.Color(COLORS.ember), 0, 5);
  flashLight.position.set(0.24, -0.16, -0.6);
  camera.add(flashLight);

  const pouches = {};
  for (const [id, def] of Object.entries(GUNS)) pouches[id] = { mag: def.mag, reserve: def.reserve };
  const state = { id: 'pistol', mag: GUNS.pistol.mag, reserve: GUNS.pistol.reserve, grenades: 0, cooldown: 0, reloadLeft: 0, flash: 0, kick: 0 };
  models.pistol.visible = true;

  function syncAmmo() {
    state.mag = pouches[state.id].mag;
    state.reserve = pouches[state.id].reserve;
  }

  function update(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.kick += (0 - state.kick) * Math.min(1, dt * 14);
    const model = models[state.id];
    model.position.z = -0.42 + state.kick;
    model.rotation.x = state.kick * 2.2;
    flash.visible = state.flash > 0;
    flash.rotation.z = state.flash * 30;
    flashLight.intensity = state.flash > 0 ? 18 : 0;
    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      model.rotation.x = -0.55 * Math.min(1, (GUNS[state.id].reload - state.reloadLeft) * 2);
      if (state.reloadLeft === 0) {
        const def = GUNS[state.id];
        const take = Math.min(def.mag - pouches[state.id].mag, pouches[state.id].reserve);
        pouches[state.id].mag += take;
        pouches[state.id].reserve -= take;
        syncAmmo();
      }
    }
  }

  return {
    state,
    update,
    spec() {
      return GUNS[state.id];
    },
    canFire() {
      return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    fire() {
      state.cooldown = GUNS[state.id].gap;
      state.flash = 0.06;
      state.kick = 0.055;
    },
    spendRound() {
      if (state.mag <= 0) return false;
      pouches[state.id].mag -= 1;
      state.mag -= 1;
      return true;
    },
    reload() {
      const def = GUNS[state.id];
      if (state.reloadLeft > 0 || pouches[state.id].mag === def.mag || pouches[state.id].reserve === 0) return;
      state.reloadLeft = def.reload;
    },
    spreadFor(speed) {
      const def = GUNS[state.id];
      return def.still + Math.min(1, speed / 5.2) * def.moving;
    },
    equip(id) {
      if (!GUNS[id] || id === state.id || state.reloadLeft > 0) return false;
      models[state.id].visible = false;
      state.id = id;
      models[id].visible = true;
      state.cooldown = 0.25;
      syncAmmo();
      return true;
    },
    stock(id) {
      if (!GUNS[id]) return false;
      pouches[id] = { mag: GUNS[id].mag, reserve: GUNS[id].reserve };
      return true;
    },
    reset() {
      for (const [id, def] of Object.entries(GUNS)) pouches[id] = { mag: def.mag, reserve: def.reserve };
      state.id = 'pistol';
      for (const [id, model] of Object.entries(models)) model.visible = id === 'pistol';
      state.grenades = 0;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.kick = 0;
      syncAmmo();
    },
  };
}

// Thrown grenades: they arc under gravity, bounce off the floor and walls,
// then burst. A burst hurts anything within GRENADE_RADIUS that the blast
// can see — walls block it — with damage falling off to a 10-point minimum.
export function makeThrowables(scene, colliders, walls) {
  const raycaster = new THREE.Raycaster();
  const from = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const live = [];
  const bodyGeo = new THREE.SphereGeometry(0.09, 10, 8);
  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.dusk), roughness: 0.4, metalness: 0.6 });
  const blastGeo = new THREE.SphereGeometry(1, 16, 12);
  const blastMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ember), transparent: true, opacity: 0, depthWrite: false });
  const blastMesh = new THREE.Mesh(blastGeo, blastMat);
  blastMesh.visible = false;
  scene.add(blastMesh);
  let blastLeft = 0;

  function burst(grenade) {
    const pos = grenade.pos;
    blastMesh.position.copy(pos);
    blastMesh.visible = true;
    blastLeft = 0.25;
    const hits = [];
    const check = (point, isPlayer, target) => {
      const dist = pos.distanceTo(point);
      if (dist > GRENADE_RADIUS) return;
      from.copy(pos);
      dir.copy(point).sub(pos).normalize();
      raycaster.set(from, dir);
      raycaster.far = dist;
      if (raycaster.intersectObjects(walls, false).length) return;
      hits.push({ target, isPlayer, amount: Math.max(10, Math.round(GRENADE_MAX_DAMAGE * (1 - dist / GRENADE_RADIUS))) });
    };
    return { pos: pos.clone(), check, hits };
  }

  return {
    liveCount() {
      return live.length;
    },
    throwFrom(origin, direction) {
      const mesh = new THREE.Mesh(bodyGeo, bodyMat);
      mesh.castShadow = true;
      scene.add(mesh);
      live.push({
        mesh,
        pos: origin.clone(),
        vel: direction.clone().multiplyScalar(14).add(new THREE.Vector3(0, 3.5, 0)),
        fuse: GRENADE_FUSE,
      });
    },
    update(dt, onBurst) {
      if (blastLeft > 0) {
        blastLeft -= dt;
        const k = Math.max(0, blastLeft / 0.25);
        blastMesh.scale.setScalar(1 + (1 - k) * 4);
        blastMat.opacity = k * 0.7;
        if (blastLeft <= 0) blastMesh.visible = false;
      }
      for (let i = live.length - 1; i >= 0; i -= 1) {
        const g = live[i];
        g.fuse -= dt;
        g.vel.y -= 12 * dt;
        g.pos.addScaledVector(g.vel, dt);
        if (g.pos.y < 0.09) {
          g.pos.y = 0.09;
          g.vel.y = Math.abs(g.vel.y) * 0.4;
          g.vel.x *= 0.7;
          g.vel.z *= 0.7;
        }
        for (const box of colliders) {
          if (g.pos.x > box.min.x - 0.09 && g.pos.x < box.max.x + 0.09
            && g.pos.y > box.min.y - 0.09 && g.pos.y < box.max.y + 0.09
            && g.pos.z > box.min.z - 0.09 && g.pos.z < box.max.z + 0.09) {
            const dxMin = g.pos.x - (box.min.x - 0.09);
            const dxMax = (box.max.x + 0.09) - g.pos.x;
            const dzMin = g.pos.z - (box.min.z - 0.09);
            const dzMax = (box.max.z + 0.09) - g.pos.z;
            const m = Math.min(dxMin, dxMax, dzMin, dzMax);
            if (m === dxMin || m === dxMax) {
              g.pos.x = m === dxMin ? box.min.x - 0.09 : box.max.x + 0.09;
              g.vel.x *= -0.4;
            } else {
              g.pos.z = m === dzMin ? box.min.z - 0.09 : box.max.z + 0.09;
              g.vel.z *= -0.4;
            }
          }
        }
        g.mesh.position.copy(g.pos);
        if (g.fuse <= 0) {
          const blast = burst(g);
          scene.remove(g.mesh);
          live.splice(i, 1);
          onBurst(blast);
        }
      }
    },
    clear() {
      for (const g of live) scene.remove(g.mesh);
      live.length = 0;
      blastMesh.visible = false;
      blastLeft = 0;
    },
  };
}
