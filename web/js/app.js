// Morning Brief: main UI.
import { SECTIONS, api, clockLabel, fmtTime, h, icon, sb, store, timeAgo, toast } from './api.js';
import { Player } from './player.js';
import { Landing } from './landing.js';
import { SettingsSheet, SourcesSheet, WelcomeSheet, installMode, onInstallChange, promptInstall, pushSupported, wireSheet } from './sheets.js';
import { buildBriefing, loadLocalBriefing } from './brief.js';

const state = {
  briefing: null,
  tab: store.get('tab', 'all'),
  view: store.get('view', 'grid'),
  saved: store.get('saved', []),
  status: null,
  profile: null,
  polling: null,
};

const $ = (id) => document.getElementById(id);
const player = new Player();
const sources = new SourcesSheet();
const settings = new SettingsSheet({ onBuild: () => build() });
const welcome = new WelcomeSheet({
  onDone: async () => { try { state.profile = await api.profile(); } catch { /* keep the old one */ } renderHero(); },
});

/* ------------------------------------------------------------------ header */
// The top-bar Install button shows only while the app isn't installed and this browser can install it.
function syncInstallBtn() {
  $('installBtn').classList.toggle('hidden', !installMode());
}

async function install() {
  if (installMode() === 'ios') { $('installSheet').showModal(); return; }
  if (await promptInstall()) toast('Installed. Next time, open Morning Brief from your home screen.');
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Up early' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
}

function syncThemeIcon() {
  $('themeToggle').querySelector('use').setAttribute('href', currentTheme() === 'dark' ? '#i-sun' : '#i-moon');
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('mb-theme', theme); } catch { /* ignore */ }
  syncThemeIcon();
}

function currentTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

/* -------------------------------------------------------------------- hero */
function renderHero() {
  const b = state.briefing;
  $('greeting').textContent = greeting();
  $('todayLabel').textContent = new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
  const hasBriefing = !!b;
  $('player').classList.toggle('hidden', !hasBriefing);
  $('builder').classList.toggle('hidden', hasBriefing && !state.status?.running);

  renderNotice();
  if (!hasBriefing) {
    $('builderCopy').textContent = 'No briefing yet. Build it fresh right in your browser with your free AI keys — it takes a few minutes. Add your own news links in Sources and pick a voice in Settings first.';
    $('heroTitle').textContent = 'Your news, read aloud every morning';
    $('heroMeta').textContent = 'Top stories from across Canada plus the latest in AI & tech, in about five minutes.';
    $('weatherChip').classList.add('hidden');
    return;
  }
  const today = new Date().toLocaleDateString('en-CA');
  const isToday = b.date === today;
  $('heroTitle').textContent = isToday ? "Today's briefing" : b.title;
  const mins = Math.max(1, Math.round(b.duration / 60));
  $('heroMeta').textContent = `${mins} min · ${b.stories.length} stories · Voice: ${b.voice?.name || 'Default'}${isToday ? '' : ' · from the archive'}`;

  const w = b.weather;
  const chip = $('weatherChip');
  if (w && isToday) {
    chip.replaceChildren(
      h('span', { class: 'temp' }, `${w.now}°`),
      h('span', {}, h('small', {}, `${w.city} · H ${w.high}° L ${w.low}°`), h('small', {}, w.conditions)),
    );
    chip.classList.remove('hidden');
  } else chip.classList.add('hidden');
}

/* ------------------------------------------------------------------ notice */
// Tell the user plainly when today's briefing is late, failed, or was built with fallbacks.
function renderNotice() {
  const el = $('notice');
  const b = state.briefing;
  const st = state.status || {};
  const mine = state.profile?.status || {};
  const today = new Date().toLocaleDateString('en-CA');
  const lines = [];
  let error = false;
  (b?.notes || []).forEach((n) => { lines.push(n.message); if (n.level === 'error') error = true; });
  if (!st.running && mine.date === today && mine.ok === false && b?.date !== today) {
    lines.push(mine.error || "Today's briefing couldn't be built. The admin has been notified.");
    error = true;
  } else if (!st.running && b?.date !== today && st.batch_time && state.profile?.settings?.daily !== false) {
    const [hr, min] = st.batch_time.split(':').map(Number);
    const now = new Date();
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hr, min + 20);
    if (now > due && now.getHours() < 18 && b) {
      lines.push(`Today's briefing is running late (usually ready by ${clockLabel(st.batch_time)}). The server may be asleep or busy; it will catch up. Showing the latest one you have.`);
    }
  }
  el.classList.toggle('error', error);
  el.classList.toggle('hidden', !lines.length);
  el.replaceChildren(...[...new Set(lines)].map((t) => h('p', {}, t)));
}

