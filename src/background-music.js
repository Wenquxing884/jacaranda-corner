import musicUrl from './assets/you-are-all-i-need.mp3';

const preferenceKey = 'jacaranda-corner:music';

// One media element lives outside both render loops. The postcard and street
// controls share playback, so opening a scene never restarts the song.
export function createBackgroundMusic() {
  const audio = document.createElement('audio');
  audio.id = 'background-music';
  audio.hidden = true;
  audio.loop = true;
  audio.preload = 'none';
  audio.volume = .28;
  document.body.appendChild(audio);
  const buttons = [...document.querySelectorAll('[data-music-toggle]')];
  let remembered = false;
  try { remembered = localStorage.getItem(preferenceKey) === 'on'; } catch { /* Storage can be disabled on local pages. */ }
  let state = remembered ? 'ready' : 'idle', wanted = false, request = 0;

  function remember(enabled) {
    try { localStorage.setItem(preferenceKey, enabled ? 'on' : 'off'); } catch { /* Playback must work without storage. */ }
  }

  function update(next) {
    state = next;
    const labels = { idle: '音乐 · 关', ready: '音乐 · 待播', loading: '音乐 · 加载中', playing: '音乐 · 开', blocked: '音乐 · 点击播放', error: '音乐 · 重试' };
    const actions = {
      idle: '开启背景音乐', ready: '继续播放背景音乐', loading: '取消播放背景音乐',
      playing: '关闭背景音乐', blocked: '点击播放背景音乐', error: '重试播放背景音乐'
    };
    for (const button of buttons) {
      button.dataset.state = state;
      button.setAttribute('aria-pressed', String(state === 'playing'));
      button.setAttribute('aria-label', actions[state]);
      button.title = `You Are All I Need · ${actions[state]}`;
      button.querySelector('[data-music-label]').textContent = labels[state];
    }
  }

  function stop() {
    wanted = false;
    request++;
    audio.pause();
    remember(false);
    update('idle');
  }

  async function start() {
    wanted = true;
    const current = ++request;
    update('loading');
    // Assigning the source lazily avoids fetching the song on a silent visit.
    if (!audio.hasAttribute('src')) audio.src = musicUrl;
    else if (audio.error) audio.load();
    try {
      // Keep play() inside the click's user activation, before any await.
      await audio.play();
      if (current !== request) { if (!wanted) audio.pause(); return; }
      if (!wanted) { audio.pause(); return; }
      remember(true);
      if (!audio.paused && !audio.error) update('playing');
    } catch (error) {
      if (current !== request) return;
      wanted = false;
      audio.pause();
      update(error.name === 'NotAllowedError' ? 'blocked' : 'error');
    }
  }

  audio.addEventListener('playing', () => {
    if (!wanted) { audio.pause(); return; }
    remember(true);
    update('playing');
  });
  audio.addEventListener('pause', () => {
    if (state === 'playing' && audio.paused) { wanted = false; update('ready'); }
  });
  audio.addEventListener('waiting', () => { if (wanted) update('loading'); });
  audio.addEventListener('error', () => {
    const wasWanted = wanted;
    wanted = false;
    request++;
    audio.pause();
    if (wasWanted) update('error');
  });
  buttons.forEach(button => button.addEventListener('click', () => wanted ? stop() : start()));
  // A saved "on" preference offers one-click continuation on the next visit;
  // it never claims to be playing or bypasses browser autoplay restrictions.
  update(state);
  return { inspect: () => ({ state, paused: audio.paused, currentTime: audio.currentTime, volume: audio.volume, loop: audio.loop, error: audio.error?.code ?? null }) };
}
