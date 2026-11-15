import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.env.JACARANDA_OFFLINE === '1';
const existingURL = process.env.JACARANDA_URL;
const localURL = 'http://127.0.0.1:5177/';
const server = offline || existingURL ? null : await createServer({
  root: projectRoot, configLoader: 'native', cacheDir: '.tmp/vite-test-cache',
  server: {
    host: '127.0.0.1', port: 5177, strictPort: true,
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

async function settleTime(page, time) {
  await page.evaluate(value => window.__JACARANDA__.setTime(value), time);
  await page.waitForFunction(expected => {
    const state = window.__JACARANDA__.inspect();
    return state.time === expected && state.transition === 1;
  }, time, { timeout: 15000 });
}

async function lightingState(page) {
  return page.evaluate(() => {
    const { scene } = window.__JACARANDA__;
    const panes = [], points = [], lanterns = [];
    scene.traverse(object => {
      for (const pane of object.userData.glazing || []) panes.push(pane);
      if (object.isPointLight) points.push(object);
      if (object.userData.hangingLantern) lanterns.push(object);
    });
    const materials = [...new Set(panes.map(pane => pane.material))];
    scene.updateMatrixWorld(true);
    const lanternStates = lanterns.map(group => {
      const id = group.name.replace(/-hanging-lantern$/, '');
      const frame = group.getObjectByName(`${id}-lantern-frame`);
      const glass = group.getObjectByName(`${id}-lantern-glass`);
      const light = group.getObjectByName(`${id}-lantern-light`);
      if (!frame?.geometry || !glass?.geometry || !light?.isPointLight) return { id, complete: false };
      const Vec = group.position.constructor;
      const framePosition = frame.geometry.attributes.position;
      let lowestY = Infinity, highestY = -Infinity;
      for (let i = 0; i < framePosition.count; i++) {
        const point = frame.localToWorld(new Vec().fromBufferAttribute(framePosition, i));
        lowestY = Math.min(lowestY, point.y);
        highestY = Math.max(highestY, point.y);
      }
      glass.geometry.computeBoundingBox();
      const glassCenter = glass.getWorldPosition(new Vec()), lightCenter = light.getWorldPosition(new Vec());
      return {
        id, complete: true, group: group.uuid, geometry: [frame.geometry.uuid, glass.geometry.uuid],
        center: glassCenter.toArray(), lightSeparation: glassCenter.distanceTo(lightCenter),
        lowestY, highestY,
        outboardClearance: glass.position.z + glass.geometry.boundingBox.min.z - .02,
        intensity: light.intensity, emission: glass.material.emissiveIntensity,
        vertices: framePosition.count
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
    return {
      panes: panes.length,
      materials: materials.map(material => ({
        name: material.name, intensity: material.emissiveIntensity,
        rgb: material.emissive.toArray(), panes: panes.filter(pane => pane.material === material).length
      })),
      pointLights: points.length, pointShadows: points.filter(light => light.castShadow).length,
      hangingLanterns: lanterns.length, lanterns: lanternStates
    };
  });
}

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
  const day = await lightingState(page);
  await settleTime(page, 'night');
  const night = await lightingState(page);

  const rendered = await page.evaluate(async moduleURL => {
    const { Raycaster, Vector2, Vector3 } = await import(moduleURL);
    const { scene, renderer, camera, controls } = window.__JACARANDA__;
    const panes = [], glassMeshes = [];
    scene.updateMatrixWorld(true);
    scene.traverse(group => {
      for (const pane of group.userData.glazing || []) panes.push({ group, ...pane });
    });
    const materials = [...new Set(panes.map(pane => pane.material))];
    scene.traverse(object => {
      if (object.isMesh && materials.includes(object.material)) glassMeshes.push(object);
    });
    const original = {
      position: camera.position.clone(), quaternion: camera.quaternion.clone(), target: controls.target.clone(),
      intensities: materials.map(material => material.emissiveIntensity)
    };
    const gl = renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const read = () => {
      renderer.render(scene, camera);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const restoreEmission = () => materials.forEach((material, i) => { material.emissiveIntensity = original.intensities[i]; });
    const ray = new Raycaster(), ndc = new Vector2(), results = [];
    try {
      controls.target.set(0, 3.9, 0);
      for (const [view, position] of [['front', [14, 8.4, 18]], ['rear', [-16, 8.4, -18]]]) {
        camera.position.set(...position);
        camera.lookAt(controls.target);
        camera.updateMatrixWorld(true);
        restoreEmission();
        let on, off;
        // No animation runs between these renders; only visible glass
        // emission changes. Tree occlusion remains in both pixel buffers.
        try {
          on = read();
          materials.forEach(material => { material.emissiveIntensity = 0; });
          off = read();
        } finally {
          restoreEmission();
        }
        const result = { view, facingPanes: 0, matchedPanes: 0, litPanes: 0, litSamples: 0, maxRgbDelta: 0, byMaterial: {} };
        for (const pane of panes) {
          const center = pane.group.localToWorld(new Vector3(...pane.center));
          const normal = new Vector3(0, 0, 1).transformDirection(pane.group.matrixWorld);
          if (normal.dot(camera.position.clone().sub(center)) <= 0) continue;
          result.facingPanes++;
          let paneMatched = false, paneLit = false;
          for (const x of [-.22, .22]) for (const y of [-.31, -.22, .22, .31]) {
            const point = pane.group.localToWorld(new Vector3(...pane.center).add(new Vector3(pane.width * x, pane.height * y, 0)));
            const projected = point.clone().project(camera);
            if (Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1 || Math.abs(projected.z) >= 1) continue;
            ndc.set(projected.x, projected.y);
            ray.setFromCamera(ndc, camera);
            // Raycast only the few actual glazing batches; pixel differences
            // below prove visibility through the full architecture/trees.
            const hit = ray.intersectObjects(glassMeshes, false)[0];
            if (!hit || hit.object.material !== pane.material || hit.point.distanceTo(point) > .025) continue;
            paneMatched = true;
            const px = Math.floor((projected.x + 1) * width * .5), py = Math.floor((projected.y + 1) * height * .5);
            let affected = 0, maxDelta = 0;
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
              if (px + dx < 0 || px + dx >= width || py + dy < 0 || py + dy >= height) continue;
              const i = ((py + dy) * width + px + dx) * 4;
              const delta = on[i] + on[i + 1] + on[i + 2] - off[i] - off[i + 1] - off[i + 2];
              maxDelta = Math.max(maxDelta, delta);
              if (delta > 18 && on[i] > on[i + 2] + 5) affected++;
            }
            result.maxRgbDelta = Math.max(result.maxRgbDelta, maxDelta);
            if (affected >= 2) {
              paneLit = true;
              result.litSamples++;
            }
          }
          if (paneMatched) result.matchedPanes++;
          if (paneLit) {
            result.litPanes++;
            result.byMaterial[pane.material.name] = (result.byMaterial[pane.material.name] || 0) + 1;
          }
        }
        results.push(result);
      }
    } finally {
      restoreEmission();
      camera.position.copy(original.position);
      camera.quaternion.copy(original.quaternion);
      controls.target.copy(original.target);
      camera.updateMatrixWorld(true);
      renderer.render(scene, camera);
    }
    return results;
  }, threeURL);
  await settleTime(page, 'day');
  const returnedDay = await lightingState(page);

  console.log(JSON.stringify({ day, night, rendered, returnedDay, errors, shaderErrors }, null, 2));
  assert.deepEqual(errors, [], 'no runtime errors');
  assert.deepEqual(shaderErrors, [], 'no WebGL shader errors');
  assert.equal(night.panes, 37, 'all 33 facade windows and four door panes are tracked');
  assert.deepEqual(night.materials.map(material => material.name).sort(), ['window-glass', 'window-glass-soft']);
  assert.ok(night.materials.every(material => material.intensity >= 1 && material.rgb[0] > material.rgb[1] && material.rgb[1] > material.rgb[2]), 'every visible glazing material emits warm light at night');
  const intensities = night.materials.map(material => material.intensity);
  assert.ok(Math.max(...intensities) / Math.min(...intensities) <= 1.5, 'room brightness variation never leaves a dark group');
  assert.ok(day.materials.every(material => material.intensity === 0) && returnedDay.materials.every(material => material.intensity === 0), 'window emission is off in daylight and after returning from night');
  for (const view of rendered) {
    assert.ok(view.litPanes > 8, `${view.view}: more than eight windows visibly emit warm light (${JSON.stringify(view)})`);
    assert.ok(view.byMaterial['window-glass'] > 0 && view.byMaterial['window-glass-soft'] > 0, `${view.view}: both glazing variants visibly light up`);
  }
  assert.equal(night.hangingLanterns, 3, 'all three building wall lights are hanging lanterns');
  assert.deepEqual(night.lanterns.map(lantern => lantern.id), ['entry', 'front', 'side'], 'entry, front and side lanterns survive static batching');
  for (const lantern of night.lanterns) {
    const before = day.lanterns.find(other => other.id === lantern.id);
    const after = returnedDay.lanterns.find(other => other.id === lantern.id);
    assert.ok(lantern.complete && before?.complete && after?.complete, `${lantern.id}: frame, glass and actual light are present in every period`);
    assert.ok(lantern.vertices > 100 && lantern.lightSeparation < 1e-6, `${lantern.id}: real light is centered inside the framed glass`);
    assert.ok(lantern.lowestY > 2 && lantern.highestY < 2.97 && lantern.outboardClearance > .15, `${lantern.id}: lantern clears the balcony, head height and mounting plate`);
    assert.ok(lantern.intensity > 0 && lantern.emission > 1 && before.intensity === 0 && after.intensity === 0, `${lantern.id}: lamp follows the day/night lighting transition`);
    assert.deepEqual(lantern.geometry, before.geometry, `${lantern.id}: night uses the same physical hanging lamp`);
    assert.deepEqual(after.geometry, before.geometry, `${lantern.id}: return to day preserves lamp geometry`);
    assert.deepEqual(lantern.center, before.center, `${lantern.id}: night does not move the hanging lamp`);
    assert.deepEqual(after.center, before.center, `${lantern.id}: return to day preserves lamp position`);
  }
  assert.equal(night.pointLights, 6, 'hanging lamps reuse the six existing local lights');
  assert.equal(night.pointShadows, 1, 'only the original bench lamp adds a point-light shadow pass');
} finally {
  await browser?.close();
  await server?.close();
}
