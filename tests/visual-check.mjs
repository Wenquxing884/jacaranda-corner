import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('screenshots', { recursive: true });
const angle = process.env.JACARANDA_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'swiftshader');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--use-angle=${angle}`, '--allow-file-access-from-files'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(resolve('jacaranda-corner.html')).href);
  await page.waitForFunction(() => window.__JACARANDA__?.inspect().frames >= 2, null, { timeout: 60000 });
  // Keep high-quality previews below the user's current 20 MB image limit.
  // Only reduce JPEG quality when needed, retaining 2 MB of safety headroom.
  const imageLimit = 20_000_000, previewTarget = 18_000_000;
  const capture = async (path, options = {}) => {
    let image, quality;
    for (quality of [96, 92, 88, 80, 72]) {
      image = await page.screenshot({ ...options, type: 'jpeg', quality, animations: 'disabled', timeout: 60000 });
      if (image.length <= previewTarget) break;
    }
    if (image.length >= imageLimit || image.length > previewTarget) {
      throw new Error(`Preview exceeds the ${previewTarget}-byte budget: ${path} (${image.length} bytes)`);
    }
    await writeFile(path, image);
    console.log(JSON.stringify({ image: path, bytes: image.length, quality }));
  };
  const waitForTime = time => page.waitForFunction(expected => {
    const state = window.__JACARANDA__.inspect();
    return state.time === expected && state.transition >= .999;
  }, time, { timeout: 15000 });
  await capture('screenshots/final-day.jpg');
  const originalView = await page.evaluate(() => {
    const app = window.__JACARANDA__;
    const original = { camera: app.camera.position.toArray(), target: app.controls.target.toArray(), minDistance: app.controls.minDistance };
    app.controls.minDistance = 4;
    app.controls.target.set(4.21, 2.8, 3.34);
    app.view(8.8, 4.3, 9.8);
    return original;
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await capture('screenshots/final-bark-detail.jpg', { clip: { x: 760, y: 160, width: 330, height: 825 } });
  await page.evaluate(original => {
    const app = window.__JACARANDA__;
    app.controls.minDistance = original.minDistance;
    app.controls.target.set(...original.target);
    app.view(...original.camera);
  }, originalView);
  await page.evaluate(() => window.__JACARANDA__.sydneyWindow.open());
  await page.waitForTimeout(1600);
  await capture('screenshots/final-window.jpg');
  await page.evaluate(() => window.__JACARANDA__.sydneyWindow.close());
  await page.waitForTimeout(500);
  for (const time of ['dusk', 'night']) {
    await page.evaluate(time => window.__JACARANDA__.setTime(time), time);
    await waitForTime(time);
    await capture(`screenshots/final-${time}.jpg`);
  }
  const lanternView = await page.evaluate(() => {
    const app = window.__JACARANDA__;
    const original = { camera: app.camera.position.toArray(), target: app.controls.target.toArray(), minDistance: app.controls.minDistance };
    app.controls.minDistance = 4;
    app.controls.target.set(2.75, 2.65, 2.35);
    app.view(7.6, 3.8, 9.7);
    return original;
  });
  try {
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await capture('screenshots/final-lantern-night.jpg', { clip: { x: 580, y: 180, width: 670, height: 700 } });
  } finally {
    await page.evaluate(original => {
      const app = window.__JACARANDA__;
      app.controls.minDistance = original.minDistance;
      app.controls.target.set(...original.target);
      app.view(...original.camera);
    }, lanternView);
  }
  await page.evaluate(() => {
    const scene = window.__JACARANDA__;
    scene.controls.target.set(0, 4.2, 0);
    scene.view(-18, 12.5, -21);
  });
  await page.waitForTimeout(500);
  await capture('screenshots/final-rear.jpg');
  await page.evaluate(() => window.__JACARANDA__.setTime('day'));
  await waitForTime('day');
  await capture('screenshots/final-rear-day.jpg');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.__JACARANDA__.camera.aspect === innerWidth / innerHeight);
  await page.evaluate(() => {
    window.__JACARANDA__.setTime('day');
    window.__JACARANDA__.resetCamera(true);
  });
  await waitForTime('day');
  await capture('screenshots/final-mobile.jpg');
  await page.evaluate(() => window.__JACARANDA__.sydneyWindow.open());
  await page.waitForTimeout(1400);
  await capture('screenshots/final-window-mobile.jpg');
  console.log(JSON.stringify({ errors, scene: await page.evaluate(() => window.__JACARANDA__.inspect()) }, null, 2));
} finally {
  await browser.close();
}
