import { preview } from 'vite';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(projectRoot, 'dist-web');
const sourceMusic = resolve(projectRoot, 'src/assets/you-are-all-i-need.mp3');
const preferenceKey = 'jacaranda-corner:music';
const routePrefix = '/jacaranda-corner/';
const angle = process.env.JACARANDA_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'swiftshader');
const errors = [];
let server, browser, releaseDelayedAudio;

async function installProbe(context) {
  await context.addInitScript(() => {
    const trace = window.__musicNetworkTrace = { plays: [], sources: [], interactions: 0 };
    const snapshot = () => ({ frames: window.__JACARANDA__?.inspect().frames ?? 0, interactions: trace.interactions });
    for (const type of ['pointerup', 'click', 'keydown']) {
      document.addEventListener(type, event => { if (event.isTrusted) trace.interactions++; }, true);
    }
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.id === 'background-music') trace.plays.push(snapshot());
      return nativePlay.call(this);
    };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    const assigned = element => { if (element.id === 'background-music') trace.sources.push(snapshot()); };
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      ...descriptor, set(value) { assigned(this); return descriptor.set.call(this, value); }
    });
    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this instanceof HTMLMediaElement && String(name).toLowerCase() === 'src') assigned(this);
      return nativeSetAttribute.call(this, name, value);
    };

    // Keep the idle callback queued until each test has checked the painted
    // scene. Retain cancelled callbacks to exercise a late-callback race too.
    let nextId = 0;
    const jobs = new Map();
    window.requestIdleCallback = callback => { const id = ++nextId; jobs.set(id, { callback, cancelled: false }); return id; };
    window.cancelIdleCallback = id => { if (jobs.has(id)) jobs.get(id).cancelled = true; };
    window.__musicIdleTest = {
      count: () => jobs.size,
      runAll(includeCancelled = false) {
        const pending = [...jobs.values()];
        jobs.clear();
        for (const job of pending) if (!job.cancelled || includeCancelled) job.callback({ didTimeout: false, timeRemaining: () => 50 });
      }
    };
  });
}

async function loaded(page) {
  await page.waitForFunction(() => window.__JACARANDA__?.inspect().frames >= 2
    && document.querySelector('#background-music') instanceof HTMLAudioElement, null, { timeout: 60000 });
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#loading')).opacity) === 0);
}

async function sample(page) {
  return page.evaluate(() => {
    const audio = document.querySelector('#background-music');
    return {
      frames: window.__JACARANDA__.inspect().frames,
      music: window.__JACARANDA__.music.inspect(),
      trace: window.__musicNetworkTrace,
      idleJobs: window.__musicIdleTest.count(),
      source: audio.getAttribute('src'), currentSource: audio.currentSrc,
      paused: audio.paused, readyState: audio.readyState, currentTime: audio.currentTime,
      duration: Number.isFinite(audio.duration) ? audio.duration : null,
      error: audio.error?.code ?? null,
      loadingOpacity: Number(getComputedStyle(document.querySelector('#loading')).opacity),
      state: document.querySelector('#music-toggle').dataset.state,
      pressed: [...document.querySelectorAll('[data-music-toggle]')].map(button => button.getAttribute('aria-pressed'))
    };
  });
}

async function frames(page, count = 4) {
  await page.evaluate(count => new Promise(resolve => {
    const next = () => --count <= 0 ? resolve() : requestAnimationFrame(next);
    requestAnimationFrame(next);
  }), count);
}

function noMedia(state, label) {
  assert.equal(state.source, null, `${label}: audio has no source`);
  assert.equal(state.currentSource, '', `${label}: no media resource has been selected`);
  assert.equal(state.trace.plays.length, 0, `${label}: play() was never called`);
  assert.equal(state.trace.sources.length, 0, `${label}: a source was never assigned`);
  assert.equal(state.paused, true, `${label}: audio is paused`);
  assert.deepEqual(state.pressed, ['false', 'false'], `${label}: controls do not claim playback`);
}

