import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.env.JACARANDA_OFFLINE === '1', existingURL = process.env.JACARANDA_URL;
const server = offline || existingURL ? null : await createServer({
  root: projectRoot, configLoader: 'native', cacheDir: '.tmp/vite-test-cache',
  server: { host: '127.0.0.1', port: 5179, strictPort: true, watch: { ignored: ['**/.tmp/**', '**/*.tmpdir/**'] } },
  logLevel: 'error'
});
await server?.listen();
const targetURL = existingURL || (offline ? pathToFileURL(resolve(projectRoot, 'jacaranda-corner.html')).href : 'http://127.0.0.1:5179/');
const angle = process.env.JACARANDA_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'swiftshader');
const preferenceKey = 'jacaranda-corner:music';
const screenshots = process.env.JACARANDA_MUSIC_SCREENSHOTS === '1';
const errors = [];
let browser;

async function loaded(page) {
  await page.waitForFunction(() => window.__JACARANDA__?.inspect().frames >= 2
    && document.querySelector('#background-music') instanceof HTMLAudioElement, null, { timeout: 60000 });
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#loading')).opacity) === 0);
}

async function musicState(page) {
  return page.evaluate(() => {
    const audio = document.querySelector('#background-music');
    const buttons = [...document.querySelectorAll('[data-music-toggle]')];
    return {
      audioCount: document.querySelectorAll('audio').length,
      paused: audio.paused, currentTime: audio.currentTime, duration: audio.duration,
      loop: audio.loop, volume: audio.volume, muted: audio.muted, autoplay: audio.autoplay,
      readyState: audio.readyState, error: audio.error?.code ?? null,
      hasSource: !!(audio.getAttribute('src') || audio.currentSrc),
      embeddedSource: audio.currentSrc.startsWith('data:audio/'),
      buttons: buttons.map(button => ({
        id: button.id, tag: button.tagName, state: button.dataset.state,
        pressed: button.getAttribute('aria-pressed'), label: button.getAttribute('aria-label') || button.textContent.trim()
      }))
    };
  });
}

function synced(state, playing, label) {
  assert.equal(state.audioCount, 1, `${label}: there is one shared audio element`);
  assert.equal(state.buttons.length, 2, `${label}: street and postcard have music controls`);
  assert.ok(state.buttons.every(button => button.tag === 'BUTTON' && button.label.length > 0), `${label}: both controls are named native buttons`);
  assert.ok(state.buttons.every(button => button.pressed === String(playing)), `${label}: accessible pressed state matches playback`);
  assert.equal(new Set(state.buttons.map(button => button.state)).size, 1, `${label}: both controls show the same state`);
  assert.equal(state.error, null, `${label}: audio decoder reports no error`);
}

async function playing(page) {
  await page.waitForFunction(() => {
    const audio = document.querySelector('#background-music');
    return !audio.paused && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && [...document.querySelectorAll('[data-music-toggle]')].every(button => button.dataset.state === 'playing'
        && button.getAttribute('aria-pressed') === 'true');
  }, null, { timeout: 30000 });
  const start = await page.$eval('#background-music', audio => audio.currentTime);
  await page.waitForFunction(before => document.querySelector('#background-music').currentTime > before + .15, start, { timeout: 15000 });
  const state = await musicState(page);
  synced(state, true, 'playing');
  assert.ok(Number.isFinite(state.duration) && state.duration > 1, 'the supplied audio is actually decoded');
  assert.equal(state.loop, true, 'background music loops');
  assert.equal(state.muted, false, 'playback is not muted');
  assert.ok(Math.abs(state.volume - .28) < .001, 'background volume is restrained');
  return state;
}

async function paused(page) {
  await page.waitForFunction(() => document.querySelector('#background-music').paused
    && [...document.querySelectorAll('[data-music-toggle]')].every(button => button.getAttribute('aria-pressed') === 'false'));
  const before = await musicState(page);
  await page.waitForTimeout(220);
  const after = await musicState(page);
  synced(after, false, 'paused');
  assert.ok(Math.abs(after.currentTime - before.currentTime) < .035, 'turning music off stops the playback clock');
  return after;
}

