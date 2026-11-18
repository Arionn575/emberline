// The arena: a 48 x 36 m desert-industrial yard. Attackers spawn south,
// defenders north. Two bomb sites (A west warehouse, B east crate yard),
// three north-south lanes joined by a south connector and a top connector.
// The whole yard is one data table of boxes: [width, height, depth, x, y, z, colour].
// Every box is both a movement collider and a surface bullets stop on.
import * as THREE from 'three';
import { COLORS } from './colors.js';

export const BOMB_SITES = {
  A: { id: 'A', x: -18, z: -9, radius: 5 },
  B: { id: 'B', x: 18, z: -9, radius: 5 },
};

export const SPAWN_POINTS = {
  // Player spawns first in each list.
  atk: [[0, 15], [-4, 15], [4, 15], [-2, 16.5], [2, 16.5]],
  def: [[-4, -14], [4, -14], [-2, -15.5], [2, -15.5], [0, -13]],
};

// Waypoint chains bots walk: attackers push a lane toward a site, defenders
// walk to a hold point and watch a lane.
export const PATHS = {
  // Attackers push a lane toward a site. The A and B lanes enter their
  // site around the EAST end of the site's south wall (the wall runs
  // x -24..-12 at z=-2, so the lane turns in at x=-10, clear of it) — a
  // route that runs straight at the wall face would slide along it for
  // metres. The first lane waypoint sits north of the lane crate at
  // (±10, 10): a route straight at it would wedge on the crate's face
  // with almost no sideways motion to slide around it. The mid lane
  // crosses to a site at z=-5.5, clear of the lane crates at z=-4.
  pushA: [[-2, 12], [-12, 11.5], [-14, 4], [-10, -4], [-18, -9]],
  pushB: [[2, 12], [12, 11.5], [14, 4], [10, -4], [18, -9]],
  pushMid: [[0, 10], [0, 4], [4.5, 1], [4.5, -3], [0, -6]],
  midToA: [[-4, -4], [-10, -5.5], [-18, -8]],
  midToB: [[4, -4], [10, -5.5], [18, -8]],
  watchA: [[-19, -13], [-15, -12], [-20, -7], [-12, -8]],
  watchB: [[19, -13], [15, -12], [20, -7], [12, -8]],
  watchMid: [[-3, -13], [3, -13], [0, -15]],
};

// [w, h, d, x, y, z, colour] — the floor, four outer walls, lane dividers,
// site walls, crates, pillars and connector cover. Gaps are deliberate:
// the lane dividers leave a top-connector gap at z in [-6, -2], each site
// wall leaves one entrance where its lane comes in, and the mid wall leaves
// a gap on the east side, so no lane has a spawn-to-spawn sightline.
const BOXES = [
  [48.4, 0.4, 36.4, 0, -0.2, 0, 'dirt'],
  [0.4, 5, 36.4, -24.2, 2.5, 0, 'stone'],
  [0.4, 5, 36.4, 24.2, 2.5, 0, 'stone'],
  [48.4, 5, 0.4, 0, 2.5, -18.2, 'stone'],
  [48.4, 5, 0.4, 0, 2.5, 18.2, 'stone'],
  [0.4, 5, 12, -7, 2.5, -12, 'stone'],
  [0.4, 5, 8, -7, 2.5, 2, 'stone'],
  [0.4, 5, 12, 7, 2.5, -12, 'stone'],
  [0.4, 5, 8, 7, 2.5, 2, 'stone'],
  [12, 4, 0.4, -18, 2, -2, 'stone'],
  [12, 4, 0.4, 18, 2, -2, 'stone'],
  [6, 0.5, 4, -19, 0.25, -12, 'timber'],
  [1.6, 1.1, 1.6, -21, 0.55, -14, 'rust'],
  [1.2, 1.1, 1.2, -16, 0.55, -14, 'sand'],
  [2.4, 2.2, 1.2, -20, 1.1, -6, 'rust'],
  [1.2, 3.2, 1.2, -12, 1.6, -8, 'timber'],
  [1.6, 1.1, 1.6, 20, 0.55, -14, 'sand'],
  [1.2, 1.1, 1.2, 16, 0.55, -12, 'rust'],
  [2, 2.2, 1.2, 21, 1.1, -7, 'rust'],
  [1.6, 1.1, 1.6, 13, 0.55, -15, 'sand'],
  [1.2, 3.2, 1.2, 12, 1.6, -8, 'timber'],
  [6, 3, 0.4, -21, 1.5, 2, 'stone'],
  [6, 3, 0.4, 21, 1.5, 2, 'stone'],
  [2, 1.1, 1.2, -14, 0.55, 6, 'rust'],
  [2, 1.1, 1.2, 14, 0.55, 6, 'sand'],
  [1.2, 3.2, 1.2, -18, 1.6, -2, 'timber'],
  [1.2, 3.2, 1.2, 18, 1.6, -2, 'timber'],
  [1.2, 1.1, 1.2, -10, 0.55, -4, 'sand'],
  [1.2, 1.1, 1.2, 10, 0.55, -4, 'rust'],
  [1.2, 3.2, 1.2, 3.5, 1.6, -2, 'timber'],
  [1.6, 1.1, 1.6, -3, 0.55, 3, 'rust'],
  [8, 1.2, 0.4, 0, 0.6, -7, 'timber'],
  [9, 3.4, 0.4, -2.5, 1.7, 0, 'stone'],
  [2.4, 1.1, 1.2, 0, 0.55, 12, 'sand'],
  [1.6, 1.1, 1.6, -10, 0.55, 10, 'rust'],
  [1.6, 1.1, 1.6, 10, 0.55, 10, 'sand'],
];

function siteSignTexture(letter) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = COLORS.dusk;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = COLORS.ember;
  ctx.font = 'bold 190px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 128, 136);
  return new THREE.CanvasTexture(canvas);
}

export function buildArena(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const [name, hex] of Object.entries(COLORS)) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      roughness: name === 'ember' || name === 'paper' ? 0.55 : 0.92,
      metalness: 0.03,
    });
  }

  const colliders = [];
  const walls = [];

  for (const [w, h, d, x, y, z, colour] of BOXES) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials[colour]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(new THREE.Box3().setFromObject(mesh));
    walls.push(mesh);
  }

  // Amber pads mark the two bomb sites, with a big letter on the north wall.
  for (const site of Object.values(BOMB_SITES)) {
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(7, 0.06, 7),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.ember), roughness: 0.8 }),
    );
    pad.position.set(site.x, 0.03, site.z);
    pad.receiveShadow = true;
    group.add(pad);

    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 3),
      new THREE.MeshBasicMaterial({ map: siteSignTexture(site.id) }),
    );
    sign.position.set(site.x, 3.2, -17.9);
    group.add(sign);
  }

  // Dusk lighting: warm low sun from the west, cool fill from the east,
  // and a hemisphere wash so shadows never go black.
  const sky = new THREE.HemisphereLight(new THREE.Color(COLORS.sand), new THREE.Color(COLORS.dirt), 0.9);
  scene.add(sky);

  const sun = new THREE.DirectionalLight(new THREE.Color(COLORS.ember), 2.4);
  sun.position.set(-14, 16, 6);
  sun.target.position.set(0, 0, -3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -28;
  sun.shadow.camera.right = 28;
  sun.shadow.camera.top = 24;
  sun.shadow.camera.bottom = -24;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);

  const fill = new THREE.DirectionalLight(new THREE.Color(COLORS.vex), 0.5);
  fill.position.set(10, 9, 12);
  scene.add(fill);

  return { colliders, walls, group };
}
