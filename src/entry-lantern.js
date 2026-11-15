import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// A wall-mounted arm carries a short interlocking chain and a four-sided
// lantern. All dimensions are local to the mounting plate on the door jamb.
export function createEntryLantern(iron, lampGlass, id = 'entry') {
  const group = new THREE.Group();
  group.name = `${id}-hanging-lantern`;
  group.userData.hangingLantern = true;
  const parts = [], Vec = (x, y, z) => new THREE.Vector3(x, y, z);
  const depth = .42, centerY = -.35;
  function box(x, y, z, width, height, length) {
    parts.push(new THREE.BoxGeometry(width, height, length).translate(x, y, z));
  }
  function rod(a, b, radius) {
    const geometry = new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 8);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Vec(0, 1, 0), b.clone().sub(a).normalize()));
    geometry.translate(...a.clone().add(b).multiplyScalar(.5).toArray());
    parts.push(geometry);
  }
  box(0, 0, 0, .12, .23, .04);
  const arm = new THREE.CatmullRomCurve3([Vec(0, .06, .018), Vec(0, .17, .12), Vec(0, .19, .29), Vec(0, .18, depth)]);
  parts.push(new THREE.TubeGeometry(arm, 20, .018, 8, false));
  rod(Vec(0, -.06, .02), Vec(0, .183, .27), .012);
  // Alternating link planes make the attachment legible from front and side.
  for (let i = 0; i < 4; i++) {
    const link = new THREE.TorusGeometry(.030, .006, 6, 14);
    if (i % 2) link.rotateY(Math.PI / 2);
    link.translate(0, .147 - i * .044, depth);
    parts.push(link);
  }
  parts.push(new THREE.TorusGeometry(.024, .007, 6, 14).translate(0, -.040, depth));
  const cap = new THREE.ConeGeometry(.25, .10, 4);
  cap.rotateY(Math.PI / 4);
  cap.translate(0, -.112, depth);
  parts.push(cap);
  box(0, -.166, depth, .36, .028, .36);
  box(0, -.548, depth, .31, .035, .31);
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    rod(Vec(x * .125, -.53, depth + z * .125), Vec(x * .155, -.18, depth + z * .155), .012);
  }
  const frame = new THREE.Mesh(mergeGeometries(parts), iron);
  parts.forEach(part => part.dispose());
  frame.name = `${id}-lantern-frame`;
  frame.castShadow = true;
  frame.receiveShadow = true;
  group.add(frame);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(.25, .34, .25), lampGlass);
  glass.name = `${id}-lantern-glass`;
  glass.position.set(0, centerY, depth);
  glass.castShadow = false;
  glass.receiveShadow = true;
  group.add(glass);
  const light = new THREE.PointLight('#ffca86', 0, 3.6, 2);
  light.name = `${id}-lantern-light`;
  light.position.copy(glass.position);
  group.add(light);
  return { group, light };
}