async function reachableControl(page, selector, avoidSelectors) {
  const state = await page.evaluate(({ selector, avoidSelectors }) => {
    const button = document.querySelector(selector), rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const visible = element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > .01 && box.width > 0 && box.height > 0;
    };
    const overlaps = avoidSelectors.filter(value => {
      const other = document.querySelector(value);
      if (!other || !visible(other)) return false;
      const b = other.getBoundingClientRect();
      return Math.min(rect.right, b.right) - Math.max(rect.left, b.left) > 1
        && Math.min(rect.bottom, b.bottom) - Math.max(rect.top, b.top) > 1;
    });
    return {
      visible: visible(button), reachable: button === hit || button.contains(hit),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      viewport: { width: innerWidth, height: innerHeight }, overlaps,
      visibleControls: [...document.querySelectorAll('[data-music-toggle]')].filter(visible).map(element => element.id),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  }, { selector, avoidSelectors });
  assert.ok(state.visible && state.reachable, `${selector}: music control is visible and receives pointer input`);
  assert.ok(state.rect.x >= 0 && state.rect.y >= 0 && state.rect.right <= state.viewport.width + 1
    && state.rect.bottom <= state.viewport.height + 1, `${selector}: control stays inside the viewport`);
  assert.ok(state.rect.width >= 44 && state.rect.height >= 28, `${selector}: control has a practical click target`);
  assert.deepEqual(state.overlaps, [], `${selector}: music does not overlap other controls or text`);
  assert.equal(state.visibleControls.length, 1, 'exactly one music button is visible in each scene');
  assert.equal(state.overflow, false, 'music control adds no horizontal overflow');
  return state;
}

async function capture(page, name) {
  if (!screenshots) return;
  const directory = resolve(projectRoot, '.tmp/music-check');
  await mkdir(directory, { recursive: true });
  const image = await page.screenshot({ type: 'jpeg', quality: 92, animations: 'disabled', timeout: 60000 });
  assert.ok(image.length < 20_000_000, 'music preview is below the image limit');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(resolve(directory, `${name}.jpg`), image);
}

