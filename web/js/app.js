// Morning Brief: main UI (APK Today layout, tab pages).
import { api, fmtTime, h, icon, sb, store, timeAgo, toast } from './api.js';
import { Player } from './player.js';
import { Landing } from './landing.js';
import { WelcomeSheet, installMode, onInstallChange, promptInstall, pushSupported, wireSheet } from './sheets.js';
import { SourcesPage } from './pages/sources.js';
import { SettingsPage } from './pages/settings.js';
import { buildBriefing, loadLocalBriefing } from './brief.js';
import { buildBriefing as buildPackBriefing } from './storypack.js';
import { applyPhotoMode } from './design.js';

const state = {
  briefing: null,
  profile: null,
  status: null,
  archiveDates: [],
  building: false,
  buildStep: '',
  buildFrac: 0,
  buildError: null,
  reported: new Set(store.get('reported', [])),
};

const $ = (id) => document.getElementById(id);
const player = new Player();
let sourcesPage = null;
let settingsPage = null;
let currentTab = 'today';
const welcome = new WelcomeSheet({
  onDone: async () => { try { state.profile = await api.profile(); } catch { /* keep the old one */ } renderHeader(); },
});

/* ------------------------------------------------------------------ header */
function syncInstallBtn() {
  $('installBtn').classList.toggle('hidden', !installMode());
}

