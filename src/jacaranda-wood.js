import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Reuse the scalar-field scratch buffers for all seven trees. Only the tightly
// packed, finished vertex arrays belong to an individual tree.
let scratch;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const radiusAt = (path, u) => THREE.MathUtils.lerp(path.r0, path.r1, Math.pow(u, .8));

// Call once after all trees have been built; the final meshes have no reference
// to these generation buffers and remain completely independent.
export function releaseJacarandaWoodScratch() {
  scratch?.surface.geometry.dispose();
  scratch?.surface.material.dispose();
  scratch = undefined;
}

function getScratch(resolution) {
  if (!scratch || scratch.resolution !== resolution) {
    scratch?.surface.geometry.dispose();
    scratch?.surface.material.dispose();
    scratch = {
      resolution,
      surface: new MarchingCubes(resolution, new THREE.MeshBasicMaterial(), false, false, 120000),
      branchField: new Float32Array(resolution ** 3)
    };
  }
  return scratch;
}

// A fine branch tip is embedded inside the implicit surface before emerging.
// Its first ring is deliberately smaller, so no cut end or joining ring shows.
function fineTip(path, start) {
  const curve = path.curve;
  const length = curve.getLength() * (1 - start);
  const totalLength = curve.getLength();
  const count = Math.max(6, Math.ceil(length * 15));
  const frames = curve.computeFrenetFrames(Math.max(32, count * 2), false);
  const positions = [], uvs = [], indices = [], sides = 10;
  for (let i = 0; i <= count; i++) {
    const t = i / count, u = start + (1 - start) * t;
    const p = curve.getPointAt(u);
    const frame = Math.round(u * (frames.normals.length - 1));
    const embed = start > 0 ? THREE.MathUtils.smoothstep(t, 0, Math.min(1, .18 / Math.max(length, .01))) : 1;
    const radius = radiusAt(path, u) * THREE.MathUtils.lerp(.82, 1, embed);
    for (let j = 0; j < sides; j++) {
      const a = j * Math.PI * 2 / sides;
      const q = p.clone().addScaledVector(frames.normals[frame], Math.cos(a) * radius)
        .addScaledVector(frames.binormals[frame], Math.sin(a) * radius);
      positions.push(q.x, q.y, q.z);
      uvs.push(j / sides, u * totalLength * 1.25);
    }
  }
  for (let i = 0; i < count; i++) for (let j = 0; j < sides; j++) {
    const a = i * sides + j, b = i * sides + (j + 1) % sides;
    indices.push(a, b, a + sides, b, b + sides, a + sides);
  }
  const cap = positions.length / 3;
  positions.push(...curve.getPointAt(start).toArray(), ...curve.getPointAt(1).toArray());
  uvs.push(0, start * totalLength * 1.25, 0, totalLength * 1.25);
  for (let j = 0; j < sides; j++) {
    indices.push(cap, (j + 1) % sides, j);
    indices.push(cap + 1, count * sides + j, count * sides + (j + 1) % sides);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const result = geometry.toNonIndexed();
  geometry.dispose();
  return result;
}

/**
 * Fuse the trunk, roots and main scaffold limbs into one continuous surface.
 *
 * @param {{points: THREE.Vector3[], r0: number, r1: number}[]} paths
 * @param {{resolution?: number, minimumRadius?: number, blend?: number}} options
 * @returns {THREE.BufferGeometry}
 */
export function createJacarandaWoodGeometry(paths, options = {}) {
  if (!paths.length) return new THREE.BufferGeometry();
  const resolution = options.resolution ?? 128;
  const minimumRadius = options.minimumRadius ?? .055;
  const blend = options.blend ?? .065;
  const band = Math.max(.18, blend * 2.5);
  const prepared = paths.map(path => ({ ...path, curve: new THREE.CatmullRomCurve3(path.points) }));
  const bounds = new THREE.Box3();
  const sections = [];
  for (const path of prepared) {
    const samples = Math.max(12, Math.ceil(path.curve.getLength() / .065));
    const nodes = [];
    for (let i = 0; i <= samples; i++) {
      const u = i / samples, radius = radiusAt(path, u);
      if (radius < minimumRadius) continue;
      const p = path.curve.getPointAt(u);
      nodes.push({ p, radius });
      bounds.expandByPoint(p.clone().addScalar(radius));
      bounds.expandByPoint(p.clone().addScalar(-radius));
    }
    if (nodes.length > 1) sections.push(nodes);
  }
  if (bounds.isEmpty()) {
    const parts = prepared.map(path => fineTip(path, 0));
    const geometry = mergeGeometries(parts);
    parts.forEach(part => part.dispose());
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  // MarchingCubes skips the outer two voxel rings. Leave an empty halo around
  // the wood, including the roots, so every boundary is closed.
  const initialSize = bounds.getSize(V());
  bounds.expandByScalar(Math.max(.15, Math.max(...initialSize.toArray()) * 4 / resolution));
  const size = bounds.getSize(V()), origin = bounds.min;
  const step = size.clone().divideScalar(resolution);
  const { surface, branchField } = getScratch(resolution);
  const field = surface.field;
  field.fill(-band);
  surface.normal_cache.fill(0);
  surface.isolation = 0;
  const n2 = resolution * resolution;
  const ix = value => THREE.MathUtils.clamp(value, 0, resolution - 1);

  for (const nodes of sections) {
    branchField.fill(-band);
    const active = new THREE.Box3();
    // Rasterize only each capsule's narrow neighbourhood. A hard union within
    // one centreline avoids the bead-like swelling of repeated metaballs.
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1], b = nodes[i];
      const extent = Math.max(a.radius, b.radius) + band;
      const x0 = ix(Math.floor((Math.min(a.p.x, b.p.x) - extent - origin.x) / step.x));
      const x1 = ix(Math.ceil((Math.max(a.p.x, b.p.x) + extent - origin.x) / step.x));
      const y0 = ix(Math.floor((Math.min(a.p.y, b.p.y) - extent - origin.y) / step.y));
      const y1 = ix(Math.ceil((Math.max(a.p.y, b.p.y) + extent - origin.y) / step.y));
      const z0 = ix(Math.floor((Math.min(a.p.z, b.p.z) - extent - origin.z) / step.z));
      const z1 = ix(Math.ceil((Math.max(a.p.z, b.p.z) + extent - origin.z) / step.z));
      active.expandByPoint(V(x0, y0, z0));
      active.expandByPoint(V(x1, y1, z1));
      const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y, dz = b.p.z - a.p.z;
      const inverseLength2 = 1 / Math.max(1e-12, dx * dx + dy * dy + dz * dz);
      for (let z = z0; z <= z1; z++) {
        const pz = origin.z + z * step.z - a.p.z;
        for (let y = y0; y <= y1; y++) {
          const py = origin.y + y * step.y - a.p.y, row = z * n2 + y * resolution;
          for (let x = x0; x <= x1; x++) {
            const px = origin.x + x * step.x - a.p.x;
            const t = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) * inverseLength2));
            const qx = px - dx * t, qy = py - dy * t, qz = pz - dz * t;
            const value = a.radius + (b.radius - a.radius) * t - Math.sqrt(qx * qx + qy * qy + qz * qz);
            const index = row + x;
            if (value > branchField[index]) branchField[index] = value;
          }
        }
      }
    }
    // Blend only distinct woody limbs. Their crotches become one rounded
    // surface rather than overlapping capped tubes with visible collar seams.
    for (let z = active.min.z; z <= active.max.z; z++) for (let y = active.min.y; y <= active.max.y; y++) {
      const row = z * n2 + y * resolution;
      for (let x = active.min.x; x <= active.max.x; x++) {
        const index = row + x, a = field[index], b = branchField[index];
        if (b <= -band) continue;
        const h = Math.max(0, 1 - Math.abs(a - b) / blend);
        field[index] = Math.max(a, b) + blend * .25 * h * h;
      }
    }
  }

  surface.update();
  const geometry = new THREE.BufferGeometry();
  const positions = surface.positionArray.slice(0, surface.count * 3);
  const uvs = new Float32Array(surface.count * 2);
  for (let i = 0; i < surface.count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    uvs[i * 2] = Math.atan2(z, x) / (Math.PI * 2) + .5;
    uvs[i * 2 + 1] = y * 1.25;
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(surface.normalArray.slice(0, surface.count * 3), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.scale(size.x / 2, size.y / 2, size.z / 2);
  geometry.translate(origin.x + size.x / 2, origin.y + size.y / 2, origin.z + size.z / 2);
  const pieces = [geometry];
  for (const path of prepared) {
    if (Math.min(path.r0, path.r1) >= minimumRadius) continue;
    const transitionRadius = minimumRadius + Math.max(step.x, step.y, step.z) * .75;
    const fraction = (path.r0 - transitionRadius) / (path.r0 - path.r1);
    const start = path.r0 > path.r1 ? Math.pow(THREE.MathUtils.clamp(fraction, 0, 1), 1 / .8) : 0;
    pieces.push(fineTip(path, start));
  }
  const result = pieces.length === 1 ? geometry : mergeGeometries(pieces);
  if (pieces.length > 1) pieces.forEach(piece => piece.dispose());
  result.computeBoundingBox();
  result.computeBoundingSphere();
  result.userData.continuousWood = true;
  result.userData.voxelResolution = resolution;
  return result;
}
