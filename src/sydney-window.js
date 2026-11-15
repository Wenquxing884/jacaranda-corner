import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createJacarandaBlossomGeometry } from './jacaranda-blossom.js';
import sydneyPanoramaUrl from './assets/sydney-panorama.jpg';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp = THREE.MathUtils.clamp;

// A stepped ramp keeps the shading banded like a painted animation background.
function makeToonRamp() {
  const tex = new THREE.DataTexture(new Uint8Array([96, 152, 206, 240, 255]), 5, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

function branchGeometry(points, r0, r1, sides = 7) {
  const curve = new THREE.CatmullRomCurve3(points);
  const segments = Math.max(7, Math.ceil(curve.getLength() * 9));
  const frames = curve.computeFrenetFrames(segments, false);
  const positions = [], indices = [];
  for (let i = 0; i <= segments; i++) {
    const p = curve.getPointAt(i / segments);
    const r = THREE.MathUtils.lerp(r0, r1, Math.pow(i / segments, .8));
    for (let j = 0; j < sides; j++) {
      const a = j / sides * Math.PI * 2;
      const v = p.clone().addScaledVector(frames.normals[i], Math.cos(a) * r).addScaledVector(frames.binormals[i], Math.sin(a) * r);
      positions.push(v.x, v.y, v.z);
    }
  }
  for (let i = 0; i < segments; i++) for (let j = 0; j < sides; j++) {
    const a = i * sides + j, b = i * sides + (j + 1) % sides;
    indices.push(a, b, a + sides, b, b + sides, a + sides);
  }
  // Close both cuts; the larger stems also get a rounded wooden end below.
  const start = curve.getPointAt(0), end = curve.getPointAt(1), cap = positions.length / 3;
  positions.push(...start.toArray(), ...end.toArray());
  for (let j = 0; j < sides; j++) {
    indices.push(cap, (j + 1) % sides, j);
    indices.push(cap + 1, segments * sides + j, segments * sides + (j + 1) % sides);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function petalGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, -.075);
  s.bezierCurveTo(.10, -.03, .09, .07, 0, .085);
  s.bezierCurveTo(-.065, .05, -.06, -.03, 0, -.075);
  return new THREE.ShapeGeometry(s, 4);
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(128, 128, 24, 128, 128, 126);
  r.addColorStop(0, 'rgba(16,12,30,.62)');
  r.addColorStop(.55, 'rgba(16,12,30,.30)');
  r.addColorStop(1, 'rgba(16,12,30,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

export function createSydneyWindow({ modal, stage, closeButton }) {
  let renderer, scene, camera, root, branchGroup, flowerMeshes = [], hitTargets = [], petals, raf = 0, ready = false, open = false, time = 0;
  let drag = null, targetX = 0, targetY = 0, lastFocus = null;
  let blossomCount = 0, budCount = 0;
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const petalData = [];
  const frameMeshes = [], branchMeshes = [];
  const branchSway = { x: .0024, z: .0042 };
  const app = modal.closest('#app');
  const flowerPalette = ['#b78fe4', '#a67ddb', '#c9a6ee', '#d9bcf7', '#9873cd'].map(c => new THREE.Color(c));
  const dummy = new THREE.Object3D();
  let seed = 8128;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const range = (a, b) => a + rand() * (b - a);

  function init() {
    if (ready) return;
    ready = true;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, .1, 90);
    camera.position.set(0, 0, 12);
    root = new THREE.Group();
    scene.add(root);

    const ramp = makeToonRamp();
    const frameMat = new THREE.MeshStandardMaterial({ color: '#f8f4ec', roughness: .58, metalness: .04 });
    const frameEdge = new THREE.MeshStandardMaterial({ color: '#d9c3a3', roughness: .32, metalness: .34 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: '#4f3830', roughness: .92, metalness: 0 });

    // ---- Frame: a real, thick moulding with an inner lip ------------------
    const W = 8.0, H = 2.88, B = .16, D = .34;
    const rails = [
      [0, H / 2, 0, W + B * 2, B, D], [0, -H / 2, 0, W + B * 2, B, D],
      [-W / 2, 0, 0, B, H + B * 2, D], [W / 2, 0, 0, B, H + B * 2, D]
    ];
    rails.forEach(([x, y, z, w, h, d], i) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
      m.name = `postcard-rail-${i}`;
      m.position.set(x, y, z);
      root.add(m);
      frameMeshes.push(m);
    });
    const lips = [
      [0, H / 2 + .012, D / 2, W - .06, .022, .02], [0, -H / 2 - .012, D / 2, W - .06, .022, .02],
      [-W / 2 + .02, 0, D / 2, .022, H - .06, .02], [W / 2 - .02, 0, D / 2, .022, H - .06, .02]
    ];
    lips.forEach(([x, y, z, w, h, d], i) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameEdge);
      m.name = `postcard-lip-${i}`;
      m.position.set(x, y, z);
      root.add(m);
      frameMeshes.push(m);
    });

    // Soft drop shadow so the frame reads as an object, not a flat cut-out.
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(W + 2.4, H + 2.1),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, toneMapped: false })
    );
    shadow.position.z = -.62;
    root.add(shadow);

    const back = new THREE.Mesh(new THREE.BoxGeometry(W + .04, H + .04, .06), new THREE.MeshBasicMaterial({ color: '#5b4d6b' }));
    back.name = 'postcard-back';
    back.position.z = -.30;
    root.add(back);
    frameMeshes.push(back);

    // ---- The harbour photograph the user supplied -------------------------
    const panorama = new THREE.TextureLoader().load(sydneyPanoramaUrl);
    panorama.colorSpace = THREE.SRGBColorSpace;
    panorama.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const picture = new THREE.Mesh(
      new THREE.PlaneGeometry(W - .055, H - .055),
      new THREE.MeshBasicMaterial({ map: panorama, toneMapped: false })
    );
    picture.position.z = -.26;
    picture.name = 'postcard-picture';
    root.add(picture);
    frameMeshes.push(picture);

    // ---- Jacaranda branches: entirely modelled, resting on the frame ------
    branchGroup = new THREE.Group();
    branchGroup.name = 'postcard-branches';
    root.add(branchGroup);
    const trunkGeos = [];
    const blossoms = [], buds = [];
    const hitGeo = new THREE.SphereGeometry(.3, 8, 6);
    const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    // Lay the stems on the front of the moulding. Transform the centreline,
    // not the tube geometry, so their round cross-sections keep their thickness.
    // The rear surface clears the lip (z=.18), even at maximum wind sway.
    // Floor all stems comfortably in front of the lip (z=.18) even at max sway.
    const branchPoint = (x, y, z) => V(x, y, .39 + Math.max(-.18, z) * .25);
    function mainBranch(points, radius) {
      const path = points.map(p => branchPoint(...p));
      trunkGeos.push(branchGeometry(path, radius * .5, .018));
      const end = new THREE.SphereGeometry(radius * .5, 10, 8);
      end.deleteAttribute('uv');
      end.translate(...path[0].toArray());
      trunkGeos.push(end);
    }

    // One blossom cluster: a soft, slightly flattened mass with a few petals
    // trailing below it, the way a jacaranda panicle hangs off a twig.
    const up = V(0, 1, 0);
    const qAlign = new THREE.Quaternion(), qTwist = new THREE.Quaternion();
    function populateStem(curve, count, maxOffset, size = 1, uStart = .16, addBuds = true) {
      for (let i = 0; i < count; i++) {
        const u = clamp(uStart + (i / Math.max(1, count - 1)) * (1 - uStart) + range(-.05, .05), uStart, 1);
        const anchor = curve.getPointAt(u), tan = curve.getTangentAt(u).normalize();
        const ref = Math.abs(tan.y) > .9 ? V(1, 0, 0) : up;
        const n1 = V().crossVectors(tan, ref).normalize(), n2 = V().crossVectors(tan, n1).normalize();
        const a = i * 2.39996 + range(-.3, .3);
        const radial = n1.multiplyScalar(Math.cos(a)).addScaledVector(n2, Math.sin(a));
        const p = anchor.clone().addScaledVector(radial, range(.002, maxOffset));
        p.z = Math.max(p.z, .32);
        const dir = radial.clone().multiplyScalar(range(.7, 1.05)).addScaledVector(tan, range(.3, .72)).add(V(0, range(-.25, .15), 0)).normalize();
        qAlign.setFromUnitVectors(up, dir);
        qTwist.setFromAxisAngle(up, rand() * Math.PI * 2);
        const q = qAlign.clone().multiply(qTwist);
        const s = range(.66, 1.06) * size;
        blossoms.push({
          p,
          s,
          q,
          c: flowerPalette[Math.floor(rand() * flowerPalette.length)]
        });
        if (addBuds && (i === count - 1 || i % 7 === 0)) {
          const budPos = anchor.clone().addScaledVector(radial, .004);
          budPos.z = Math.max(budPos.z, .32);
          buds.push({
            p: budPos,
            q: qAlign.clone(),
            c: flowerPalette[Math.floor(rand() * flowerPalette.length)]
          });
        }
      }
    }
    function addCluster(base, size = 1) {
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.copy(base);
      hit.userData.cluster = base.clone();
      hit.visible = false;
      branchGroup.add(hit);
      hitTargets.push(hit);
    }
    function twig(pts, r = .015, fullness = 1) {
      const rich = fullness === true ? 1.25 : fullness;
      const points = pts.map(p => branchPoint(...p));
      trunkGeos.push(branchGeometry(points, r, .0045));
      const curve = new THREE.CatmullRomCurve3(points);
      const tip = points[points.length - 1];
      addCluster(tip, 1.05);
      populateStem(curve, Math.round(14 * rich), .017, 1.02, .28);
      const subCount = rich >= 1.15 ? 4 : 3;
      for (let j = 0; j < subCount; j++) {
        const u = .26 + j / Math.max(1, subCount - 1) * .68;
        const sBase = curve.getPointAt(u), sTan = curve.getTangentAt(u);
        const a = Math.atan2(sTan.y, sTan.x) + (j % 2 ? 1 : -1) * range(.55, 1.05);
        const len = range(.20, .36);
        const sTip = sBase.clone().add(V(Math.cos(a) * len, Math.sin(a) * len - .05, range(.02, .08)));
        const sMid = sBase.clone().lerp(sTip, .5).add(V(0, .03, .025));
        trunkGeos.push(branchGeometry([sBase, sMid, sTip], .0065, .002, 5));
        const spray = new THREE.CatmullRomCurve3([sBase, sMid, sTip]);
        populateStem(spray, Math.round(12 * Math.min(1.2, rich)), .015, .95, .12);
        if (j >= subCount - 2) {
          const tBase = spray.getPointAt(.62), tTan = spray.getTangentAt(.62);
          const ta = Math.atan2(tTan.y, tTan.x) + (j % 2 ? -.72 : .72);
          const tLen = range(.13, .21);
          const tTip = tBase.clone().add(V(Math.cos(ta) * tLen, Math.sin(ta) * tLen - .03, range(.02, .06)));
          const tMid = tBase.clone().lerp(tTip, .5).add(V(0, .02, .02));
          trunkGeos.push(branchGeometry([tBase, tMid, tTip], .0045, .0016, 4));
          populateStem(new THREE.CatmullRomCurve3([tBase, tMid, tTip]), 9, .012, .88, .10, false);
        }
      }
      addCluster(curve.getPointAt(.58), .9);
    }
    function bareTwig(pts, r = .007) {
      trunkGeos.push(branchGeometry(pts.map(p => branchPoint(...p)), r, .0025, 5));
    }

    // Two curved sprigs rest over the corners, with their roots fully in front
    // of the rails instead of passing from the back through the frame volume.
    mainBranch([
      [4.045, 1.34, -.20], [3.88, 1.38, -.02], [3.64, 1.60, .08],
      [3.32, 1.73, .13], [2.98, 1.72, .17], [2.68, 1.57, .20], [2.44, 1.36, .22]
    ], .098);
    twig([[3.88, 1.40, -.01], [3.66, 1.18, .09], [3.52, .92, .15]], .024, 1.05);
    twig([[3.62, 1.60, .08], [3.52, 1.92, .13], [3.28, 2.06, .16]], .019, 1.05);
    twig([[3.30, 1.74, .13], [3.16, 1.46, .18], [2.98, 1.24, .21]], .022, 1.25);
    twig([[3.02, 1.71, .17], [2.86, 1.94, .20], [2.62, 2.00, .21]], .017, 1.10);
    twig([[2.96, 1.70, .17], [2.80, 1.42, .21], [2.62, 1.16, .23]], .021, 1.15);
    twig([[2.68, 1.56, .20], [2.42, 1.44, .23], [2.16, 1.30, .25]], .015, 1.25);
    twig([[2.46, 1.34, .22], [2.30, 1.06, .24], [2.14, .80, .25]], .016, 1.10);
    twig([[2.22, 1.28, .24], [2.00, 1.18, .26], [1.82, 1.08, .27]], .011, .90);
    twig([[3.42, 1.70, .12], [3.42, 1.98, .15], [3.18, 2.12, .18]], .013, .95);
    bareTwig([[3.06, 1.72, .17], [2.94, 1.90, .19], [2.98, 2.04, .20]]);

    // Left-hand branch: across the lower-left corner, mirrored and re-bent.
    mainBranch([
      [-4.045, -1.36, -.20], [-3.86, -1.42, -.02], [-3.62, -1.60, .08],
      [-3.30, -1.70, .13], [-2.98, -1.66, .17], [-2.70, -1.50, .20], [-2.48, -1.28, .22]
    ], .102);
    twig([[-3.86, -1.44, -.01], [-3.64, -1.16, .09], [-3.52, -.90, .15]], .024, 1.05);
    twig([[-3.62, -1.60, .08], [-3.50, -1.90, .13], [-3.28, -2.02, .16]], .019, 1.05);
    twig([[-3.30, -1.70, .13], [-3.14, -1.42, .18], [-2.96, -1.20, .21]], .022, 1.25);
    twig([[-3.02, -1.66, .17], [-2.86, -1.88, .20], [-2.62, -1.94, .21]], .017, 1.10);
    twig([[-2.94, -1.66, .17], [-2.78, -1.38, .21], [-2.60, -1.12, .23]], .021, 1.15);
    twig([[-2.70, -1.50, .20], [-2.46, -1.38, .23], [-2.20, -1.24, .25]], .015, 1.25);
    twig([[-2.48, -1.28, .22], [-2.32, -1.00, .24], [-2.16, -.74, .25]], .016, 1.10);
    twig([[-2.26, -1.26, .24], [-2.02, -1.14, .26], [-1.84, -1.02, .27]], .011, .90);
    twig([[-3.36, -1.68, .12], [-3.34, -1.96, .15], [-3.10, -2.08, .18]], .013, .95);
    bareTwig([[-2.90, -1.66, .17], [-2.78, -1.86, .19], [-2.82, -2.00, .20]]);

    const wood = new THREE.Mesh(mergeGeometries(trunkGeos), trunkMat);
    wood.name = 'postcard-branch-wood';
    branchGroup.add(wood);
    branchMeshes.push(wood);
    trunkGeos.forEach(g => g.dispose());

    const flowerGeo = createJacarandaBlossomGeometry();
    const flowerMat = new THREE.MeshStandardMaterial({
      color: '#ffffff', vertexColors: true, roughness: .86, metalness: 0,
      emissive: '#6f49a0', emissiveIntensity: .025
    });
    const flowerMesh = new THREE.InstancedMesh(flowerGeo, flowerMat, blossoms.length);
    blossomCount = blossoms.length; budCount = buds.length;
    flowerMesh.name = 'postcard-branch-flowers';
    blossoms.forEach((b, i) => {
      dummy.position.copy(b.p);
      dummy.scale.setScalar(b.s);
      dummy.quaternion.copy(b.q);
      dummy.updateMatrix();
      flowerMesh.setMatrixAt(i, dummy.matrix);
      flowerMesh.setColorAt(i, b.c);
    });
    branchGroup.add(flowerMesh);
    flowerMeshes.push(flowerMesh);
    branchMeshes.push(flowerMesh);
    if (buds.length) {
      const budGeo = new THREE.SphereGeometry(.016, 6, 5);
      const budMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .92 });
      const budMesh = new THREE.InstancedMesh(budGeo, budMat, buds.length);
      budMesh.name = 'postcard-branch-buds';
      buds.forEach((b, i) => {
        dummy.position.copy(b.p);
        dummy.scale.set(.68, 1.32, .68);
        dummy.quaternion.copy(b.q);
        dummy.updateMatrix();
        budMesh.setMatrixAt(i, dummy.matrix);
        budMesh.setColorAt(i, b.c);
      });
      branchGroup.add(budMesh);
      flowerMeshes.push(budMesh);
      branchMeshes.push(budMesh);
    }

    // A few petals drifting through the souvenir window.
    const petalMat = new THREE.MeshBasicMaterial({ color: '#b98fe0', side: THREE.DoubleSide, transparent: true, opacity: .82, toneMapped: false });
    petals = new THREE.InstancedMesh(petalGeometry(), petalMat, 64);
    petals.frustumCulled = false;
    root.add(petals);
    for (let i = 0; i < 64; i++) petalData.push(freshPetal(i < 16));

    const hemi = new THREE.HemisphereLight('#cdd4ff', '#4a3b58', 1.12);
    scene.add(hemi);
    const key = new THREE.DirectionalLight('#ffd6ae', 1.95);
    key.position.set(4.5, 5.5, 7);
    scene.add(key);
    const rim = new THREE.DirectionalLight('#93a7f2', 1.5);
    rim.position.set(-6, 3.5, -4);
    scene.add(rim);
    const fill = new THREE.DirectionalLight('#cbb8ff', .7);
    fill.position.set(-3, -3, 6);
    scene.add(fill);
    const harbourGlow = new THREE.PointLight('#ffb06a', 5, 4.2, 2);
    harbourGlow.position.set(1.1, -.25, .5);
    scene.add(harbourGlow);

    stage.addEventListener('pointerdown', e => {
      if (!open) return;
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: 0 };
      stage.setPointerCapture?.(e.pointerId);
    });
    stage.addEventListener('pointermove', e => {
      if (!open) return;
      if (drag) {
        drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy));
        targetY = clamp((e.clientX - drag.sx) / innerWidth * 1.1, -.17, .17);
        targetX = clamp(-(e.clientY - drag.sy) / innerHeight * .55, -.08, .08);
      }
    });
    stage.addEventListener('pointerup', e => {
      if (!drag) return;
      const wasClick = drag.moved < 6 && performance.now() - drag.t < 650;
      drag = null;
      if (!wasClick) return;
      const r = stage.getBoundingClientRect();
      pointer.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([...flowerMeshes, ...hitTargets], false)[0];
      if (hit) {
        let worldPoint;
        if (hit.object.userData.cluster) worldPoint = hit.object.getWorldPosition(V(0, 0, 0));
        else {
          const m = new THREE.Matrix4();
          hit.object.getMatrixAt(hit.instanceId, m);
          worldPoint = V(0, 0, 0).setFromMatrixPosition(m).applyMatrix4(hit.object.matrixWorld);
        }
        burst(root.worldToLocal(worldPoint));
      }
    });
    resize();
  }

  function freshPetal(active = true) {
    return { x: range(-3.7, 3.7), y: range(-2.3, 2.5), z: range(.34, .70), vy: range(.09, .24), rot: rand() * 6.28, spin: range(.25, .8), scale: range(.5, 1.05), active };
  }
  function burst(center = V(2.4, 1.6, .3)) {
    let n = 0;
    for (const p of petalData) if (n < 44) {
      Object.assign(p, freshPetal(true), { x: center.x + range(-.55, .55), y: center.y + range(-.3, .3), z: center.z + range(-.15, .3) });
      n++;
    }
  }

  function resize() {
    if (!renderer) return;
    const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const frameW = 8.9, frameH = 4.5, tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const fraction = w > 900 ? .80 : .95;
    const dW = frameW / (2 * tan * camera.aspect * fraction);
    const dH = frameH / (2 * tan * fraction);
    camera.position.z = Math.max(dW, dH, 8.5);
    camera.updateProjectionMatrix();
  }

  function renderLoop() {
    if (!open) { raf = 0; return; }
    const dt = Math.min(.033, (performance.now() - (renderLoop.last || performance.now())) / 1000);
    renderLoop.last = performance.now();
    time += dt;
    const follow = 1 - Math.exp(-(drag ? 22 : 12) * dt);
    root.rotation.y += (targetY - root.rotation.y) * follow;
    root.rotation.x += (targetX - root.rotation.x) * follow;
    if (branchGroup) {
      branchGroup.rotation.z = Math.sin(time * .52) * branchSway.z;
      branchGroup.rotation.x = Math.sin(time * .41) * branchSway.x;
    }
    for (let i = 0; i < petalData.length; i++) {
      const p = petalData[i];
      if (p.active) {
        p.y -= p.vy * dt;
        p.x += Math.sin(time * .5 + p.rot) * dt * .13;
        p.rot += p.spin * dt;
        if (p.y < -2.35) Object.assign(p, freshPetal(i < 16));
      }
      if (p.active) {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(p.rot, p.rot * .5, p.rot * .3);
        dummy.scale.setScalar(p.scale);
      } else {
        dummy.position.set(0, -20, 0);
        dummy.scale.setScalar(0);
      }
      dummy.updateMatrix();
      petals.setMatrixAt(i, dummy.matrix);
    }
    petals.instanceMatrix.needsUpdate = true;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(renderLoop);
  }

  function openWindow() {
    if (!ready) init();
    if (open) return;
    lastFocus = document.activeElement;
    app?.classList.add('postcard-open');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    open = true;
    targetX = targetY = 0;
    resize();
    if (!raf) { renderLoop.last = performance.now(); raf = requestAnimationFrame(renderLoop); }
    setTimeout(() => closeButton.focus(), 120);
  }
  function closeWindow() {
    if (!open) return;
    open = false;
    drag = null;
    app?.classList.remove('postcard-open');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
  }
  closeButton.addEventListener('click', closeWindow);
  modal.querySelector('.sydney-shade').addEventListener('click', closeWindow);
  addEventListener('keydown', e => { if (e.key === 'Escape' && open) closeWindow(); });
  addEventListener('resize', () => { if (open) resize(); });

  function flowerScreen(index = 0) {
    if (!hitTargets.length) return null;
    const target = hitTargets[Math.min(index, hitTargets.length - 1)];
    const p = target.getWorldPosition(V(0, 0, 0)).project(camera);
    const r = stage.getBoundingClientRect();
    return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 };
  }

  // Copies only, generated on demand for geometry regression checks. These
  // coordinates exclude the shared root rotation, which moves frame and sprigs
  // together and therefore cannot change the clearance between them.
  function geometrySnapshot() {
    if (!ready) return null;
    const frameBounds = frameMeshes.map(m => {
      m.updateMatrix();
      const bounds = new THREE.Box3().setFromBufferAttribute(m.geometry.getAttribute('position')).applyMatrix4(m.matrix);
      return { name: m.name, min: bounds.min.toArray(), max: bounds.max.toArray() };
    });
    const branchVertices = [], point = new THREE.Vector3(), instance = new THREE.Matrix4(), transform = new THREE.Matrix4();
    for (const m of branchMeshes) {
      m.updateMatrix();
      const positions = m.geometry.getAttribute('position');
      for (let i = 0; i < (m.isInstancedMesh ? m.count : 1); i++) {
        if (m.isInstancedMesh) { m.getMatrixAt(i, instance); transform.multiplyMatrices(m.matrix, instance); }
        else transform.copy(m.matrix);
        for (let j = 0; j < positions.count; j++) {
          point.fromBufferAttribute(positions, j).applyMatrix4(transform);
          branchVertices.push(point.x, point.y, point.z);
        }
      }
    }
    return { frameBounds, branchVertices, branchPosition: branchGroup.position.toArray(), sway: { ...branchSway } };
  }
  return {
    open: openWindow, close: closeWindow, isOpen: () => open,
    inspect: () => ({
      flowerMeshes: flowerMeshes.length, flowers: blossomCount, buds: budCount, clusters: hitTargets.length, open, ready,
      frames: renderer?.info.render.frame ?? 0, triangles: renderer?.info.render.triangles ?? 0,
      rotation: root ? [root.rotation.x, root.rotation.y] : null,
      activePetals: petalData.filter(p => p.active).length,
      clearAlpha: renderer?.getClearAlpha() ?? null
    }),
    flowerScreen, geometrySnapshot
  };
}
