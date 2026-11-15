import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createJacarandaBlossomGeometry } from '../src/jacaranda-blossom.js';
import { createJacarandaWoodGeometry, releaseJacarandaWoodScratch } from '../src/jacaranda-wood.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const geometries = [];
const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const ray = new THREE.Raycaster();
const started = performance.now();

function finiteGeometry(geometry, label) {
  for (const name of ['position', 'normal', 'uv'].filter(name => geometry.attributes[name])) {
    assert.ok(geometry.attributes[name].array.every(Number.isFinite), `${label}: finite ${name}`);
  }
  assert.ok(Number.isFinite(geometry.boundingSphere.radius), `${label}: finite bounding sphere`);
}

function intersections(geometry, origin, direction) {
  ray.set(origin, direction);
  const hits = ray.intersectObject(new THREE.Mesh(geometry, material));
  // A ray through a shared triangle edge can report the same surface twice.
  return hits.filter((hit, i) => i === 0 || Math.abs(hit.distance - hits[i - 1].distance) > 1e-5);
}

function closedIndexedSurface(geometry) {
  const edges = new Map(), indices = geometry.index.array;
  for (let i = 0; i < indices.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = indices[i + j], b = indices[i + (j + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const edge = edges.get(key) ?? { uses: 0, direction: 0 };
      edge.uses++;
      edge.direction += a < b ? 1 : -1;
      edges.set(key, edge);
    }
  }
  assert.ok([...edges.values()].every(edge => edge.uses === 2 && edge.direction === 0),
    'flower has two consistently wound faces at every edge, including throat, lip and base');
}

function connectedSurfaceCount(geometry) {
  const position = geometry.attributes.position, vertices = new Map(), parents = [];
  const vertex = i => {
    const key = [position.getX(i), position.getY(i), position.getZ(i)]
      .map(value => Math.round(value * 1e5)).join(',');
    if (!vertices.has(key)) {
      const index = parents.length;
      vertices.set(key, index);
      parents.push(index);
    }
    return vertices.get(key);
  };
  const root = i => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };
  for (let i = 0; i < position.count; i += 3) {
    const a = vertex(i), b = vertex(i + 1), c = vertex(i + 2);
    parents[root(b)] = root(a);
    parents[root(c)] = root(a);
  }
  return new Set(parents.map((_, i) => root(i))).size;
}

try {
  const flower = createJacarandaBlossomGeometry();
  geometries.push(flower);
  finiteGeometry(flower, 'flower');
  closedIndexedSurface(flower);
  assert.ok(flower.index.count / 3 <= 140, 'flower stays within the large instanced-crown triangle budget');
  const flowerHits = intersections(flower, V(.2, .08, .001), V(-1, 0, 0));
  assert.equal(flowerHits.length, 4, 'a flower cross-section has outer wall, hollow mouth and opposite wall');
  // These expected directions come from physical outside/inside space rather
  // than comparing a triangle with normals calculated from that triangle.
  assert.ok(flowerHits[0].face.normal.x > .6 && flowerHits[3].face.normal.x < -.6,
    'flower outside faces point away from the centre');
  assert.ok(flowerHits[1].face.normal.x < -.6 && flowerHits[2].face.normal.x > .6,
    'flower throat faces point into the mouth');
  const flowerBottom = intersections(flower, V(-.004, -.1, .001), V(0, 1, 0));
  assert.ok(flowerBottom[0].face.normal.y < -.9, 'flower closed base faces downward');

  const fork = createJacarandaWoodGeometry([
    { points: [V(), V(0, 1, 0), V(0, 2, 0)], r0: .23, r1: .14 },
    ...[-1, 1].map(sign => ({
      points: [V(0, 1.65, 0), V(sign * .3, 2.2, .03), V(sign * .9, 3.3, .08)],
      r0: .16, r1: .075
    }))
  ], { resolution: 80 });
  geometries.push(fork);
  finiteGeometry(fork, 'fused wood');
  assert.equal(connectedSurfaceCount(fork), 1, 'trunk and both fork limbs form one connected surface');
  assert.ok(fork.boundingBox.min.y > -.25 && fork.boundingBox.min.y < -.20
    && fork.boundingBox.max.y > 3.34 && fork.boundingBox.max.y < 3.40
    && fork.boundingBox.min.x > -1.02 && fork.boundingBox.max.x < 1.02,
  'fused branches retain their intended dimensions without oversized joint blobs');
  const trunkHits = intersections(fork, V(1, .7, .001), V(-1, 0, 0));
  assert.equal(trunkHits.length, 2, 'the straight trunk has one outside shell');
  assert.ok(trunkHits[0].face.normal.x > .9 && trunkHits[1].face.normal.x < -.9,
    'trunk faces point radially outward');
  const rootHits = intersections(fork, V(.001, -1, .001), V(0, 1, 0));
  assert.ok(rootHits[0].face.normal.y < -.9, 'wood root surface faces downward');
  for (const x of [-.04, 0, .04]) {
    const crotch = intersections(fork, V(x, 1.8, 1), V(0, 0, -1));
    assert.equal(crotch.length, 2, 'fused crotch has no internal end caps or stacked intersecting shells');
  }

  const tip = createJacarandaWoodGeometry([
    { points: [V(), V(0, 1, 0), V(0, 2, 0)], r0: .18, r1: .009 }
  ], { resolution: 80 });
  geometries.push(tip);
  finiteGeometry(tip, 'thin-ended wood');
  assert.ok(Math.abs(tip.boundingBox.max.y - 2) < .002, 'sub-voxel branch tip reaches its real endpoint');
  let previousRadius = Infinity;
  for (let y = .95; y <= 1.96; y += .04) {
    const hits = intersections(tip, V(.5, y, .001), V(-1, 0, 0));
    assert.ok(hits.length >= 2, `fine tip remains attached through the voxel-to-tube transition at y=${y}`);
    const radius = hits[0].point.x;
    const expected = THREE.MathUtils.lerp(.18, .009, Math.pow(y / 2, .8));
    assert.ok(radius > 0 && Math.abs(radius - expected) < .012,
      'thin tip preserves its tapered cross-section throughout the transition');
    assert.ok(radius <= previousRadius + .003, 'tip transition has no swollen collar or abrupt radial jump');
    assert.ok(hits[0].face.normal.x > .8 && hits.at(-1).face.normal.x < -.8,
      'fine tip faces point radially outward');
    previousRadius = radius;
  }
  console.log(JSON.stringify({
    ok: true,
    flowerTriangles: flower.index.count / 3,
    woodTriangles: fork.attributes.position.count / 3,
    durationMs: Math.round(performance.now() - started)
  }, null, 2));
} finally {
  geometries.forEach(geometry => geometry.dispose());
  material.dispose();
  releaseJacarandaWoodScratch();
}
