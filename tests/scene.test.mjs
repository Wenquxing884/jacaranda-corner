import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const offline = process.env.JACARANDA_OFFLINE === '1';
const previewURL = process.env.JACARANDA_URL;
// Windows Chrome has a reliable D3D11 backend; software WebGL cannot produce
// a compositor screenshot of this detailed scene within the default timeout.
const angle = process.env.JACARANDA_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'swiftshader');
const server = offline || previewURL ? null : await createServer({ server: { host: '127.0.0.1', port: 5174, strictPort: true, watch: { ignored: ['**/.tmp/**', '**/*.tmpdir/**'] } }, logLevel: 'error' });
await server?.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--use-angle=${angle}`, '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], shaderErrors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => {
    if (message.type() === 'error' && /WebGL|GLSL|shader|VALIDATE_STATUS|LINK_STATUS/i.test(message.text())) shaderErrors.push(message.text());
  });
  await page.goto(previewURL || (offline ? pathToFileURL(resolve('jacaranda-corner.html')).href : 'http://127.0.0.1:5174/'));
  await page.waitForFunction(() => window.__JACARANDA__?.ready, null, { timeout: 60000 });
  await page.waitForTimeout(1600);

  const inspect = () => page.evaluate(() => window.__JACARANDA__.inspect());
  const initial = await inspect();
  assert.equal(initial.trees, 7, 'seven jacaranda trees');
  assert.ok(initial.flowers > 8000, 'flower crowns are populated');
  assert.ok(initial.drawCalls < 550, 'draw calls stay within a miniature-scene budget');
  assert.equal(initial.shadowAutoUpdate, false, 'stationary shadows are cached instead of rebuilt during orbit');
  assert.ok(initial.cameraNear >= .35, 'near plane preserves depth precision for thin road markings');
  assert.equal(errors.length, 0, 'no page errors');
  const bark = await page.evaluate(() => {
    const woods = Array.from({ length: 7 }, (_, i) => window.__JACARANDA__.scene.getObjectByName(`tree-wood-${i}`));
    const materials = [...new Set(woods.filter(Boolean).map(wood => wood.material))];
    return {
      woods: woods.filter(Boolean).length,
      materials: materials.map(material => ({
        color: material.color.getHexString(), colorMap: !!material.map, bumpMap: !!material.bumpMap,
        roughness: material.roughness, metalness: material.metalness, relief: material.userData.barkRelief?.value
      }))
    };
  });
  assert.equal(bark.woods, 7, 'all seven trunks use the bark material');
  assert.deepEqual(bark.materials.map(material => material.color).sort(), ['4a352d', '533c33', '5c4339'], 'bark retains the three original brown base colors');
  assert.ok(bark.materials.every(material => !material.colorMap && !material.bumpMap && material.roughness === .93 && material.metalness === 0
    && Number.isFinite(material.relief) && material.relief > 0 && material.relief <= .03),
  `bark adds restrained surface relief without changing its brown palette: ${JSON.stringify(bark)}`);
  // Both renders run in one task: no animation or camera movement can create
  // the difference. Disabling only bark relief must visibly flatten the wood.
  const barkPixels = await page.evaluate(() => {
    const { scene, camera, renderer } = window.__JACARANDA__;
    const materials = [...new Set(Array.from({ length: 7 }, (_, i) => scene.getObjectByName(`tree-wood-${i}`).material))];
    const original = materials.map(material => material.userData.barkRelief.value);
    const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const read = () => {
      renderer.render(scene, camera);
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    let on, off;
    try {
      on = read();
      materials.forEach(material => { material.userData.barkRelief.value = 0; });
      off = read();
    } finally {
      materials.forEach((material, i) => { material.userData.barkRelief.value = original[i]; });
      renderer.render(scene, camera);
    }
    let changedPixels = 0, maxRgbDelta = 0;
    for (let i = 0; i < on.length; i += 4) {
      const delta = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]);
      if (delta > 6) changedPixels++;
      maxRgbDelta = Math.max(maxRgbDelta, delta);
    }
    return { changedPixels, maxRgbDelta };
  });
  assert.ok(barkPixels.changedPixels > 80 && barkPixels.maxRgbDelta > 12, `bark relief visibly affects the rendered wood: ${JSON.stringify(barkPixels)}`);
  assert.equal(await page.evaluate(() => document.querySelector('.wordmark').tagName), 'SPAN', 'brand mark is not a directory link');
  const branchCrossings = await page.evaluate(() => {
    const roots = [];
    window.__JACARANDA__.scene.traverse(o => { if (o.userData.treeRoot) roots.push(o); });
    const inside = (x, z) => {
      const r = 1.35, cx = 1.45, cz = 1.45;
      return x >= -2.8 && x <= 2.8 && z >= -2.6 && z <= 2.8 && (x <= cx || z <= cz || (x - cx) ** 2 + (z - cz) ** 2 <= r * r);
    };
    return roots.reduce((sum, root) => {
      root.traverse(o => {
        if (!o.isMesh || o.isInstancedMesh || o.userData.canopyShadow) return;
        const p = o.geometry.attributes.position, Vec = o.position.constructor;
        for (let i = 0; i < p.count; i += Math.max(1, Math.floor(p.count / 400))) {
          const w = o.localToWorld(new Vec(p.getX(i), p.getY(i), p.getZ(i)));
          if (w.y > .8 && w.y < 7.55 && inside(w.x, w.z)) sum++;
        }
      });
      return sum;
    }, 0);
  });
  assert.equal(branchCrossings, 0, 'tree branches stay outside the building volume');

  const cameraBeforeTime = await page.evaluate(() => window.__JACARANDA__.camera.position.toArray());
  await page.getByRole('button', { name: '黄昏', exact: true }).click();
  await page.waitForTimeout(650);
  const cameraAfterTime = await page.evaluate(() => window.__JACARANDA__.camera.position.toArray());
  assert.ok(cameraBeforeTime.every((v, i) => Math.abs(v - cameraAfterTime[i]) < .001), 'time switch preserves camera');
  await page.waitForTimeout(3000);
  // Render both states in one task, so neither the camera nor the moving
  // flowers can account for the difference. Sample the visible street and
  // paving, rather than accepting a caster that only shadows itself.
  const duskShadows = await page.evaluate(() => {
    const { scene, camera, renderer } = window.__JACARANDA__;
    const casters = [];
    scene.traverse(object => { if (object.userData.canopyShadow) casters.push(object); });
    const original = casters.map(object => object.castShadow);
    const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const read = () => {
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    let on, off;
    try {
      on = read();
      casters.forEach(object => { object.castShadow = false; });
      off = read();
    } finally {
      casters.forEach((object, i) => { object.castShadow = original[i]; });
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);
    }
    let samples = 0, shadowedSamples = 0, maxRgbDelta = 0;
    const point = camera.position.clone();
    for (let x = -6.2; x <= 6.2; x += .15) for (let z = -6.2; z <= 6.2; z += .15) {
      // The foreground roads must show visible tree shadows, not just a
      // changed pixel hidden behind the building or on a distant canopy.
      const frontRoad = z >= 5.15 && x >= -5.8 && x <= 4.8;
      const rightRoad = x >= 5.15 && z >= -4.5 && z <= 4.5;
      if (!frontRoad && !rightRoad) continue;
      point.set(x, x > 4.99 || z > 4.99 ? .122 : .31, z).project(camera);
      const px = Math.floor((point.x + 1) * .5 * w), py = Math.floor((point.y + 1) * .5 * h);
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      const i = (py * w + px) * 4;
      const delta = off[i] + off[i + 1] + off[i + 2] - on[i] - on[i + 1] - on[i + 2];
      samples++;
      if (delta > 12) shadowedSamples++;
      maxRgbDelta = Math.max(maxRgbDelta, delta);
    }
    return { casters: casters.length, enabled: original.filter(Boolean).length, samples, shadowedSamples, maxRgbDelta };
  });
  assert.ok(duskShadows.enabled >= 7, 'each jacaranda crown contributes to the shadow map');
  assert.ok(duskShadows.shadowedSamples > 20, `dusk crowns visibly shadow the streets: ${JSON.stringify(duskShadows)}`);

  const beforeDrag = await page.evaluate(() => window.__JACARANDA__.camera.position.toArray());
  const geoBeforePress = await page.evaluate(() => window.__JACARANDA__.trees.map(t => t.flowerMesh.geometry.uuid));
  await page.mouse.move(930, 520); await page.mouse.down();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const geoDuringPress = await page.evaluate(() => window.__JACARANDA__.trees.map(t => t.flowerMesh.geometry.uuid));
  assert.deepEqual(geoDuringPress, geoBeforePress, 'pressing pointer does not swap flower geometry');
  await page.mouse.move(990, 550, { steps: 4 });
  const dragResponse = await page.evaluate(() => {
    const { renderer, camera, controls } = window.__JACARANDA__;
    const before = camera.position.clone();
    // Stay inside one task after a real pointerdown. No animation frame can
    // hide residual damping by gradually catching the camera up beforehand.
    renderer.domElement.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerType: 'mouse', pointerId: 1, buttons: 1, clientX: 1002, clientY: 554
    }));
    const immediate = camera.position.clone();
    for (let i = 0; i < 60; i++) controls.update();
    return { immediateMovement: immediate.distanceTo(before), residualMovement: camera.position.distanceTo(immediate) };
  });
  assert.ok(dragResponse.immediateMovement > .05 && dragResponse.residualMovement < .02,
    `the camera follows held-pointer motion without a delayed catch-up (${JSON.stringify(dragResponse)})`);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const geoDuringDrag = await page.evaluate(() => window.__JACARANDA__.trees.map(t => t.flowerMesh.geometry.uuid));
  assert.deepEqual(geoDuringDrag, geoBeforePress, 'dragging does not swap flower geometry or flash crowns');
  await page.mouse.move(1030, 570, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(150);
  const geoAfterRelease = await page.evaluate(() => window.__JACARANDA__.trees.map(t => t.flowerMesh.geometry.uuid));
  assert.deepEqual(geoAfterRelease, geoBeforePress, 'releasing pointer keeps flower geometry unchanged');
  const afterDrag = await page.evaluate(() => window.__JACARANDA__.camera.position.toArray());
  assert.ok(beforeDrag.some((v, i) => Math.abs(v - afterDrag[i]) > .2), 'drag rotates camera');

  const beforeZoom = await page.evaluate(() => window.__JACARANDA__.camera.position.distanceTo(window.__JACARANDA__.controls.target));
  await page.mouse.move(700, 500); await page.mouse.wheel(0, -450); await page.waitForTimeout(400);
  const afterZoom = await page.evaluate(() => window.__JACARANDA__.camera.position.distanceTo(window.__JACARANDA__.controls.target));
  assert.ok(Math.abs(beforeZoom - afterZoom) > .1, 'wheel zooms camera');

  await page.getByRole('button', { name: '复位视角' }).click();
  await page.waitForFunction(expected => window.__JACARANDA__.camera.position.toArray().every((value, i) => Math.abs(value - expected[i]) < .12), initial.camera, { timeout: 15000 });
  const afterReset = await inspect();
  assert.ok(afterReset.camera.every((value, i) => Math.abs(value - initial.camera[i]) < .12), `reset restores default camera: ${JSON.stringify(afterReset.camera)}`);

  await page.evaluate(() => window.__JACARANDA__.setTime('day'));
  await page.waitForTimeout(2000);
  const crown = await page.evaluate(() => window.__JACARANDA__.crownScreen(2));
  const petalsBefore = (await inspect()).activePetals;
  await page.mouse.click(crown.x, crown.y);
  await page.waitForTimeout(120);
  const petalsAfter = (await inspect()).activePetals;
  assert.ok(petalsAfter > petalsBefore, 'clicking a crown releases a petal fall');

  await page.evaluate(() => { for (let i = 0; i < 50; i++) window.__JACARANDA__.controls.update(); });
  const cameraBeforePoster = await page.evaluate(() => window.__JACARANDA__.camera.position.toArray());
  const poster = await page.evaluate(() => window.__JACARANDA__.posterScreen());
  await page.mouse.click(poster.x, poster.y);
  await page.waitForFunction(() => window.__JACARANDA__.sydneyWindow.isOpen(), null, { timeout: 10000 });
  assert.equal(await page.locator('#sydney-modal').getAttribute('aria-hidden'), 'false');
  await page.waitForFunction(() => ['.masthead', '.intro', '.time-panel', '.view-tools', 'footer'].every(selector => Number(getComputedStyle(document.querySelector(selector)).opacity) < .02));
  await page.waitForFunction(() => window.__JACARANDA__.inspect().postcardBackdropCached);
  const postcardFlowers = await page.evaluate(() => window.__JACARANDA__.sydneyWindow.inspect());
  assert.ok(postcardFlowers.flowers > 1000 && postcardFlowers.buds > 0, 'the postcard has richer flowering panicles and visible buds');
  const postcardCache = await page.evaluate(async () => {
    const { renderer } = window.__JACARANDA__;
    const before = renderer.info.render.frame;
    for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
    const backdrop = document.querySelector('.postcard-street-backdrop');
    return {
      renders: renderer.info.render.frame - before,
      cached: window.__JACARANDA__.inspect().postcardBackdropCached,
      canvasVisible: !!backdrop && getComputedStyle(backdrop).display !== 'none'
        && backdrop.width === renderer.domElement.width && backdrop.height === renderer.domElement.height
    };
  });
  assert.ok(postcardCache.cached && postcardCache.canvasVisible && postcardCache.renders <= 1,
    `the unchanged street is cached while the postcard animates (${JSON.stringify(postcardCache)})`);
  const backdrop = await page.evaluate(() => {
    const shade = getComputedStyle(document.querySelector('.sydney-shade'));
    const layers = shade.backgroundImage.split(/\),\s*(?=(?:linear|radial)-gradient)/);
    const minimumLayerAlphas = layers.map(layer => Math.min(...[...layer.matchAll(/rgba?\(([^)]+)\)/g)].map(match => {
      const components = match[1].split(',').map(Number);
      return components[3] ?? 1;
    })));
    // An opaque gradient anywhere in the stack would obscure the house,
    // even when another decorative layer has transparent color stops.
    const minimumCombinedAlpha = 1 - minimumLayerAlphas.reduce((remaining, alpha) => remaining * (1 - alpha), 1);
    return {
      minimumLayerAlphas, minimumCombinedAlpha,
      blur: Number(shade.backdropFilter.match(/blur\(([\d.]+)px\)/)?.[1] || 0),
      sceneOpacity: Number(getComputedStyle(document.querySelector('#scene')).opacity),
      clearAlpha: window.__JACARANDA__.sydneyWindow.inspect().clearAlpha
    };
  });
  assert.ok(backdrop.minimumCombinedAlpha < .8, 'the postcard backdrop lets the street show through');
  assert.ok(backdrop.blur <= 4, 'the house stays recognizable through the backdrop');
  assert.equal(backdrop.sceneOpacity, 1, 'the house backdrop layer remains visible');
  assert.equal(backdrop.clearAlpha, 0, 'the separate postcard canvas clears to transparency');

  const frameClearance = await page.evaluate(() => {
    const { frameBounds, branchVertices, branchPosition, sway } = window.__JACARANDA__.sydneyWindow.geometrySnapshot();
    const front = Math.max(...frameBounds.map(bound => bound.max[2]));
    const cos = Math.cos(sway.x), sin = Math.sin(sway.x);
    let clearance = Infinity;
    for (let i = 0; i < branchVertices.length; i += 3) {
      const x = branchVertices[i], y = branchVertices[i + 1], z = branchVertices[i + 2];
      // Any Z sway preserves the XY radius. This bound therefore covers
      // every sway phase, as well as all shared frame/branch drag rotations.
      const nearestZ = branchPosition[2] + z * cos - Math.hypot(x, y) * sin;
      clearance = Math.min(clearance, nearestZ - front);
    }
    return { vertices: branchVertices.length / 3, clearance };
  });
  assert.ok(frameClearance.vertices > 1000 && frameClearance.clearance > .005, `flowers and wood remain in front of the frame throughout sway: ${JSON.stringify(frameClearance)}`);

  const frameBeforeResize = await page.evaluate(() => window.__JACARANDA__.renderer.info.render.frame);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.waitForFunction(before => {
    const { renderer } = window.__JACARANDA__;
    return renderer.info.render.frame > before && renderer.domElement.width === Math.round(innerWidth * renderer.getPixelRatio());
  }, frameBeforeResize);
  // A composited screenshot verifies the actual visible backdrop, including
  // filters and transparency. It also works when the covered scene is
  // deliberately rendered less often and WebGL discards its drawing buffer.
  // This scene is intentionally detail-heavy. Software-rendered CI needs a
  // longer compositor timeout than Playwright's 30s screenshot default.
  const withHouse = await page.screenshot({ timeout: 60000 });
  await page.locator('#scene').evaluate(element => { element.style.visibility = 'hidden'; });
  let withoutHouse;
  try { withoutHouse = await page.screenshot({ timeout: 60000 }); }
  finally { await page.locator('#scene').evaluate(element => { element.style.removeProperty('visibility'); }); }
  const backgroundAfterResize = await page.evaluate(async ({ withHouse, withoutHouse }) => {
    const read = async source => {
      const image = new Image(); image.src = `data:image/png;base64,${source}`; await image.decode();
      const copy = document.createElement('canvas'); copy.width = 192; copy.height = 128;
      const context = copy.getContext('2d'); context.drawImage(image, 0, 0, copy.width, copy.height);
      return context.getImageData(0, 0, copy.width, copy.height).data;
    };
    const a = await read(withHouse), b = await read(withoutHouse);
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) changed++;
    }
    return changed;
  }, { withHouse: withHouse.toString('base64'), withoutHouse: withoutHouse.toString('base64') });
  assert.ok(backgroundAfterResize > 300, 'resizing an open postcard preserves the visible house through the overlay');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(200);
  const stage = await page.locator('#sydney-stage').boundingBox();
  await page.mouse.move(stage.x + stage.width * .55, stage.y + stage.height * .5);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * .66, stage.y + stage.height * .46, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const windowBefore = await page.evaluate(() => window.__JACARANDA__.sydneyWindow.inspect());
  assert.ok(Math.abs(windowBefore.rotation[1]) > .01, 'souvenir window can be rotated');
  const flowerPoint = await page.evaluate(() => window.__JACARANDA__.sydneyWindow.flowerScreen(12));
  await page.mouse.click(flowerPoint.x, flowerPoint.y);
  await page.waitForTimeout(180);
  const windowAfter = await page.evaluate(() => window.__JACARANDA__.sydneyWindow.inspect());
  assert.ok(windowAfter.activePetals > windowBefore.activePetals, 'touching a branch releases petals inside the window');
  const frameBeforeClose = await page.evaluate(() => window.__JACARANDA__.renderer.info.render.frame);
  await page.keyboard.press('Escape');
  await page.waitForFunction(before => {
    const api = window.__JACARANDA__;
    const backdrop = document.querySelector('.postcard-street-backdrop');
    return !api.sydneyWindow.isOpen() && !api.inspect().postcardBackdropCached
      && getComputedStyle(api.renderer.domElement).visibility !== 'hidden'
      && (!backdrop || getComputedStyle(backdrop).display === 'none')
      && api.renderer.info.render.frame > before;
  }, frameBeforeClose);
  assert.equal(await page.evaluate(() => window.__JACARANDA__.sydneyWindow.isOpen()), false, 'Escape closes the souvenir window');
  const cameraAfterPoster = await page.evaluate(() => window.__JACARANDA__.camera.position.toArray());
  assert.ok(cameraBeforePoster.every((v, i) => Math.abs(v - cameraAfterPoster[i]) < .03), 'closing the window keeps the street camera');
  assert.equal(await page.evaluate(() => document.querySelector('#app').classList.contains('postcard-open')), false, 'closing the postcard restores the page state');
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.time-panel')).opacity) > .98);

  await page.getByRole('button', { name: '夜晚', exact: true }).click();
  await page.waitForTimeout(2000);
  const night = await inspect();
  assert.equal(night.time, 'night');
  assert.equal(errors.length, 0, 'no runtime errors after interaction');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobile = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, controls: !!document.querySelector('.time-options') }));
  assert.ok(mobile.w <= mobile.cw + 1 && mobile.controls, 'mobile layout does not overflow');
  assert.deepEqual(shaderErrors, [], 'no WebGL shader errors after rendering and interaction');
  console.log(JSON.stringify({ ok: true, initial, barkPixels, duskShadows, dragResponse, postcardFlowers, postcardCache, frameClearance, backdrop, backgroundAfterResize, petalsBefore, petalsAfter, mobile }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