try {
  // A real user click must unlock playback; no autoplay-policy bypass is used.
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--use-angle=${angle}`, '--allow-file-access-from-files'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(targetURL);
  await loaded(page);
  const initial = await musicState(page);
  synced(initial, false, 'first visit');
  assert.equal(initial.paused, true, 'the first visit is silent');
  assert.equal(initial.autoplay, false, 'music does not use autoplay');
  assert.equal(initial.hasSource, false, 'the MP3 source is assigned lazily after an explicit click');
  assert.ok(initial.buttons.every(button => button.state === 'idle'), 'first visit starts with music off');
  const desktop = await reachableControl(page, '#music-toggle', ['.masthead', '.intro', '.time-panel', '.view-tools']);
  const cameraBeforeMusic = await page.evaluate(() => window.__JACARANDA__.camera.position.toArray());

  await page.locator('#music-toggle').click();
  const decoded = await playing(page);
  if (offline && !existingURL) assert.equal(decoded.embeddedSource, true, 'the offline HTML embeds the MP3 rather than depending on the original local file');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), preferenceKey), 'on', 'enabled preference is saved');
  await capture(page, 'desktop-playing');
  await page.locator('#music-toggle').click();
  const stopped = await paused(page);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), preferenceKey), 'off', 'disabled preference is saved');
  await page.locator('#music-toggle').focus();
  await page.keyboard.press('Enter');
  const resumed = await playing(page);
  assert.ok(resumed.currentTime > stopped.currentTime, 'keyboard activation resumes instead of restarting the song');

  await page.getByRole('button', { name: '夜晚', exact: true }).click();
  await page.waitForFunction(() => window.__JACARANDA__.inspect().time === 'night' && window.__JACARANDA__.inspect().transition >= .999);
  const afterTime = await playing(page);
  assert.ok(afterTime.currentTime > resumed.currentTime, 'changing time leaves music playing continuously');
  const cameraAfterTime = await page.evaluate(() => window.__JACARANDA__.camera.position.toArray());
  assert.ok(cameraAfterTime.every((value, index) => Math.abs(value - cameraBeforeMusic[index]) < .001), 'music and time controls do not move the camera');
  await page.evaluate(() => { window.__musicOriginalAudio = document.querySelector('#background-music'); window.__JACARANDA__.sydneyWindow.open(); });
  await page.locator('#music-toggle-postcard').waitFor({ state: 'visible' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#music-toggle')).visibility === 'hidden');
  const postcard = await reachableControl(page, '#music-toggle-postcard', ['#sydney-close', '.sydney-heading']);
  assert.equal(await page.evaluate(() => window.__musicOriginalAudio === document.querySelector('#background-music')), true, 'the postcard shares the existing audio element');
  const beforePostcardPause = await playing(page);
  assert.ok(beforePostcardPause.currentTime > afterTime.currentTime, 'opening the postcard does not restart the music');
  await capture(page, 'postcard-playing');
  await page.locator('#music-toggle-postcard').click();
  await paused(page);
  await page.locator('#music-toggle-postcard').click();
  await playing(page);
  await page.keyboard.press('Escape');
  await page.locator('#music-toggle').waitFor({ state: 'visible' });

  // Delay two successful play promises across on/off/on. A stale completion
  // must not override the newest request or leave the controls out of sync.
  await page.locator('#music-toggle').click();
  await paused(page);
  await page.evaluate(() => {
    const audio = document.querySelector('#background-music'), nativePlay = audio.play;
    window.__musicPendingPlays = [];
    audio.play = function () {
      return nativePlay.call(this).then(() => new Promise(resolve => window.__musicPendingPlays.push(resolve)));
    };
  });
  await page.locator('#music-toggle').click();
  await page.waitForFunction(() => window.__musicPendingPlays.length === 1);
  await page.locator('#music-toggle').click();
  await page.waitForFunction(() => document.querySelector('#background-music').paused);
  await page.locator('#music-toggle').click();
  await page.waitForFunction(() => window.__musicPendingPlays.length === 2);
  await page.evaluate(() => { window.__musicPendingPlays[0](); window.__musicPendingPlays[1](); delete document.querySelector('#background-music').play; });
  await playing(page);
  await page.locator('#music-toggle').click();
  await paused(page);

  // Exercise one blocked play without treating a mock as media validation.
  await page.evaluate(() => {
    document.querySelector('#background-music').play = function () {
      delete this.play;
      return Promise.reject(new DOMException('Simulated blocked playback', 'NotAllowedError'));
    };
  });
  await page.locator('#music-toggle').click();
  await page.waitForFunction(() => document.querySelector('#music-toggle').dataset.state === 'blocked');
  const blocked = await musicState(page);
  synced(blocked, false, 'blocked playback');
  assert.equal(blocked.paused, true, 'a blocked play does not pretend to be playing');
  await page.locator('#music-toggle').click();
  await playing(page);

  await page.reload();
  await loaded(page);
  const restored = await musicState(page);
  synced(restored, false, 'restored preference');
  assert.equal(restored.paused, true, 'restoring an on preference never autoplays');
  assert.ok(restored.buttons.every(button => button.state === 'ready'), 'an on preference waits visibly for a new explicit click');
  await page.locator('#music-toggle').click();
  await playing(page);
  await page.locator('#music-toggle').click();
  await paused(page);
  await page.reload();
  await loaded(page);
  const restoredOff = await musicState(page);
  assert.ok(restoredOff.buttons.every(button => button.state === 'idle') && restoredOff.paused, 'an off preference remains off after reload');

  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForFunction(() => window.__JACARANDA__.camera.aspect === innerWidth / innerHeight);
  const intermediate = await reachableControl(page, '#music-toggle', ['.masthead', '.intro', '.time-panel', '.view-tools', 'footer']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.__JACARANDA__.camera.aspect === innerWidth / innerHeight);
  const mobile = await reachableControl(page, '#music-toggle', ['.masthead', '.intro', '.time-panel', '.view-tools']);
  await page.locator('#music-toggle').click();
  await playing(page);
  await capture(page, 'mobile-playing');
  await page.evaluate(() => window.__JACARANDA__.sydneyWindow.open());
  await page.locator('#music-toggle-postcard').waitFor({ state: 'visible' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#music-toggle')).visibility === 'hidden');
  const mobilePostcard = await reachableControl(page, '#music-toggle-postcard', ['#sydney-close', '.sydney-heading']);
  await page.locator('#music-toggle-postcard').click();
  await paused(page);
  await capture(page, 'mobile-postcard');
  await context.close();

  // file:// and restricted storage must not make the audio control unusable.
  const deniedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await deniedContext.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage unavailable for this test', 'SecurityError'); } });
  });
  const deniedPage = await deniedContext.newPage();
  deniedPage.on('pageerror', error => errors.push(error.message));
  await deniedPage.goto(targetURL);
  await loaded(deniedPage);
  synced(await musicState(deniedPage), false, 'storage unavailable');
  await deniedPage.locator('#music-toggle').click();
  await playing(deniedPage);
  await deniedPage.locator('#music-toggle').click();
  await paused(deniedPage);
  await deniedContext.close();

  assert.deepEqual(errors, [], 'music playback, rejected promises and unavailable storage cause no page errors');
  console.log(JSON.stringify({
    ok: true, offline: offline && !existingURL,
    media: { duration: decoded.duration, volume: decoded.volume, embeddedSource: decoded.embeddedSource, resumedFrom: stopped.currentTime, resumedTo: resumed.currentTime },
    desktop: desktop.rect, postcard: postcard.rect, intermediate: intermediate.rect, mobile: mobile.rect, mobilePostcard: mobilePostcard.rect,
    restored: restored.buttons[0].state, blocked: blocked.buttons[0].state,
    checks: ['real MP3 decode', 'pause/resume', 'keyboard', 'time and postcard continuity', 'on/off/on promise race', 'blocked-play retry', 'saved preference', 'mobile controls', 'storage fallback'],
    errors
  }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