async function install() {
  if (installMode() === 'ios') { $('installSheet').showModal(); return; }
  if (await promptInstall()) toast('Installed. Next time, open Morning Brief from your home screen.');
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

const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** "12 stories, six minutes. Light drizzle, high 21°." */
function summaryLine(b) {
  const n = b.stories.length;
  const minutes = Math.max(1, Math.round(b.duration / 60));
  const m = WORDS[minutes - 1] || String(minutes);
  let line = `${n === 1 ? '1 story' : `${n} stories`}, ${m} minute${minutes === 1 ? '' : 's'}.`;
  if (b.weather) line += ` ${b.weather.conditions[0].toUpperCase()}${b.weather.conditions.slice(1)}, high ${b.weather.high}°.`;
  return line;
}

function renderHeader() {
  const now = new Date();
  const wd = now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const mon = now.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  $('dateOverline').textContent = `${wd} · ${now.getDate()} ${mon}`;
  const w = state.briefing?.weather;
  $('wxChip').textContent = w ? `${w.city} ${w.now}°` : '';
  $('screenSubtitle').textContent = state.briefing ? summaryLine(state.briefing) : 'Your news, read aloud each morning.';
}

/* ------------------------------------------------------------------ notice */
function renderNotice() {
  const box = $('notice');
  if (state.building) {
    box.replaceChildren(h('div', { class: 'glass notice-card', role: 'status', 'aria-live': 'polite' },
      h('h3', {}, 'Making your brief'),
      h('p', { class: 'hint' }, state.buildStep || 'Starting…'),
      h('div', { class: 'progress-bar' }, h('span', { style: `width:${Math.round(state.buildFrac * 100)}%` })),
      h('p', { class: 'hint' }, 'This takes a few minutes. Feel free to leave the app; it keeps going.')));
    return;
  }
  if (state.buildError) {
    box.replaceChildren(h('div', { class: 'glass notice-card', role: 'alert' },
      h('h3', { class: 'error' }, "Your last brief couldn't be made"),
      h('p', {}, state.buildError)));
    return;
  }
  if (!state.briefing) {
    const btn = h('button', { class: 'pill-btn', type: 'button' }, 'Make my first brief');
    btn.addEventListener('click', build);
    box.replaceChildren(h('div', { class: 'glass notice-card' },
      h('h3', {}, 'Your first brief is a tap away'),
      h('p', {}, 'Five minutes of the news you choose, read aloud and made right here in your browser. Start with the defaults; you can change sources and voice any time.'),
      btn));
    return;
  }
  const notes = state.briefing.notes || [];
  box.replaceChildren(...notes.map((n) => h('div', { class: 'glass notice-card', role: 'status' }, h('p', {}, n.message))));
}

/* -------------------------------------------------------------------- hero */
function renderHero() {
  $('hero').classList.toggle('hidden', !state.briefing);
}

/* -------------------------------------------------------------- date chips */
function chipLabel(date) {
  const today = new Date().toLocaleDateString('en-CA');
  if (date === today) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (date === y.toLocaleDateString('en-CA')) return 'Yesterday';
  return new Date(`${date}T12:00`).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
}

function renderDateChips() {
  const box = $('dateChips');
  const dates = state.archiveDates;
  box.classList.toggle('hidden', dates.length < 2);
  box.replaceChildren(...dates.map((d) => {
    const b = h('button', { class: 'dchip' + (d === state.briefing?.date ? ' active' : ''), type: 'button' }, chipLabel(d));
    b.addEventListener('click', () => selectDate(d));
    return b;
  }));
}

async function selectDate(date) {
  const today = new Date().toLocaleDateString('en-CA');
  try {
    if (date === today) {
      const local = await loadLocalBriefing(today).catch(() => null);
      if (local?.briefing && local?.audio) {
        state.briefing = local.briefing;
        state.briefing.audio_url = URL.createObjectURL(local.audio);
        displayBriefing();
        return;
      }
    }
    const pack = await loadStoryPack(date);
    if (pack) {
      state.briefing = pack;
      displayBriefing();
      return;
    }
    const { briefing } = await api.briefing(date);
    state.briefing = briefing;
    if (briefing) displayBriefing();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* ----------------------------------------------------------------- sections */
function audioLen(story) {
  const secs = Math.round((story.end || 0) - (story.start || 0));
  return secs < 60 ? `${secs}s of audio` : `${fmtTime(secs)} of audio`;
}

function storyRow(story) {
  const row = h('article', { class: 'story-row', dataset: { id: story.id } });
  const dot = h('button', { class: 'play-dot', type: 'button', 'aria-label': `Play from: ${story.headline}` },
    icon('play'), h('span', { class: 'i-eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  dot.addEventListener('click', (e) => { e.stopPropagation(); player.playChapter(story.id); });

  const main = h('div', { class: 'story-main' },
    h('div', { class: 'play-col' }, dot, h('span', { class: 't' }, fmtTime(story.start || 0))),
    h('div', { class: 'story-text' },
      h('h3', {}, story.headline),
      h('p', { class: 'story-meta' }, [story.source, audioLen(story), story.also?.length ? `+${story.also.length} source${story.also.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '))),
    story.image ? h('img', { class: 'story-thumb', src: story.image, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null);

  const detail = h('div', { class: 'story-detail hidden' },
    h('p', { class: 'summary' }, story.summary),
    story.also?.length ? h('p', { class: 'also' }, `Also covered by ${story.also.join(', ')}`) : null,
    h('div', { class: 'story-actions' },
      h('button', { class: 'pill-btn', type: 'button', onclick: () => player.playChapter(story.id) }, icon('play'), 'Play from here'),
      h('a', { class: 'pill-btn glass-btn', href: story.url, target: '_blank', rel: 'noopener noreferrer' }, 'Article', icon('external'))),
    reportRow(story));
  main.addEventListener('click', () => detail.classList.toggle('hidden'));
  row.append(main, detail);
  return row;
}

function reportRow(story) {
  const reported = state.reported.has(story.id);
  const btn = h('button', { class: 'report-row', type: 'button' },
    icon('flag'), reported ? 'Reported. Thanks' : 'Report this summary');
  if (!reported) btn.addEventListener('click', (e) => { e.stopPropagation(); openReport(story, btn); });
  return btn;
}

function renderSections() {
  const box = $('sections');
  const b = state.briefing;
  if (!b) {
    box.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'No briefing yet'), h('p', {}, 'Make your first brief above to get started.')));
    return;
  }
  const currentSection = (() => {
    const ch = player.chapters.find((c) => c.id === player.current);
    return b.stories.find((s) => s.id === ch?.id)?.section;
  })();
  box.replaceChildren(...(b.sections || []).flatMap((sec) => {
    const stories = b.stories.filter((s) => s.section === sec.key);
    if (!stories.length) return [];
    const here = currentSection === sec.key;
    const right = here
      ? [h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'overline here', style: 'color:var(--ink)' }, player.isPlaying ? 'Playing' : 'Paused')]
      : [h('span', { class: 'overline' }, `${stories.length} ${stories.length === 1 ? 'story' : 'stories'}`)];
    const head = h('button', { class: 'section-head', type: 'button', 'aria-label': `Play from ${sec.title}` },
      h('span', { class: 'overline', style: 'color:var(--ink)' }, sec.title), ...right);
    head.addEventListener('click', () => player.seekTo(stories[0].start || 0));
    const group = h('div', { class: 'glass glass-group' }, ...stories.map(storyRow));
    return [head, group];
  }));
  // APK parity: rebuild action at the end of the page.
  const today = new Date().toLocaleDateString('en-CA');
  const fresh = h('button', { class: 'pill-btn glass-btn wide', type: 'button' },
    icon('refresh'), b.date === today ? 'Make a fresh brief' : "Make today's brief");
  fresh.addEventListener('click', () => build());
  fresh.disabled = state.building;
  box.append(h('div', { class: 'fresh-wrap' }, fresh));
  syncPlaying();
}

function syncPlaying() {
  const id = player.current;
  document.querySelectorAll('.story-row').forEach((row) => {
    const on = row.dataset.id === id;
    row.classList.toggle('current', on);
    row.classList.toggle('playing-now', on && player.isPlaying);
  });
}

/* ------------------------------------------------------------------ report */
const REPORT_REASONS = [['inaccurate', 'Wrong or misleading'], ['offensive', 'Offensive or harmful'], ['broken', "Doesn't match the article"], ['other', 'Something else']];
let reportStory = null;
let reportReason = null;

function openReport(story, btn) {
  reportStory = story;
  reportReason = null;
  const box = $('reportReasons');
  box.replaceChildren(...REPORT_REASONS.map(([key, label]) => {
    const b = h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': 'false' }, label);
    b.addEventListener('click', () => {
      reportReason = key;
      box.querySelectorAll('.chip-btn').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
    });
    return b;
  }));
  $('reportNote').value = '';
  $('reportError').textContent = '';
  $('reportSheet').showModal();
}

async function sendReport() {
  if (!reportReason) { $('reportError').textContent = 'Pick a reason first.'; return; }
  const s = reportStory;
  $('reportSend').disabled = true;
  try {
    await api.report({
      reason: reportReason,
      note: $('reportNote').value.trim().slice(0, 1000) || null,
      headline: s.headline, summary: s.summary, url: s.url, source: s.source,
    });
    state.reported.add(s.id);
    store.set('reported', [...state.reported]);
    $('reportSheet').close();
    toast('Reported. Thanks for flagging it.');
    renderSections();
  } catch (err) {
    $('reportError').textContent = err.message;
  } finally {
    $('reportSend').disabled = false;
  }
}

/* ----------------------------------------------------------------- builder */
async function build() {
  if (state.building) return;
  state.building = true;
  state.buildError = null;
  state.buildStep = 'Starting';
  state.buildFrac = 0;
  renderNotice();
  try {
    const [{ settings }, { sources }] = await Promise.all([api.settings(), api.sources()]);
    const catalog = await (await fetch('catalog/sources.json')).json();
    const disabledNames = new Set(sources.filter((s) => s.builtin && !s.enabled).map((s) => s.name));
    const builtin = catalog.sources.filter((s) => !disabledNames.has(s.name));
    const custom = sources.filter((s) => !s.builtin && s.enabled);
    const { briefing, audio } = await buildBriefing({
      settings, builtin, customSources: custom, catalog,
      onProgress: (step, frac) => { state.buildStep = step; state.buildFrac = frac; renderNotice(); },
    });
    state.briefing = briefing;
    briefing.audio_url = URL.createObjectURL(audio);
    const today = new Date().toLocaleDateString('en-CA');
    if (!state.archiveDates.includes(today)) state.archiveDates = [today, ...state.archiveDates];
    toast('Your briefing is ready ☀️');
  } catch (err) {
    state.buildError = err.message;
  } finally {
    state.building = false;
    renderNotice();
    if (state.briefing && !state.buildError) displayBriefing();
    else { renderHeader(); renderHero(); }
  }
}

/* ------------------------------------------------------- shared story pack */
/** The day's shared clips assembled for this listener's lineup; null when there is no pack. */
async function loadStoryPack(day) {
  try {
    const [{ settings }, rows] = await Promise.all([api.settings(), api.storyAudio(day)]);
    return buildPackBriefing(rows, settings, { date: day, voice: rows[0]?.voice });
  } catch {
    return null;  // no pack that day, or the story_audio table isn't there yet
  }
}

/* ----------------------------------------------------------------- loading */
function setFootnote() {
  const WRITER = { groq: 'Summaries by AI (Groq)', mixed: 'Summaries by AI + built-in summarizer', 'built-in': 'Built-in summaries', ai: 'Summaries by your AI key', guardian: 'The Guardian · built-in summaries' };
  const writer = WRITER[state.briefing?.writer] || 'Summarized in your browser';
  $('footnote').textContent = state.briefing
    ? `${writer} · voiced by ${state.briefing.voice?.name || 'Default'} · built ${timeAgo(state.briefing.generated_at)}`
    : '';
}

function displayBriefing() {
  if (state.briefing) player.load(state.briefing);
  setFootnote();
  renderHeader();
  renderHero();
  renderNotice();
  renderDateChips();
  renderSections();
}

async function loadArchive() {
  try {
    const [{ briefings }, storyDates] = await Promise.all([
      api.archive(),
      api.storyDates().catch(() => []),
    ]);
    state.archiveDates = [...new Set([...briefings.map((b) => b.date), ...storyDates])].sort().reverse();
  } catch { state.archiveDates = []; }
  renderDateChips();
}

/* ------------------------------------------------------------ tab pages */
async function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabbar .tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  for (const p of ['today', 'sources', 'settings']) {
    document.getElementById(`page-${p}`).classList.toggle('hidden', p !== tab);
  }
  window.scrollTo({ top: 0 });
  if (tab === 'sources' && !sourcesPage) {
    sourcesPage = new SourcesPage({ onDirty: syncSaveBar });
    try { await sourcesPage.load(); } catch (err) { toast(err.message, { error: true }); }
  }
  if (tab === 'settings' && !settingsPage) {
    settingsPage = new SettingsPage({
      onDirty: syncSaveBar,
      goSources: () => switchTab('sources'),
      email: state.profile?.email,
    });
    try { await settingsPage.load(); } catch (err) { toast(err.message, { error: true }); }
  }
  const mini = $('miniPlayer');
  if (tab === 'today') {
    // Hero is back in view; its scroll observer resumes control from here.
    mini.classList.remove('show');
    mini.setAttribute('aria-hidden', 'true');
  }
  syncMini();
  syncSaveBar();
}

/** APK mini-player rule: on other tabs it shows whenever there's something to resume. */
function syncMini() {
  if (currentTab === 'today') return;
  const show = !!player.briefing && (player.isPlaying || player.audio.currentTime > 0);
  const mini = $('miniPlayer');
  mini.classList.toggle('show', show);
  mini.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function syncSaveBar() {
  const dirty = currentTab !== 'today' && (sourcesPage?.isDirty() || settingsPage?.isDirty());
  $('saveBar').classList.toggle('hidden', !dirty);
}

async function saveAll() {
  try {
    if (sourcesPage?.isDirty()) await sourcesPage.save();
    if (settingsPage?.isDirty()) await settingsPage.save();
    toast('Saved.');
  } catch (err) {
    toast(err.message, { error: true });
  }
  syncSaveBar();
}

function discardAll() {
  sourcesPage?.discard();
  settingsPage?.discard();
  syncSaveBar();
  toast('Changes discarded.');
}

/* ------------------------------------------------------------------ events */
function bindEvents() {
  document.querySelectorAll('#tabbar .tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('saveBtn').addEventListener('click', saveAll);
  $('discardBtn').addEventListener('click', discardAll);
  wireSheet($('confirmDialog'));
  $('miniPlayer').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    switchTab('today');
  });
  $('installBtn').addEventListener('click', install);
  wireSheet($('installSheet'));
  onInstallChange(syncInstallBtn);
  $('themeToggle').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  document.addEventListener('mb-theme', syncThemeIcon);
  $('reportSend').addEventListener('click', sendReport);
  wireSheet($('reportSheet'));

  player.addEventListener('chapter', syncPlaying);
  player.addEventListener('chapter', syncMini);
  player.addEventListener('state', syncPlaying);
  player.addEventListener('state', syncMini);

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog[open]') || e.metaKey || e.ctrlKey) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'ArrowRight') player.nextChapter();
    else if (e.key === 'ArrowLeft') player.prevChapter();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderHeader();
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
  const voice = store.get('pending-voice', null);
  if (voice && !state.profile?.settings?.voice) {
    try { await api.saveSettings({ voice }); state.profile = await api.profile(); } catch { /* keep default */ }
  }
  store.set('pending-voice', null);
  const st = state.profile?.settings || {};
  if (state.profile && !st.onboarded && !st.name) welcome.open(state.status);
  else if (state.profile && !st.push_offered && pushSupported() && Notification.permission === 'default') welcome.open(state.status, { askName: false });
}

/* -------------------------------------------------------------------- boot */
async function start() {
  $('sections').replaceChildren(...Array.from({ length: 3 }, () => h('div', { class: 'skeleton' })));
  const today = new Date().toLocaleDateString('en-CA');
  try {
    const [status, profile] = await Promise.all([api.status(), api.profile()]);
    state.status = status;
    state.profile = profile;
    applyPhotoMode(profile?.settings?.color_photos);
    await loadArchive();
    // Precedence: a brief built on this device today, then today's shared pack, then the newest briefing row.
    const local = await loadLocalBriefing(today).catch(() => null);
    if (local?.briefing && local?.audio) {
      state.briefing = local.briefing;
      state.briefing.audio_url = URL.createObjectURL(local.audio);
      if (!state.archiveDates.includes(today)) state.archiveDates = [today, ...state.archiveDates];
    } else {
      state.briefing = (await loadStoryPack(today)) || (await api.latest()).briefing;
    }
    displayBriefing();
  } catch (err) {
    const cached = store.get('last-briefing', null);
    if (cached?.audio_url?.startsWith('http')) {
      state.briefing = cached;
      displayBriefing();
      toast(`Offline: showing your last briefing. (${err.message})`, { error: true, ms: 8000 });
    } else {
      renderHeader();
      renderNotice();
      renderHero();
      renderSections();
      toast(`Couldn't reach the service: ${err.message}`, { error: true, ms: 8000 });
    }
  }
}

async function init() {
  syncThemeIcon();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeIcon);
  bindEvents();
  syncInstallBtn();
  renderHeader();
  renderNotice();
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
