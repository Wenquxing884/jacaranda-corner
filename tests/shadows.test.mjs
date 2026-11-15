import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const existingURL = process.env.JACARANDA_URL;
const localURL = 'http://127.0.0.1:5175/';
const server = existingURL ? null : await createServer({
  root: projectRoot,
  configLoader: 'native',
  cacheDir: '.tmp/vite-test-cache',
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    watch: { ignored: ['**/.tmp/**', '**/*.tmpdir/**'] }
  },
  logLevel: 'error'
});
await server?.listen();

const expectedLight = {
  day: { intensity: .82, radius: 2 },
  dusk: { intensity: .78, radius: 3.2 },
  night: { intensity: .26, radius: 2.8 }
};
const cameraTolerance = .001;
let browser;

function cameraDiff(a, b) {
  return Math.max(
    ...a.position.map((value, i) => Math.abs(value - b.position[i])),
    ...a.target.map((value, i) => Math.abs(value - b.target[i]))
  );
}

async function readCamera(page) {
  return page.evaluate(() => {
    const { camera, controls } = window.__JACARANDA__;
    return {
      position: camera.position.toArray(),
      target: controls.target.toArray()
    };
  });
}

async function settleTime(page, time) {
  await page.evaluate(value => window.__JACARANDA__.setTime(value), time);
  await page.waitForFunction(expected => {
    const state = window.__JACARANDA__.inspect();
    return state.time === expected && state.transition >= .999;
  }, time, { timeout: 10000 });
  await page.waitForTimeout(120);
}

