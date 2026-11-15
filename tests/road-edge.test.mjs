import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.env.JACARANDA_OFFLINE === '1';
const existingURL = process.env.JACARANDA_URL;
const localURL = 'http://127.0.0.1:5176/';
const server = offline || existingURL ? null : await createServer({
  root: projectRoot,
  configLoader: 'native',
  cacheDir: '.tmp/vite-test-cache',
  server: {
    host: '127.0.0.1', port: 5176, strictPort: true,
    watch: { ignored: ['**/.tmp/**', '**/*.tmpdir/**'] }
  },
  logLevel: 'error'
});
await server?.listen();

const targetURL = existingURL || (offline ? pathToFileURL(resolve(projectRoot, 'jacaranda-corner.html')).href : localURL);
const threeURL = targetURL.startsWith('file:')
  ? pathToFileURL(resolve(projectRoot, 'node_modules/three/build/three.module.js')).href
  : new URL('/node_modules/three/build/three.module.js', targetURL).href;
const angle = process.env.JACARANDA_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'swiftshader');
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--use-angle=${angle}`, '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], shaderErrors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /WebGL|GLSL|shader|VALIDATE_STATUS|LINK_STATUS/i.test(message.text())) shaderErrors.push(message.text());
  });
  await page.goto(targetURL);
  await page.waitForFunction(() => window.__JACARANDA__?.inspect().frames >= 2, null, { timeout: 60000 });
  await page.waitForTimeout(200);

  const evidence = await page.evaluate(async moduleURL => {
    const { Raycaster, Vector2, Vector3 } = await import(moduleURL);
    const { scene, camera, controls, renderer } = window.__JACARANDA__;
    const baseColor = 'b0a9b2', capColor = 'e5dfcf', half = 6.7;
    const edgeMeshes = [], baseMeshes = [];
    scene.traverse(object => {
      if (!object.isMesh || Array.isArray(object.material)) return;
      const color = object.material.color?.getHexString();
      if (color === baseColor || color === capColor) edgeMeshes.push(object);
      if (color === baseColor) baseMeshes.push(object);
    });
    scene.updateMatrixWorld(true);
    const sides = [
      { name: '+x', normal: new Vector3(1, 0, 0), along: new Vector3(0, 0, 1) },
      { name: '-x', normal: new Vector3(-1, 0, 0), along: new Vector3(0, 0, 1) },
      { name: '+z', normal: new Vector3(0, 0, 1), along: new Vector3(1, 0, 0) },
      { name: '-z', normal: new Vector3(0, 0, -1), along: new Vector3(1, 0, 0) }
    ];
    const pointAt = (side, along, y) => side.normal.clone().multiplyScalar(half).addScaledVector(side.along, along).setY(y);
    const ray = new Raycaster();
    const rayEvidence = { samples: 0, failures: [] };
    for (const side of sides) for (const y of [-.10, .02, .06]) for (const along of [-5, -3, 1.3, 3.5, 5]) {
      const point = pointAt(side, along, y);
      ray.set(point.clone().addScaledVector(side.normal, 2), side.normal.clone().negate().normalize());
      const hits = ray.intersectObjects(edgeMeshes, false);
      const nearest = hits[0]?.distance;
      // A ray on a triangle diagonal can hit both triangles of one face.
      // Keep separate instances/materials: those are the competing surfaces.
      const owners = new Map();
      for (const hit of hits) {
        if (Math.abs(hit.distance - nearest) > 1e-5) break;
        owners.set(`${hit.object.uuid}:${hit.instanceId ?? '-'}`, {
          color: hit.object.material.color.getHexString(), instance: hit.instanceId ?? null,
          distance: hit.distance
        });
      }
      const expected = y < 0 ? baseColor : capColor;
      const visibleOwners = [...owners.values()];
      rayEvidence.samples++;
      if (visibleOwners.length !== 1 || Math.abs(nearest - 2) > 1e-4 || visibleOwners[0]?.color !== expected) {
        rayEvidence.failures.push({ side: side.name, along, y, expected, owners: visibleOwners });
      }
    }

    const original = {
      position: camera.position.clone(), quaternion: camera.quaternion.clone(), target: controls.target.clone(),
      visible: baseMeshes.map(object => object.visible),
      autoShadow: renderer.shadowMap.autoUpdate, updateShadow: renderer.shadowMap.needsUpdate
    };
    const gl = renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const read = () => {
      renderer.render(scene, camera);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const restoreBase = () => baseMeshes.forEach((object, i) => { object.visible = original.visible[i]; });
    const pixelEvidence = { views: [], samples: 0, mismatches: 0, maxRgbDelta: 0, examples: [] };
    const ndc = new Vector2();
    const sidePointForPixel = (side, px, py) => {
      ndc.set(px / width * 2 - 1, py / height * 2 - 1);
      ray.setFromCamera(ndc, camera);
      const denominator = side.normal.dot(ray.ray.direction);
      if (denominator >= -1e-6) return null;
      const distance = (half - side.normal.dot(ray.ray.origin)) / denominator;
      return distance > 0 ? ray.ray.at(distance, new Vector3()) : null;
    };
    try {
      controls.target.set(0, 0, 0);
      // Both states use the same cached shadow atlas. Hiding the base must
      // change only its visible surface, not lighting on the stone cap.
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;
      for (let view = 0; view < 20; view++) {
        const azimuth = (view + .35) / 20 * Math.PI * 2;
        camera.position.set(Math.cos(azimuth) * 18, 3, Math.sin(azimuth) * 18);
        camera.lookAt(controls.target);
        camera.updateMatrixWorld(true);
        restoreBase();
        const normal = read();
        let capOnly;
        try {
          baseMeshes.forEach(object => { object.visible = false; });
          capOnly = read();
        } finally {
          restoreBase();
        }
        const frame = { view, azimuth: Math.round(azimuth * 180 / Math.PI), samples: 0, mismatches: 0, maxRgbDelta: 0 };
        const seenPixels = new Set();
        for (const side of sides) {
          // Stay on genuinely camera-facing exterior faces, away from a
          // grazing face or one viewed through the opposite side of the base.
          if (side.normal.dot(camera.position) < half + 1) continue;
          for (let along = -5.6; along <= 5.61; along += .35) {
            if (Math.abs(along) < 1) continue;
            const projected = pointAt(side, along, .025).project(camera);
            if (Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1 || Math.abs(projected.z) >= 1) continue;
            const px = Math.floor((projected.x + 1) * width * .5), py = Math.floor((projected.y + 1) * height * .5);
            const center = sidePointForPixel(side, px + .5, py + .5);
            if (!center || center.y < .008 || center.y > .038) continue;
            // The entire pixel lies inside the side band. This excludes
            // antialiasing at y=0, where hiding the lower base should differ.
            const corners = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([dx, dy]) => sidePointForPixel(side, px + dx, py + dy));
            if (corners.some(point => !point || point.y <= .003 || point.y >= .038 || Math.abs(point.dot(side.along)) >= 6.3)) continue;
            const pixel = py * width + px;
            if (seenPixels.has(pixel)) continue;
            seenPixels.add(pixel);
            const i = pixel * 4;
            const delta = Math.abs(normal[i] - capOnly[i]) + Math.abs(normal[i + 1] - capOnly[i + 1]) + Math.abs(normal[i + 2] - capOnly[i + 2]);
            frame.samples++;
            frame.maxRgbDelta = Math.max(frame.maxRgbDelta, delta);
            if (delta > 6) {
              frame.mismatches++;
              if (pixelEvidence.examples.length < 12) pixelEvidence.examples.push({ view, side: side.name, along: Number(along.toFixed(2)), y: center.y, delta });
            }
          }
        }
        pixelEvidence.views.push(frame);
        pixelEvidence.samples += frame.samples;
        pixelEvidence.mismatches += frame.mismatches;
        pixelEvidence.maxRgbDelta = Math.max(pixelEvidence.maxRgbDelta, frame.maxRgbDelta);
      }
    } finally {
      restoreBase();
      camera.position.copy(original.position);
      camera.quaternion.copy(original.quaternion);
      controls.target.copy(original.target);
      camera.updateMatrixWorld(true);
      renderer.render(scene, camera);
      renderer.shadowMap.autoUpdate = original.autoShadow;
      renderer.shadowMap.needsUpdate = original.updateShadow;
    }
    return { baseMeshes: baseMeshes.length, rays: rayEvidence, pixels: pixelEvidence };
  }, threeURL);

  // Print every measurement before asserting so a failing baseline retains
  // both the exact overlapping owners and the observed orbit pixel changes.
  console.log(JSON.stringify({ errors, shaderErrors, ...evidence }, null, 2));
  assert.deepEqual(errors, [], 'no runtime errors');
  assert.deepEqual(shaderErrors, [], 'no WebGL shader errors');
  assert.ok(evidence.baseMeshes > 0, 'the actual gray plinth base is present');
  assert.equal(evidence.rays.samples, 60, 'sample all four sides at three heights');
  assert.deepEqual(evidence.rays.failures, [], 'every exposed rim point has one correctly colored owner with no gap');
  assert.equal(evidence.pixels.views.length, 20, 'sample a complete low-angle orbit');
  assert.ok(evidence.pixels.samples > 100, 'measure enough interior edge pixels throughout the orbit');
  assert.equal(evidence.pixels.mismatches, 0, 'the gray base never replaces the stone-colored outer rim during orbit');
} finally {
  await browser?.close();
  await server?.close();
}
