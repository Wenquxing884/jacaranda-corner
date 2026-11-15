import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.env.JACARANDA_OFFLINE === '1', existingURL = process.env.JACARANDA_URL;
const server = offline || existingURL ? null : await createServer({
  root: projectRoot, configLoader: 'native', cacheDir: '.tmp/vite-test-cache',
  server: { host: '127.0.0.1', port: 5178, strictPort: true, watch: { ignored: ['**/.tmp/**', '**/*.tmpdir/**'] } },
  logLevel: 'error'
});
await server?.listen();
const targetURL = existingURL || (offline ? pathToFileURL(resolve(projectRoot, 'jacaranda-corner.html')).href : 'http://127.0.0.1:5178/');
const angle = process.env.JACARANDA_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'swiftshader');
let browser;

async function sliderState(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.time-options'), style = getComputedStyle(panel, '::before');
    const panelRect = panel.getBoundingClientRect(), buttons = [...panel.querySelectorAll('.time-button')];
    const x = new DOMMatrixReadOnly(style.transform).m41, width = parseFloat(style.width);
    const left = panelRect.left + parseFloat(getComputedStyle(panel).borderLeftWidth) + parseFloat(style.left) + x;
    return {
      x, width, left, duration: style.transitionDuration, property: style.transitionProperty,
      pressed: buttons.filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.time),
      buttons: buttons.map(button => ({ time: button.dataset.time, left: button.getBoundingClientRect().left, width: button.getBoundingClientRect().width,
        background: getComputedStyle(button).backgroundColor })),
      camera: window.__JACARANDA__.camera.position.toArray()
    };
  });
}

async function settledSlider(page, index) {
  await page.waitForFunction(expected => {
    const style = getComputedStyle(document.querySelector('.time-options'), '::before');
    return Math.abs(new DOMMatrixReadOnly(style.transform).m41 - parseFloat(style.width) * expected) < .1;
  }, index, { timeout: 10000 });
  return sliderState(page);
}

function aligned(state, index, label) {
  assert.ok(Math.abs(state.left - state.buttons[index].left) < 2 && Math.abs(state.width - state.buttons[index].width) < 2,
    `${label}: the shared pill lines up with its button (${JSON.stringify(state)})`);
  assert.deepEqual(state.pressed, [['day', 'dusk', 'night'][index]], `${label}: exactly one accessible pressed button`);
  assert.ok(state.buttons.every(button => button.background === 'rgba(0, 0, 0, 0)'), `${label}: individual buttons never paint duplicate selection backgrounds`);
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--use-angle=${angle}`, '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(targetURL);
  await page.waitForFunction(() => window.__JACARANDA__?.inspect().frames >= 2, null, { timeout: 60000 });
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#loading')).opacity) === 0);
  const initial = await sliderState(page);
  aligned(initial, 0, 'initial day');

  // Trigger the real click handler, then sample its actual CSS transition at
  // 120 ms using WAAPI. Seeking avoids a busy WebGL frame skipping the whole
  // intermediate observation while still testing the browser's interpolation.
  const intermediate = await page.evaluate(() => {
    const panel = document.querySelector('.time-options');
    const read = () => new DOMMatrixReadOnly(getComputedStyle(panel, '::before').transform).m41;
    const before = read();
    panel.querySelector('[data-time="dusk"]').click();
    read();
    const animation = panel.getAnimations({ subtree: true }).find(item => item.transitionProperty === 'transform' && item.effect?.target === panel);
    if (!animation) throw new Error('No shared-pill transform transition was created');
    const duration = Number(animation.effect.getTiming().duration);
    animation.pause();
    animation.currentTime = Math.min(120, duration / 2);
    const middle = read(), width = parseFloat(getComputedStyle(panel, '::before').width);
    animation.play();
    return { before, middle, width, duration };
  });
  assert.ok(intermediate.duration >= 200 && intermediate.duration <= 600, 'selection has a short perceptible slide');
  assert.ok(intermediate.middle > intermediate.before + 1 && intermediate.middle < intermediate.width - 1, 'dusk selection passes through an intermediate position');
  const dusk = await settledSlider(page, 1);
  aligned(dusk, 1, 'dusk');
  await page.getByRole('button', { name: '夜晚', exact: true }).click();
  const night = await settledSlider(page, 2);
  aligned(night, 2, 'night');

  const reversal = await page.evaluate(() => {
    const panel = document.querySelector('.time-options');
    const read = () => new DOMMatrixReadOnly(getComputedStyle(panel, '::before').transform).m41;
    read();
    panel.querySelector('[data-time="day"]').click();
    read();
    const animation = panel.getAnimations({ subtree: true }).find(item => item.transitionProperty === 'transform' && item.effect?.target === panel);
    if (!animation) throw new Error('Night-to-day slide is missing');
    animation.pause();
    animation.currentTime = Number(animation.effect.getTiming().duration) * .32;
    const inFlight = read();
    panel.querySelector('[data-time="dusk"]').click();
    const redirected = read();
    const next = panel.getAnimations({ subtree: true }).find(item => item.transitionProperty === 'transform' && item.effect?.target === panel);
    next?.play();
    return { inFlight, redirected };
  });
  assert.ok(Math.abs(reversal.inFlight - reversal.redirected) < 2, 'rapid reversal continues from the existing pill position without jumping');
  const reversed = await settledSlider(page, 1);
  aligned(reversed, 1, 'reversed dusk');
  assert.ok(reversed.camera.every((value, index) => Math.abs(value - initial.camera[index]) < .001), 'time switching preserves the scene camera');

  await page.getByRole('button', { name: '白天', exact: true }).focus();
  await page.keyboard.press('Enter');
  aligned(await settledSlider(page, 0), 0, 'keyboard day');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '夜晚', exact: true }).click();
  const mobile = await settledSlider(page, 2);
  aligned(mobile, 2, 'mobile night');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(() => {
    const panel = document.querySelector('.time-options');
    panel.querySelector('[data-time="day"]').click();
    const style = getComputedStyle(panel, '::before');
    return { x: new DOMMatrixReadOnly(style.transform).m41, property: style.transitionProperty, duration: style.transitionDuration,
      running: panel.getAnimations({ subtree: true }).filter(item => item.transitionProperty === 'transform' && item.playState === 'running').length };
  });
  assert.ok(Math.abs(reduced.x) < .1 && reduced.running === 0, 'reduced motion switches the pill immediately');
  assert.ok(reduced.property === 'none' || reduced.duration.split(',').every(value => parseFloat(value) <= .001), 'reduced motion disables meaningful transition duration');
  aligned(await sliderState(page), 0, 'reduced-motion day');
  assert.deepEqual(errors, [], 'no runtime errors during slider interaction');
  console.log(JSON.stringify({ ok: true, intermediate, reversal, mobile: { width: mobile.width, x: mobile.x }, reduced }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