async function transitionSamples(page, time) {
  return page.evaluate(async target => {
    const api = window.__JACARANDA__;
    const sun = api.scene.getObjectByName('sun-moon-light');
    if (!sun) throw new Error('sun-moon-light is missing');
    const samples = [];
    const started = performance.now();
    api.setTime(target);
    await new Promise(resolveTransition => {
      const tick = now => {
        const state = api.inspect();
        samples.push({
          t: now - started,
          intensity: sun.shadow.intensity,
          radius: sun.shadow.radius,
          transition: state.transition,
          camera: api.camera.position.toArray(),
          target: api.controls.target.toArray()
        });
        if ((state.time === target && state.transition >= .999) || now - started > 7000) {
          resolveTransition();
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
    return samples;
  }, time);
}

async function captureTreeShadowPixels(page) {
  return page.evaluate(() => {
    const api = window.__JACARANDA__;
    const { scene, camera, renderer, trees } = api;
    const sun = scene.getObjectByName('sun-moon-light');
    const catcher = scene.getObjectByName('ground-shadow-catcher');
    if (!sun) throw new Error('sun-moon-light is missing');
    if (!catcher) throw new Error('ground-shadow-catcher is missing');

    // Find the actual tree casters from the live hierarchy. This deliberately
    // excludes flowers, buds, and any decorative full-scene shadow decals.
    const casters = [];
    const perTree = [];
    for (const tree of trees) {
      let count = 0;
      tree.root.updateWorldMatrix(true, true);
      tree.root.traverse(object => {
        if (!object.isMesh || !object.castShadow) return;
        casters.push(object);
        count++;
      });
      perTree.push(count);
    }

    const original = casters.map(object => object.castShadow);
    const gl = renderer.getContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const read = () => {
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };

    let withTrees;
    let withoutTrees;
    try {
      withTrees = read();
      casters.forEach(object => { object.castShadow = false; });
      withoutTrees = read();
    } finally {
      casters.forEach((object, i) => { object.castShadow = original[i]; });
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);
    }

    const catcherWorld = catcher.getWorldPosition(camera.position.clone());
    const point = camera.position.clone();
    const floorY = catcherWorld.y;
    const baseHalf = 6.7;
    const outsideMargin = .28;
    const outsideHalf = baseHalf + outsideMargin;
    const sampleLimit = 18;
    const sampleStep = width < 1000 ? .18 : .14;
    const seenPixels = new Set();
    let sampledPoints = 0;
    let shadowedPixels = 0;
    let outsideX = 0;
    let outsideZ = 0;
    let maxAlphaDelta = 0;
    let maxRgbDelta = 0;
    let alphaSum = 0;
    let weightedX = 0;
    let weightedZ = 0;
    let weightedScreenX = 0;
    let weightedScreenY = 0;
    let weightSum = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const examples = [];

    for (let x = -sampleLimit; x <= sampleLimit; x += sampleStep) {
      for (let z = -sampleLimit; z <= sampleLimit; z += sampleStep) {
        if (Math.abs(x) <= outsideHalf && Math.abs(z) <= outsideHalf) continue;
        sampledPoints++;
        point.set(x, floorY, z).project(camera);
        if (point.x < -1 || point.x > 1 || point.y < -1 || point.y > 1 || point.z < -1 || point.z > 1) continue;
        const px = Math.floor((point.x + 1) * .5 * width);
        const py = Math.floor((point.y + 1) * .5 * height);
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const pixel = py * width + px;
        if (seenPixels.has(pixel)) continue;
        seenPixels.add(pixel);

        const i = pixel * 4;
        const alphaDelta = Math.abs(withTrees[i + 3] - withoutTrees[i + 3]);
        const rgbDelta =
          Math.abs(withTrees[i] - withoutTrees[i]) +
          Math.abs(withTrees[i + 1] - withoutTrees[i + 1]) +
          Math.abs(withTrees[i + 2] - withoutTrees[i + 2]);
        maxAlphaDelta = Math.max(maxAlphaDelta, alphaDelta);
        maxRgbDelta = Math.max(maxRgbDelta, rgbDelta);
        // Outside the plinth the ShadowMaterial catcher is transparent. Only
        // alpha proves that the sampled floor point itself is visible; RGB on
        // an opaque object can otherwise create a false positive.
        if (alphaDelta < 2) continue;

        const weight = Math.max(alphaDelta, rgbDelta / 3);
        shadowedPixels++;
        alphaSum += alphaDelta;
        weightSum += weight;
        weightedX += x * weight;
        weightedZ += z * weight;
        weightedScreenX += px * weight;
        weightedScreenY += py * weight;
        if (Math.abs(x) > outsideHalf) outsideX++;
        if (Math.abs(z) > outsideHalf) outsideZ++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
        if (examples.length < 8) examples.push({ x, z, px, py, alphaDelta, rgbDelta });
      }
    }

    return {
      casters: casters.length,
      perTree,
      sampledPoints,
      shadowedPixels,
      outsideX,
      outsideZ,
      maxAlphaDelta,
      maxRgbDelta,
      meanAlphaDelta: shadowedPixels ? alphaSum / shadowedPixels : 0,
      worldCentroid: shadowedPixels
        ? [weightedX / weightSum, weightedZ / weightSum]
        : null,
      screenCentroid: shadowedPixels
        ? [weightedScreenX / weightSum, weightedScreenY / weightSum]
        : null,
      worldBounds: shadowedPixels ? { minX, maxX, minZ, maxZ } : null,
      examples
    };
  });
}

try {
  browser = await chromium.launch({
    channel: process.env.JACARANDA_CHANNEL || 'chrome',
    headless: true,
    args: [
      `--use-angle=${process.env.JACARANDA_ANGLE || 'd3d11'}`,
      '--allow-file-access-from-files'
    ]
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(existingURL || localURL);
  await page.waitForFunction(() => window.__JACARANDA__?.ready, null, { timeout: 60000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__JACARANDA__.resetCamera(true));
  await page.waitForTimeout(200);

  const sceneContract = await page.evaluate(() => {
    const api = window.__JACARANDA__;
    const sun = api.scene.getObjectByName('sun-moon-light');
    const catcher = api.scene.getObjectByName('ground-shadow-catcher');
    const fakeShade = api.scene.getObjectByName('tree-contact-shadows');
    const catcherWorld = catcher?.getWorldPosition(api.camera.position.clone());
    return {
      sun: sun ? {
        name: sun.name,
        intensity: sun.shadow.intensity,
        radius: sun.shadow.radius,
        castShadow: sun.castShadow,
        mapWidth: sun.shadow.mapSize.x,
        mapHeight: sun.shadow.mapSize.y
      } : null,
      catcher: catcher ? {
        name: catcher.name,
        shadowCatcher: catcher.userData.shadowCatcher === true,
        isShadowMaterial: catcher.material?.isShadowMaterial === true,
        receiveShadow: catcher.receiveShadow,
        y: catcherWorld.y,
        width: catcher.geometry?.parameters?.width,
        height: catcher.geometry?.parameters?.height
      } : null,
      shadowMapType: api.renderer.shadowMap.type,
      fakeShade: Boolean(fakeShade),
      treeCount: api.trees.length
    };
  });

  assert.equal(sceneContract.shadowMapType, 1, 'renderer uses PCFShadowMap so shadow.radius is effective');
  assert.ok(sceneContract.sun, 'sun-moon-light exists');
  assert.equal(sceneContract.sun.name, 'sun-moon-light');
  assert.equal(sceneContract.sun.castShadow, true, 'the day/dusk/night light casts real shadows');
  assert.ok(sceneContract.sun.radius > 1, 'PCF shadow radius is greater than one texel');
  assert.ok(sceneContract.sun.mapWidth >= 1024 && sceneContract.sun.mapHeight >= 1024, 'shadow map has usable resolution');
  assert.ok(sceneContract.catcher, 'ground-shadow-catcher exists');
  assert.equal(sceneContract.catcher.name, 'ground-shadow-catcher');
  assert.equal(sceneContract.catcher.shadowCatcher, true, 'catcher has shadowCatcher userData');
  assert.equal(sceneContract.catcher.isShadowMaterial, true, 'catcher uses ShadowMaterial');
  assert.equal(sceneContract.catcher.receiveShadow, true, 'catcher receives real shadows');
  assert.ok(sceneContract.catcher.width >= 40 && sceneContract.catcher.height >= 40, 'catcher extends well beyond the 13.4m plinth');
  assert.ok(Math.abs(sceneContract.catcher.y + .345) < .002, 'catcher sits at the planned floor height');
  assert.equal(sceneContract.fakeShade, false, 'the full-scene tree-contact-shadows decal is gone');
  assert.equal(sceneContract.treeCount, 7, 'seven real jacaranda trees remain');

  const initialCamera = await readCamera(page);
  const periodResults = {};
  const transitionResults = {};

  // Settle each authored period, prove its live tree casters change pixels on
  // the floor beyond the plinth, and sample its intensity/radius.
  for (const time of ['day', 'dusk', 'night']) {
    await settleTime(page, time);
    const beforeMeasurementCamera = await readCamera(page);
    const state = await page.evaluate(() => {
      const api = window.__JACARANDA__;
      const sun = api.scene.getObjectByName('sun-moon-light');
      return {
        intensity: sun.shadow.intensity,
        radius: sun.shadow.radius,
        inspect: api.inspect()
      };
    });
    periodResults[time] = {
      ...await captureTreeShadowPixels(page),
      intensity: state.intensity,
      radius: state.radius,
      camera: beforeMeasurementCamera
    };
    assert.ok(
      Math.abs(periodResults[time].intensity - expectedLight[time].intensity) < .035,
      `${time} shadow intensity matches the authored preset: ${periodResults[time].intensity}`
    );
    assert.ok(
      Math.abs(periodResults[time].radius - expectedLight[time].radius) < .12,
      `${time} shadow radius matches the authored preset: ${periodResults[time].radius}`
    );
    assert.ok(periodResults[time].casters >= 14, `${time} includes at least two live casters per tree`);
    assert.ok(
      periodResults[time].perTree.every(count => count >= 2),
      `${time} every tree contributes real casters: ${JSON.stringify(periodResults[time].perTree)}`
    );
    assert.ok(
      periodResults[time].shadowedPixels > 8,
      `${time} tree casters visibly change floor pixels beyond the plinth`
    );
    assert.ok(
      periodResults[time].outsideX > 0 || periodResults[time].outsideZ > 0,
      `${time} shadows cross the +/-6.7m footprint`
    );
    assert.ok(
      periodResults[time].maxAlphaDelta >= 2,
      `${time} shadow evidence survives transparent-composite alpha`
    );
    assert.ok(
      cameraDiff(initialCamera, beforeMeasurementCamera) < cameraTolerance,
      `${time} transition leaves the camera fixed`
    );
  }

  // Sequential transitions provide a clean monotonic signal for continuity.
  for (const time of ['dusk', 'night', 'day']) {
    const samples = await transitionSamples(page, time);
    transitionResults[time] = samples;
    assert.ok(samples.length >= 20, `${time} transition produced a continuous sample timeline`);
    const finite = samples.every(sample =>
      Number.isFinite(sample.intensity) &&
      Number.isFinite(sample.radius) &&
      sample.intensity >= 0 &&
      sample.intensity <= 1.05 &&
      sample.radius > 0
    );
    assert.ok(finite, `${time} transition keeps finite shadow uniforms`);
    let maxIntensityStep = 0;
    let maxRadiusStep = 0;
    for (let i = 1; i < samples.length; i++) {
      maxIntensityStep = Math.max(maxIntensityStep, Math.abs(samples[i].intensity - samples[i - 1].intensity));
      maxRadiusStep = Math.max(maxRadiusStep, Math.abs(samples[i].radius - samples[i - 1].radius));
      assert.ok(
        cameraDiff(
          { position: samples[i - 1].camera, target: samples[i - 1].target },
          { position: samples[i].camera, target: samples[i].target }
        ) < cameraTolerance,
        `${time} transition frame ${i} does not move the camera`
      );
    }
    assert.ok(maxIntensityStep < .18, `${time} shadow intensity changes continuously (max ${maxIntensityStep})`);
    assert.ok(maxRadiusStep < .55, `${time} shadow radius changes continuously (max ${maxRadiusStep})`);
    const final = samples.at(-1);
    assert.ok(
      Math.abs(final.intensity - expectedLight[time].intensity) < .04,
      `${time} transition reaches its target intensity: ${final.intensity}`
    );
  }

  // Verify the three periods really project tree casters to different places,
  // not merely that three numeric presets exist.
  const day = periodResults.day;
  const dusk = periodResults.dusk;
  const night = periodResults.night;
  const screenShift = (a, b) => Math.hypot(
    a.screenCentroid[0] - b.screenCentroid[0],
    a.screenCentroid[1] - b.screenCentroid[1]
  );
  const worldShift = (a, b) => Math.hypot(
    a.worldCentroid[0] - b.worldCentroid[0],
    a.worldCentroid[1] - b.worldCentroid[1]
  );
  assert.ok(
    screenShift(day, dusk) > 3 || worldShift(day, dusk) > .25,
    `day and dusk project tree shadows differently: screen=${screenShift(day, dusk)}, world=${worldShift(day, dusk)}`
  );
  assert.ok(
    screenShift(dusk, night) > 3 || worldShift(dusk, night) > .25,
    `dusk and night project tree shadows differently: screen=${screenShift(dusk, night)}, world=${worldShift(dusk, night)}`
  );
  assert.ok(
    night.meanAlphaDelta < day.meanAlphaDelta * .88,
    `night shadow is softer than day (${night.meanAlphaDelta} vs ${day.meanAlphaDelta})`
  );
  assert.ok(
    night.meanAlphaDelta < dusk.meanAlphaDelta * .92,
    `night shadow is softer than dusk (${night.meanAlphaDelta} vs ${dusk.meanAlphaDelta})`
  );

  // Rapid UI interrupts must preserve the camera and compose continuously.
  await settleTime(page, 'day');
  const rapidCamera = await readCamera(page);
  const traceStart = await page.evaluate(() => {
    const api = window.__JACARANDA__;
    const sun = api.scene.getObjectByName('sun-moon-light');
    window.__SHADOW_TRACE__ = [];
    window.__SHADOW_TRACE_STOP__ = false;
    const tick = () => {
      window.__SHADOW_TRACE__.push({
        t: performance.now(),
        intensity: sun.shadow.intensity,
        radius: sun.shadow.radius,
        transition: api.inspect().transition,
        position: api.camera.position.toArray(),
        target: api.controls.target.toArray()
      });
      if (!window.__SHADOW_TRACE_STOP__) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return { intensity: sun.shadow.intensity, radius: sun.shadow.radius };
  });
  const cutoffButtons = [
    ['黄昏', 230],
    ['夜晚', 170],
    ['黄昏', 230],
    ['白天', 160],
    ['夜晚', 210],
    ['白天', 160]
  ];
  for (const [label, pause] of cutoffButtons) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(pause);
    assert.ok(
      cameraDiff(rapidCamera, await readCamera(page)) < cameraTolerance,
      `rapid ${label} interrupt keeps the camera fixed`
    );
  }
  await page.waitForTimeout(3200);
  const rapidTrace = await page.evaluate(() => {
    window.__SHADOW_TRACE_STOP__ = true;
    return window.__SHADOW_TRACE__;
  });
  assert.ok(rapidTrace.length >= 25, 'rapid interrupts produce a usable animation trace');
  let rapidMaxIntensityStep = 0;
  let rapidMaxRadiusStep = 0;
  for (let i = 1; i < rapidTrace.length; i++) {
    rapidMaxIntensityStep = Math.max(rapidMaxIntensityStep, Math.abs(rapidTrace[i].intensity - rapidTrace[i - 1].intensity));
    rapidMaxRadiusStep = Math.max(rapidMaxRadiusStep, Math.abs(rapidTrace[i].radius - rapidTrace[i - 1].radius));
    assert.ok(
      cameraDiff(
        { position: rapidTrace[i - 1].position, target: rapidTrace[i - 1].target },
        { position: rapidTrace[i].position, target: rapidTrace[i].target }
      ) < cameraTolerance,
      `rapid interrupt trace frame ${i} keeps the camera fixed`
    );
  }
  assert.ok(rapidMaxIntensityStep < .18, `rapid interrupts do not jump shadow intensity (max ${rapidMaxIntensityStep})`);
  assert.ok(rapidMaxRadiusStep < .55, `rapid interrupts do not jump shadow radius (max ${rapidMaxRadiusStep})`);
  assert.ok(rapidTrace.every(sample => Number.isFinite(sample.intensity) && Number.isFinite(sample.radius)));
  assert.ok(cameraDiff(rapidCamera, await readCamera(page)) < cameraTolerance, 'camera is unchanged after rapid interrupts settle');
  assert.notEqual(traceStart.intensity, undefined);

  const gpu = await page.evaluate(() => {
    const api = window.__JACARANDA__;
    const gl = api.renderer.getContext();
    api.renderer.render(api.scene, api.camera);
    const error = gl.getError();
    return {
      error,
      contextLost: gl.isContextLost(),
      programs: api.renderer.info.programs?.length ?? 0
    };
  });
  assert.equal(gpu.contextLost, false, 'WebGL context remains alive through all shadow transitions');
  assert.equal(gpu.error, 0, 'WebGL reports no shader/runtime error');
  assert.equal(pageErrors.length, 0, `no page runtime errors: ${pageErrors.join(' | ')}`);
  assert.equal(consoleErrors.length, 0, `no shader or console errors: ${consoleErrors.join(' | ')}`);

  console.log(JSON.stringify({
    ok: true,
    scene: sceneContract,
    periods: Object.fromEntries(Object.entries(periodResults).map(([time, result]) => [time, {
      casters: result.casters,
      perTree: result.perTree,
      shadowedPixels: result.shadowedPixels,
      outsideX: result.outsideX,
      outsideZ: result.outsideZ,
      maxAlphaDelta: result.maxAlphaDelta,
      meanAlphaDelta: Number(result.meanAlphaDelta.toFixed(3)),
      worldCentroid: result.worldCentroid?.map(value => Number(value.toFixed(3))),
      screenCentroid: result.screenCentroid?.map(value => Number(value.toFixed(2))),
      bounds: result.worldBounds,
      intensity: result.intensity,
      radius: result.radius,
      examples: result.examples
    }])),
    transitions: Object.fromEntries(Object.entries(transitionResults).map(([time, samples]) => [time, {
      frames: samples.length,
      start: [samples[0].intensity, samples[0].radius],
      end: [samples.at(-1).intensity, samples.at(-1).radius]
    }])),
    rapid: {
      frames: rapidTrace.length,
      maxIntensityStep: rapidMaxIntensityStep,
      maxRadiusStep: rapidMaxRadiusStep
    },
    gpu,
    errors: { pageErrors, consoleErrors }
  }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