/* -------------------------------------------------------------------- tabs */
function renderTabs() {
  const b = state.briefing;
  const counts = { all: b?.stories.length || 0, saved: state.saved.length };
  (b?.sections || []).forEach((s) => { counts[s.key] = s.count; });
  const tabs = [
    ['all', 'All', ''],
    ...(b?.sections || []).map((s) => [s.key, s.title, SECTIONS[s.key]?.emoji || '']),
    ['saved', 'Saved', '🔖'],
  ];
  if (!tabs.some(([k]) => k === state.tab)) state.tab = 'all';
  $('tabs').replaceChildren(...tabs.map(([key, label, emoji]) => h('button', {
    class: 'tab', role: 'tab', 'aria-selected': String(state.tab === key),
    onclick: () => { state.tab = key; store.set('tab', key); renderTabs(); renderCards(); },
  }, emoji ? h('span', { 'aria-hidden': 'true' }, emoji) : null, label, h('span', { class: 'count' }, counts[key] ?? 0))));
}

/* ------------------------------------------------------------------- cards */
function isSaved(id) { return state.saved.some((s) => s.id === id); }

function toggleSave(story, btn) {
  if (isSaved(story.id)) state.saved = state.saved.filter((s) => s.id !== story.id);
  else state.saved = [{ ...story, savedFrom: state.briefing?.date }, ...state.saved].slice(0, 100);
  store.set('saved', state.saved);
  const on = isSaved(story.id);
  btn.classList.toggle('saved', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('use').setAttribute('href', on ? '#i-bookmark-fill' : '#i-bookmark');
  toast(on ? 'Saved for later' : 'Removed from saved');
  renderTabs();
  if (state.tab === 'saved') renderCards();
}

async function share(story) {
  const data = { title: story.headline, text: story.summary, url: story.url };
  try {
    if (navigator.share) await navigator.share(data);
    else { await navigator.clipboard.writeText(`${story.headline}\n${story.url}`); toast('Link copied'); }
  } catch { /* cancelled */ }
}

function card(story, index) {
  const sec = SECTIONS[story.section] || SECTIONS.custom;
  const inBriefing = state.briefing?.stories.some((s) => s.id === story.id) && state.tab !== 'saved';
  const media = story.image
    ? h('div', { class: 'card-media' }, h('img', {
      src: story.image, alt: '', loading: index < 3 ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
      onerror: (e) => { const m = e.target.parentElement; m.classList.add('placeholder'); m.dataset.section = story.section; e.target.replaceWith(h('span', {}, sec.emoji)); },
    }))
    : h('div', { class: 'card-media placeholder', dataset: { section: story.section } }, h('span', { 'aria-hidden': 'true' }, sec.emoji));
  media.append(h('span', { class: 'chip', dataset: { section: story.section } }, sec.title));

  const saveBtn = h('button', {
    class: `icon-btn${isSaved(story.id) ? ' saved' : ''}`, 'aria-label': 'Save for later', 'aria-pressed': String(isSaved(story.id)), title: 'Save',
  }, icon(isSaved(story.id) ? 'bookmark-fill' : 'bookmark'));
  saveBtn.addEventListener('click', () => toggleSave(story, saveBtn));

  const also = story.also?.length
    ? h('span', { class: 'dot' }, h('span', { class: 'also', title: `Also covered by ${story.also.join(', ')}` }, `+${story.also.length} more`))
    : null;

  return h('article', { class: 'card', id: `story-${story.id}`, dataset: { id: story.id }, style: `animation-delay:${Math.min(index, 8) * 40}ms` },
    media,
    h('div', { class: 'card-body' },
      h('div', { class: 'meta' }, h('b', {}, story.source), story.published ? h('span', { class: 'dot' }, timeAgo(story.published)) : null, also),
      h('h3', {}, story.headline),
      h('p', { class: 'summary' }, story.summary),
      h('div', { class: 'card-actions' },
        inBriefing ? h('button', { class: 'pill listen', onclick: () => player.playChapter(story.id), 'aria-label': `Listen to: ${story.headline}` },
          icon('play'), h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), 'Listen',
          h('span', { class: 'dur' }, fmtTime(story.end - story.start))) : null,
        h('a', { class: 'pill', href: story.url, target: '_blank', rel: 'noopener noreferrer' }, 'Read', icon('external')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', 'aria-label': 'Share', title: 'Share', onclick: () => share(story) }, icon('share')),
        saveBtn)));
}

function visibleStories() {
  if (state.tab === 'saved') return state.saved;
  const all = state.briefing?.stories || [];
  return state.tab === 'all' ? all : all.filter((s) => s.section === state.tab);
}

function renderCards() {
  const wrap = $('cards');
  wrap.classList.toggle('swipe', state.view === 'swipe');
  document.querySelectorAll('.view-toggle [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  const stories = visibleStories();
  if (!stories.length) {
    const msg = state.tab === 'saved'
      ? ['Nothing saved yet', 'Tap the bookmark on any card to keep it here.']
      : state.briefing ? ['No stories here today', 'Try another section.'] : ['No briefing yet', 'Your first one arrives with the next morning build.'];
    wrap.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, msg[0]), h('p', {}, msg[1])));
    $('swipeDots').classList.add('hidden');
    return;
  }
  wrap.replaceChildren(...stories.map(card));
  highlight(player.current);
  renderDots();
}

