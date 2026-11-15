import * as THREE from 'three';

// One reusable, closed jacaranda bell. A slender, gently curved tube opens into
// five rounded petal lobes with a recessed throat cavity. 32 vertices / 60
// triangles keep the same lip silhouette without motion-quality swaps.
export function createJacarandaBlossomGeometry() {
  const positions = [], colors = [], indices = [];
  const addVertex = (x, y, z, tone) => {
    const index = positions.length / 3;
    positions.push(x, y, z);
    // Neutral vertex shading lets the instance color supply the lilac once.
    colors.push(tone, tone, tone);
    return index;
  };
  const ring = (count, pointAt, tone) => Array.from({ length: count }, (_, i) => {
    const angle = i / count * Math.PI * 2;
    return addVertex(...pointAt(angle), tone);
  });
  // Slender, arched tubular bell: narrow calyx, curved tube, five rounded lobes.
  const base = ring(5, a => [-.004 + Math.cos(a) * .0065, 0, Math.sin(a) * .0065], .56);
  const midTube = ring(5, a => [-.001 + Math.cos(a) * .0125, .045, Math.sin(a) * .0125], .72);
  // Connect the tube directly to the detailed lip. The old intermediate ring
  // added 30 triangles per instance without changing the five-lobed outline.
  const outerRim = Array.from({ length: 15 }, (_, i) => {
    const angle = i / 15 * Math.PI * 2;
    const isNotch = i % 3 === 0;
    const radius = isNotch ? .0215 : .0345;
    const lipY = isNotch ? .108 : .116;
    return addVertex(.010 + Math.cos(angle) * radius, lipY, Math.sin(angle) * radius, isNotch ? .90 : .97);
  });
  const innerThroat = ring(5, a => [.004 + Math.cos(a) * .015, .098, Math.sin(a) * .015], .64);

  const bridge = (lower, upper, invert = false) => {
    const pushTri = (v0, v1, v2) => {
      if (invert) indices.push(v0, v2, v1);
      else indices.push(v0, v1, v2);
    };
    for (let j = 0; j < lower.length; j++) {
      const next = (j + 1) % lower.length;
      if (lower.length === upper.length) {
        pushTri(lower[j], upper[j], lower[next]);
        pushTri(lower[next], upper[j], upper[next]);
      } else {
        const a = j * 3, b = a + 1, c = a + 2, d = (a + 3) % upper.length;
        pushTri(lower[j], upper[a], upper[b]);
        pushTri(lower[j], upper[b], upper[c]);
        pushTri(lower[j], upper[c], lower[next]);
        pushTri(lower[next], upper[c], upper[d]);
      }
    }
  };
  bridge(base, midTube);
  bridge(midTube, outerRim);
  bridge(innerThroat, outerRim, true);

  const throat = addVertex(0, .042, 0, .40);
  const bottom = addVertex(-.004, 0, 0, .52);
  for (let j = 0; j < innerThroat.length; j++) indices.push(innerThroat[j], throat, innerThroat[(j + 1) % innerThroat.length]);
  for (let j = 0; j < base.length; j++) indices.push(bottom, base[j], base[(j + 1) % base.length]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = 'jacaranda-five-petal-trumpet';
  return geometry;
}