try {
  const files = await readdir(webRoot);
  const audioFiles = files.filter(name => name.endsWith('.mp3'));
  assert.equal(audioFiles.length, 1, 'the web build has exactly one separately emitted root-level MP3');
  const audioName = audioFiles[0];
  assert.match(audioName, /[-.][A-Za-z0-9_-]{8,}\.mp3$/, 'the audio filename contains a cache-busting content hash');
  const [html, emittedAudio, originalAudio, audioInfo] = await Promise.all([
    readFile(resolve(webRoot, 'index.html'), 'utf8'), readFile(resolve(webRoot, audioName)), readFile(sourceMusic), stat(resolve(webRoot, audioName))
  ]);
  assert.equal(/data:audio\//i.test(html), false, 'the web page does not inline the MP3 as base64');
  assert.ok(html.includes(audioName), 'the web page references the emitted MP3');
  assert.ok(Buffer.byteLength(html) < 2_000_000, 'the web HTML keeps the pre-music-sized startup payload');
  assert.equal(createHash('sha256').update(emittedAudio).digest('hex'), createHash('sha256').update(originalAudio).digest('hex'),
    'externalizing audio preserves the complete supplied song');
  assert.ok(audioInfo.size > 65536, 'the complete song is large enough for a range check');

  // A repository-shaped base exercises the actual deployed relative URL.
  // Vite's preview server serves the production build, not source modules.
  server = await preview({
    root: projectRoot, configLoader: 'native', mode: 'web', base: routePrefix,
    build: { outDir: 'dist-web' },
    preview: { host: '127.0.0.1', port: 5180, strictPort: true }, logLevel: 'error'
  });
  const targetURL = `http://127.0.0.1:5180${routePrefix}`;
  const audioURL = new URL(audioName, targetURL).href;
  const rangeResponse = await fetch(audioURL, { headers: { Range: 'bytes=0-65535' } });
  assert.equal(rangeResponse.status, 206, 'deployed audio supports partial HTTP responses');
  assert.equal(rangeResponse.headers.get('content-range'), `bytes 0-65535/${audioInfo.size}`, 'the range response declares the requested bytes and total song size');
  assert.match(rangeResponse.headers.get('content-type') || '', /audio\//, 'the MP3 is served with an audio MIME type');
  const rangeBody = Buffer.from(await rangeResponse.arrayBuffer());
  assert.equal(rangeBody.length, 65536, 'a range request does not return the whole song');
  assert.deepEqual(rangeBody, emittedAudio.subarray(0, 65536), 'the HTTP range contains the correct audio bytes');

  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--use-angle=${angle}`] });
  const offContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await installProbe(offContext);
  const offRequests = [];
  offContext.on('request', request => {
    if (request.resourceType() === 'media' || /\.mp3(?:[?#]|$)/i.test(request.url())) offRequests.push(request.url());
  });
  const offPage = await offContext.newPage();
  offPage.on('pageerror', error => errors.push(error.message));
  await offPage.goto(targetURL);
  await loaded(offPage);
  await offPage.waitForFunction(() => window.__musicIdleTest.count() > 0 && window.__JACARANDA__.music.inspect().autoPending);
  const queued = await sample(offPage);
  noMedia(queued, 'queued startup');
  assert.equal(queued.music.sceneReady, true, 'the scene is ready while audio still waits for idle');
  assert.equal(queued.state, 'ready', 'queued startup is visibly pending');
  assert.deepEqual(offRequests, [], 'no MP3 is requested while startup is queued');
  await offPage.locator('#music-toggle').click();
  assert.equal(await offPage.evaluate(key => localStorage.getItem(key), preferenceKey), 'off', 'cancelling pending autoplay saves the off preference');
  await offPage.evaluate(() => window.__musicIdleTest.runAll(true));
  await frames(offPage);
  const cancelled = await sample(offPage);
  noMedia(cancelled, 'cancelled late idle callback');
  assert.equal(cancelled.state, 'idle', 'late callbacks do not restart cancelled autoplay');

  // The same persisted choice must also survive a fresh page lifecycle and
  // unrelated pointer/key input, including the independent postcard scene.
  await offPage.reload();
  await loaded(offPage);
  await frames(offPage);
  await offPage.evaluate(() => window.__musicIdleTest.runAll(true));
  await offPage.getByRole('button', { name: '黄昏', exact: true }).click();
  await offPage.getByRole('button', { name: '白天', exact: true }).focus();
  await offPage.keyboard.press('Enter');
  await offPage.evaluate(() => window.__JACARANDA__.sydneyWindow.open());
  await offPage.locator('#music-toggle-postcard').waitFor({ state: 'visible' });
  await offPage.keyboard.press('Escape');
  await offPage.locator('#music-toggle').waitFor({ state: 'visible' });
  await frames(offPage);
  const savedOff = await sample(offPage);
  noMedia(savedOff, 'saved off after unrelated interactions');
  assert.deepEqual(offRequests, [], 'an explicitly disabled song makes zero media network requests');
  await offContext.close();

  const delayedContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await installProbe(delayedContext);
  const audioRequests = [];
  const gate = new Promise(resolve => { releaseDelayedAudio = resolve; });
  let markFirstRequest;
  const firstRequest = new Promise(resolve => { markFirstRequest = resolve; });
  await delayedContext.route(/\.mp3(?:[?#]|$)/i, async route => {
    audioRequests.push(route.request().url());
    markFirstRequest();
    await gate;
    await route.continue();
  });
  const delayedPage = await delayedContext.newPage();
  delayedPage.on('pageerror', error => errors.push(error.message));
  await delayedPage.goto(targetURL);
  await loaded(delayedPage);
  await delayedPage.waitForFunction(() => window.__musicIdleTest.count() > 0);
  noMedia(await sample(delayedPage), 'painted scene before idle');
  await delayedPage.evaluate(() => window.__musicIdleTest.runAll());
  await delayedPage.waitForFunction(() => window.__musicNetworkTrace.plays.length > 0);
  // A loading label can precede the asynchronous policy rejection. Wait for
  // either an actual network request or a definite rejection before deciding
  // whether a user gesture is required; do not race a transient loading UI.
  const policyOrRequest = await Promise.race([
    firstRequest.then(() => 'request'),
    delayedPage.waitForFunction(() => ['blocked', 'error'].includes(document.querySelector('#music-toggle').dataset.state), null, { timeout: 15000 })
      .then(() => 'policy', () => 'timeout')
  ]);
  assert.notEqual(policyOrRequest, 'timeout', 'deferred autoplay either requests audio or reports a browser restriction');
  const started = await sample(delayedPage);
  assert.ok(started.trace.plays[0].frames >= 2 && started.trace.plays[0].interactions === 0, 'automatic play waits for a rendered scene and is genuinely attempted without input');
  assert.ok(started.trace.sources[0].frames >= 2 && started.trace.sources[0].interactions === 0, 'automatic source assignment is also deferred until the scene is rendered');
  if (started.state === 'blocked') await delayedPage.getByRole('button', { name: '白天', exact: true }).click();
  let requestTimeout;
  try {
    await Promise.race([firstRequest, new Promise((_, reject) => { requestTimeout = setTimeout(() => reject(new Error('No external MP3 request followed playback')), 15000); })]);
  } finally { clearTimeout(requestTimeout); }
  const waiting = await sample(delayedPage);
  assert.equal(waiting.readyState, 0, 'the delayed network response has not delivered audio data');
  assert.equal(waiting.loadingOpacity, 0, 'the scene loading cover is gone while music is still waiting');
  assert.ok(waiting.frames >= 2, 'the street is visible before the audio download completes');
  assert.ok(audioRequests.every(url => new URL(url).pathname === new URL(audioURL).pathname), 'the audio URL resolves inside the nested repository path');
  assert.equal(new URL(waiting.source, targetURL).href, audioURL, 'the media source uses the emitted hashed URL');

  const cameraBefore = await delayedPage.evaluate(() => window.__JACARANDA__.camera.position.toArray());
  await delayedPage.mouse.move(790, 490);
  await delayedPage.mouse.down();
  await delayedPage.mouse.move(875, 455, { steps: 4 });
  await delayedPage.mouse.up();
  await frames(delayedPage);
  const cameraAfter = await delayedPage.evaluate(() => window.__JACARANDA__.camera.position.toArray());
  const cameraMovement = Math.hypot(...cameraAfter.map((value, index) => value - cameraBefore[index]));
  assert.ok(cameraMovement > .1, 'the camera remains responsive while the MP3 request is delayed');
  const afterDrag = await sample(delayedPage);
  assert.ok(afterDrag.frames > waiting.frames, 'scene rendering continues while audio waits for the network');
  assert.equal(afterDrag.readyState, 0, 'camera responsiveness is checked before audio data arrives');

  releaseDelayedAudio();
  await delayedPage.waitForFunction(() => {
    const audio = document.querySelector('#background-music');
    return !audio.paused && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && audio.currentTime > .15
      && document.querySelector('#music-toggle').dataset.state === 'playing';
  }, null, { timeout: 30000 });
  const playing = await sample(delayedPage);
  assert.equal(playing.error, null, 'the external song decodes without error');
  assert.ok(playing.duration > 1 && playing.currentTime > .15, 'external audio genuinely decodes and advances after the response is released');
  assert.deepEqual(playing.pressed, ['true', 'true'], 'both scene buttons reflect real playback');
  assert.ok(playing.currentSource.startsWith(targetURL), 'playback uses the HTTP resource rather than embedded audio');
  await delayedPage.locator('#music-toggle').click();
  await delayedPage.waitForFunction(() => document.querySelector('#background-music').paused);
  await delayedContext.close();

  assert.deepEqual(errors, [], 'deferred loading, cancellation and real playback cause no page errors');
  console.log(JSON.stringify({
    ok: true, build: { htmlBytes: Buffer.byteLength(html), audioBytes: audioInfo.size, audioName },
    range: { status: rangeResponse.status, bytes: rangeBody.length, contentRange: rangeResponse.headers.get('content-range') },
    queued: { sceneFrames: queued.frames, idleJobs: queued.idleJobs, cancelledState: cancelled.state },
    savedOffRequests: offRequests.length,
    delayed: { framesBeforeAudio: waiting.frames, framesDuringDelay: afterDrag.frames, cameraMovement,
      sourceFrame: started.trace.sources[0].frames, playFrame: started.trace.plays[0].frames, mediaRequests: audioRequests.length },
    decoded: { duration: playing.duration, currentTime: playing.currentTime }, errors
  }, null, 2));
} finally {
  releaseDelayedAudio?.();
  await browser?.close();
  if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