function renderDots() {
  const dots = $('swipeDots');
  const n = $('cards').children.length;
  dots.classList.toggle('hidden', state.view !== 'swipe' || n < 2);
  if (state.view !== 'swipe') return;
  dots.replaceChildren(...Array.from({ length: n }, (_, i) => h('i', { class: i === 0 ? 'on' : '' })));
}

function highlight(id) {
  document.querySelectorAll('.card.is-playing').forEach((c) => c.classList.remove('is-playing', 'audio-on'));
  if (!id) return;
  const el = document.getElementById(`story-${id}`);
  if (!el) return;
  el.classList.add('is-playing');
  el.classList.toggle('audio-on', player.isPlaying);
  if (state.view === 'swipe' && player.isPlaying) el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

/* ----------------------------------------------------------------- builder */
function showProgress(status) {
  const running = status?.running;
  const label = status?.step || 'Starting…';
  const pct = `${Math.round((status?.progress || 0) * 100)}%`;
  $('buildProgress').classList.toggle('hidden', !running);
  $('buildBtn').classList.toggle('hidden', !!running);
  $('buildBar').style.width = pct;
  $('buildStep').textContent = `${label}…`.replace(/……$/, '…');
  if (running) $('builderCopy').textContent = 'Hang tight. Briefings are being prepared. This usually takes a few minutes.';
  const sp = $('settingsProgress');
  sp.classList.toggle('hidden', !running);
  sp.querySelector('.progress-bar span').style.width = pct;
  sp.querySelector('.progress-label').textContent = label;
  $('rebuildBtn').disabled = !!running;
  if (running) $('builder').classList.remove('hidden');
}

// Everyone builds their own briefing in the browser: RSS via /api/fetch,
// summaries via /api/llm with their free key, speech via /api/tts.
async function build() {
  $('buildBtn').disabled = true;
  $('rebuildBtn').disabled = true;
  showProgress({ running: true, step: 'Starting', progress: 0 });
  try {
    const [{ settings }, { sources }] = await Promise.all([api.settings(), api.sources()]);
    const catalog = await (await fetch('catalog/sources.json')).json();
    const disabledNames = new Set(sources.filter((s) => s.builtin && !s.enabled).map((s) => s.name));
    const builtin = catalog.sources.filter((s) => !disabledNames.has(s.name));
    const custom = sources.filter((s) => !s.builtin && s.enabled);
    const { briefing, audio } = await buildBriefing({
      settings, builtin, customSources: custom, catalog,
      onProgress: (step, progress) => showProgress({ running: true, step, progress }),
    });
    state.briefing = briefing;
    briefing.audio_url = URL.createObjectURL(audio);
    player.load(briefing);
    setFootnote();
    renderHero();
    renderTabs();
    renderCards();
    showProgress({ running: false });
    toast('Your briefing is ready ☀️');
  } catch (err) {
    showProgress({ running: false });
    toast(err.message, { error: true, ms: 9000 });
  } finally {
    $('buildBtn').disabled = false;
    $('rebuildBtn').disabled = false;
  }
}

function poll() {
  clearInterval(state.polling);
  const tick = async () => {
    try {
      const status = await api.status();
      const wasRunning = state.status?.running;
      state.status = status;
      showProgress(status);
      if (!status.running && wasRunning) {
        await refreshProfile();
        await loadBriefing();
      }
    } catch { /* keep polling through blips */ }
  };
  tick();
  state.polling = setInterval(tick, 3000);
}

async function refreshProfile() {
  try { state.profile = await api.profile(); } catch { /* keep the old one */ }
}

/* ----------------------------------------------------------------- loading */
async function loadArchive(selected) {
  const { briefings } = await api.archive();
  const sel = $('archiveSelect');
  const today = new Date().toLocaleDateString('en-CA');
  sel.replaceChildren(...briefings.map((b) => {
    const label = b.date === today ? 'Today' : new Date(`${b.date}T12:00`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
    const opt = h('option', { value: b.date }, label);
    opt.selected = b.date === selected;
    return opt;
  }));
}

const WRITER = { groq: 'Summaries by AI (Groq)', mixed: 'Summaries by AI + built-in summarizer', 'built-in': 'Built-in summaries', ai: 'Summaries by your AI key' };

function setFootnote() {
  const writer = WRITER[state.briefing?.writer] || 'Summarized in your browser';
  $('footnote').textContent = state.briefing
    ? `${writer} · voiced by ${state.briefing.voice?.name || 'Default'} · built ${timeAgo(state.briefing.generated_at)}`
    : '';
}

function displayBriefing() {
  player.load(state.briefing);
  setFootnote();
  renderHero();
  renderTabs();
  renderCards();
}

async function loadBriefing(day) {
  const res = day ? await api.briefing(day) : await api.latest();
  state.briefing = res.briefing;
  if (state.briefing) {
    if (!day) store.set('last-briefing', state.briefing); // for offline mornings
    displayBriefing();
  } else {
    renderHero();
    renderTabs();
    renderCards();
  }
  await loadArchive(state.briefing?.date);
}

/* ------------------------------------------------------------------ events */
function bindEvents() {
  $('buildBtn').addEventListener('click', build);
  $('installBtn').addEventListener('click', install);
  wireSheet($('installSheet'));
  onInstallChange(syncInstallBtn);
  $('openSources').addEventListener('click', () => sources.open().catch((e) => toast(e.message, { error: true })));
  $('openSettings').addEventListener('click', () => settings.open(state.status, state.profile).catch((e) => toast(e.message, { error: true })));
  $('themeToggle').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  $('archiveSelect').addEventListener('change', (e) => loadBriefing(e.target.value));
  $('settingsSheet').addEventListener('close', async () => {
    try { state.status = await api.status(); await refreshProfile(); } catch { /* ignore */ }
  });

  document.querySelectorAll('.view-toggle [data-view]').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    store.set('view', state.view);
    renderCards();
  }));

  $('cards').addEventListener('scroll', () => {
    if (state.view !== 'swipe') return;
    const wrap = $('cards');
    const idx = Math.round(wrap.scrollLeft / (wrap.firstElementChild?.offsetWidth + 16 || 1));
    $('swipeDots').querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i === idx));
  }, { passive: true });

  player.addEventListener('chapter', (e) => highlight(e.detail.id));
  player.addEventListener('state', () => highlight(player.current));

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog[open]') || e.metaKey || e.ctrlKey) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'j' || e.key === 'ArrowDown' && e.shiftKey) player.nextChapter();
    else if (e.key === 'ArrowRight' && state.view === 'swipe') $('cards').scrollBy({ left: 300, behavior: 'smooth' });
    else if (e.key === 'ArrowLeft' && state.view === 'swipe') $('cards').scrollBy({ left: -300, behavior: 'smooth' });
    else if (e.key === 'l') player.skip(30);
    else if (e.key === 'h') player.skip(-15);
  });

  document.addEventListener('visibilitychange', async () => {
    // Coming back to the tab in the morning? Pick up the new briefing.
    if (document.visibilityState !== 'visible' || player.isPlaying) return;
    try {
      state.status = await api.status();
      if (state.status.running && !state.polling) poll();
      const { briefing } = await api.latest();
      renderNotice();
      if (briefing && briefing.generated_at !== state.briefing?.generated_at && $('archiveSelect').selectedIndex <= 0) {
        await loadBriefing();
      }
    } catch { /* offline */ }
  });
}

/* ----------------------------------------------------------------- landing */
let landing = null;
let started = false;

async function showLanding() {
  document.body.classList.add('signed-out');
  $('login').classList.remove('hidden');
  if (!landing) landing = new Landing({ onSignedIn: enterApp });
  await landing.show();
}

async function enterApp() {
  landing?.stop();
  document.body.classList.remove('signed-out');
  $('login').classList.add('hidden');
  if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname);
  if (started) return;
  started = true;
  await start();
  // A voice they tried on the landing page becomes theirs, unless they already picked one.
  const voice = store.get('pending-voice', null);
  if (voice && !state.profile?.settings?.voice) {
    try { await api.saveSettings({ voice }); state.profile = await api.profile(); } catch { /* keep default */ }
  }
  store.set('pending-voice', null);
  // First time here: ask for a name and offer notifications.
  const st = state.profile?.settings || {};
  if (state.profile && !st.onboarded && !st.name) welcome.open(state.status);
  // Seen the welcome step where push wasn't possible (iPhone in Safari)? Offer notifications once it is.
  else if (state.profile && !st.push_offered && pushSupported() && Notification.permission === 'default') welcome.open(state.status, { askName: false });
}

/* -------------------------------------------------------------------- boot */
async function start() {
  $('cards').replaceChildren(...Array.from({ length: 3 }, () => h('div', { class: 'skeleton' })));
  const today = new Date().toLocaleDateString('en-CA');
  try {
    const [status, profile] = await Promise.all([api.status(), api.profile()]);
    state.status = status;
    state.profile = profile;
    // A briefing built on this device today wins over anything older.
    const local = await loadLocalBriefing(today).catch(() => null);
    if (local?.briefing && local?.audio) {
      state.briefing = local.briefing;
      state.briefing.audio_url = URL.createObjectURL(local.audio);
      displayBriefing();
      await loadArchive(state.briefing.date);
      showProgress({ running: false });
      return;
    }
    await loadBriefing();
    showProgress(status);
    renderHero();
    if (status.running) poll();
  } catch (err) {
    const cached = store.get('last-briefing', null);
    if (cached) {
      state.briefing = cached;
      player.load(cached);
      renderHero(); renderTabs(); renderCards();
      toast(`Offline: showing your last briefing. (${err.message})`, { error: true, ms: 8000 });
    } else {
      toast(`Couldn't reach the service: ${err.message}`, { error: true, ms: 8000 });
      renderCards();
    }
  }
}

async function init() {
  syncThemeIcon(); // follows the OS until the user picks a theme
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeIcon);
  bindEvents();
  syncInstallBtn();
  renderHero();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') { started = false; showLanding(); }
    else if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) setTimeout(enterApp, 0);
  });
  let session = null;
  try { session = await api.session(); } catch { /* offline */ }
  if (session) { await enterApp(); return; }
  if (store.get('last-briefing', null) && !navigator.onLine) { started = true; await start(); return; }
  await showLanding();
}

init();
