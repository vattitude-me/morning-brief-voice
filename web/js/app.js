import { api, fmtTime, h, icon, isAdmin, recordError, sb, store, timeAgo, toast, VOICES, voiceFor, SECTIONS } from './api.js';
import { Player } from './player.js';
import { Landing } from './landing.js';
import { WelcomeSheet, installMode, onInstallChange, promptInstall, pushSupported, wireSheet } from './sheets.js';
import { SourcesPage } from './pages/sources.js';
import { SettingsPage } from './pages/settings.js';
import { AdminPage } from './pages/admin.js';
import { buildBriefing as buildPackBriefing, READY_KEY } from './storypack.js';
import { applyPhotoMode } from './design.js';

const state = {
  briefing: null,
  briefingLoading: true,
  profile: null,
  status: null,
  archiveDates: [],
  reported: new Set(store.get('reported', [])),
};

const $ = (id) => document.getElementById(id);
const player = new Player();
window.player = player;
window.state = state;
window.switchTab = switchTab;
let sourcesPage = null;
let settingsPage = null;
let adminPage = null;
let currentTab = 'today';
const welcome = new WelcomeSheet({
  onDone: async () => { try { state.profile = await api.profile(); } catch { /* keep the old one */ } syncAdminTab(); renderHeader(); },
});

/** The admin tab shows for the admin account. The worker and the database check it again. */
function syncAdminTab() {
  const tab = $('adminTab');
  if (tab) tab.classList.toggle('hidden', !isAdmin(state.profile));
}
window.syncAdminTab = syncAdminTab;

/* ------------------------------------------------------------------ header */
function syncInstallBtn() {
  $('installBtn')?.classList.toggle('hidden', !installMode());
}

async function install() {
  if (installMode() === 'ios') { $('installSheet').showModal(); return; }
  if (await promptInstall()) toast('Installed. Next time, open Morning Brief from your home screen.');
}

function syncThemeIcon() {
  $('themeToggle')?.querySelector('use')?.setAttribute('href', currentTheme() === 'dark' ? '#i-sun' : '#i-moon');
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
  if (b.weather && b.weather.conditions) line += ` ${b.weather.conditions[0].toUpperCase()}${b.weather.conditions.slice(1)}, high ${b.weather.high}°.`;
  return line;
}

export function formatFreshnessDate(dateStr) {
  let d;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, day] = dateStr.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date();
  }
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  const mon = d.toLocaleDateString('en-US', { month: 'short' });
  const num = d.getDate();
  const sfx = (num % 10 === 1 && num !== 11) ? 'st'
            : (num % 10 === 2 && num !== 12) ? 'nd'
            : (num % 10 === 3 && num !== 13) ? 'rd'
            : 'th';
  return `${wd} ${mon} ${num}${sfx}`;
}

function renderHeader() {
  const now = new Date();
  const wd = now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const mon = now.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();

  // Time-based greeting with user's name
  const hr = now.getHours();
  const baseGreeting = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const name = state.profile?.settings?.name || '';
  const greetingEl = $('greeting');
  if (greetingEl) {
    greetingEl.textContent = name.trim() ? `${baseGreeting}, ${name.trim()}` : baseGreeting;
  }
  const lgGreeting = $('lgGreeting');
  if (lgGreeting) lgGreeting.textContent = baseGreeting;

  // Status text chip
  const b = state.briefing;
  const statusChip = $('statusChip');
  const statusText = $('statusText');
  if (statusText) {
    if (b) {
      const minutes = Math.max(1, Math.round((b.duration || 0) / 60));
      const w = b.weather;
      statusText.textContent = w ? `${w.city} ${w.now}° · ${b.stories.length} stories` : `${b.stories.length} stories · ${minutes}m`;
      if (statusChip) statusChip.classList.remove('hidden');
    } else {
      statusText.textContent = 'Curating';
    }
  }

  // Weather chip (safely guarded)
  const wxChip = $('wxChip');
  if (wxChip) {
    const w = b?.weather;
    wxChip.textContent = w ? `${w.city} ${w.now}°` : '';
  }

  // Active narrator chip & preview
  const activeVoiceId = b?.voice?.id || state.profile?.settings?.voice || 'her_reference';
  const activeVoice = voiceFor(activeVoiceId);
  const nName = $('narratorName');
  if (nName) nName.textContent = activeVoice.name;
  const nDesc = $('narratorDesc');
  if (nDesc) nDesc.textContent = activeVoice.style || activeVoice.desc;
  const narrBy = $('narratedBy');
  if (narrBy) narrBy.textContent = `Narrated by ${activeVoice.name} · ${activeVoice.style || activeVoice.desc}`;
  const heroNarrName = $('heroNarratorName');
  if (heroNarrName) heroNarrName.textContent = activeVoice.name;

  // Avatar initial
  const avInitial = $('avatarInitial');
  if (avInitial) {
    const raw = name || state.profile?.email || '';
    if (raw.trim()) avInitial.textContent = raw.trim()[0].toUpperCase();
  }

  const sub = $('screenSubtitle');
  if (sub) {
    const baseSummary = b ? summaryLine(b) : 'Your news, read aloud each morning.';
    sub.textContent = b ? `${baseSummary} · Read by ${activeVoice.name}` : baseSummary;
  }

  const tag = $('freshnessTag');
  if (tag) {
    const bDate = b?.date;
    const formatted = formatFreshnessDate(bDate);
    const todayStr = new Date().toLocaleDateString('en-CA');
    const isToday = Boolean(bDate && bDate === todayStr);
    tag.textContent = isToday ? `Fresh today · ${wd} ${now.getDate()} ${mon}` : `Archived · ${formatted}`;
    tag.className = 'freshness-tag' + (isToday ? ' fresh' : ' stale');
    tag.title = isToday ? "Today's fresh briefing" : `Archived briefing from ${formatted}`;
  }

  const dateOverline = $('dateOverline');
  if (dateOverline) {
    dateOverline.textContent = '';
    dateOverline.classList.add('hidden');
  }
}

/* ------------------------------------------------------------------ notice */
/** Sleek, compact status bar when today's brief isn't ready or is loading. */
function renderNotice() {
  const box = $('notice');
  if (state.briefingLoading) {
    box.replaceChildren(h('div', { class: 'glass notice-compact loading-card', role: 'status' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', { class: 'notice-text' }, "Checking for today's briefing…")));
    return;
  }
  if (!state.briefing) {
    box.replaceChildren(h('div', { class: 'glass notice-compact', role: 'status' },
      h('span', { class: 'notice-badge' }, 'SCHEDULED'),
      h('span', { class: 'notice-text' }, "Today's briefing records daily at sunrise. Check back shortly.")));
    return;
  }
  if (state.briefing.fresh === false) {
    box.replaceChildren(h('div', { class: 'glass notice-compact', role: 'status' },
      h('span', { class: 'notice-badge' }, 'ARCHIVED'),
      h('span', { class: 'notice-text' }, `Playing latest from ${chipLabel(state.briefing.date)} · Today's brief arrives before sunrise`)));
    return;
  }
  box.replaceChildren();
}

/* -------------------------------------------------------------------- hero */
function renderHero() {
  $('hero').classList.toggle('hidden', !state.briefing);
}

function renderPersonas() {
  const row = $('personaRow');
  if (!row) return;
  const activeVoiceId = state.briefing?.voice?.id || state.profile?.settings?.voice || 'her_reference';
  row.replaceChildren(...VOICES.map((v) => {
    const on = v.id === activeVoiceId;
    const btn = h('button', {
      type: 'button',
      class: 'persona' + (on ? ' on' : ''),
      'aria-pressed': String(on),
      dataset: { voice: v.id },
    },
      h('span', { class: 'persona-avatar' }, icon(v.icon || 'mic')),
      h('span', { class: 'persona-text' },
        h('span', { class: 'persona-name' }, v.name),
        h('span', { class: 'persona-desc' }, v.style || v.desc)
      )
    );
    btn.addEventListener('click', async () => {
      if (v.id === activeVoiceId) {
        $('narratorSheet')?.close();
        return;
      }
      btn.classList.add('busy');
      try {
        await api.saveSettings({ voice: v.id });
        if (state.profile?.settings) state.profile.settings.voice = v.id;
        toast(`Switching narrator to ${v.name}…`);
        const targetDate = state.briefing?.date || new Date().toLocaleDateString('en-CA');
        const pack = await loadStoryPack(targetDate);
        if (pack) {
          const currentPos = player.position;
          const wasPlaying = player.isPlaying;
          state.briefing = pack;
          displayBriefing();
          player.seekTo(currentPos);
          if (wasPlaying) player.audio.play().catch(() => {});
          toast(`Now playing: read by ${v.name}.`);
        } else {
          toast(`${v.name}'s recording isn't ready for this edition yet.`, { error: true });
        }
        $('narratorSheet')?.close();
      } catch (err) {
        toast(err.message, { error: true });
      } finally {
        btn.classList.remove('busy');
      }
    });
    return btn;
  }));
}

/* -------------------------------------------------------------- side widgets */
function renderNextCard() {
  const card = $('nextCard');
  if (!card) return;
  const time = state.profile?.settings?.delivery_time || '06:30';
  const [hStr, mStr] = time.split(':');
  const hNum = parseInt(hStr, 10) || 6;
  const ampm = hNum >= 12 ? 'PM' : 'AM';
  const displayH = hNum % 12 || 12;
  const displayTime = `${displayH}:${mStr || '30'}`;

  card.replaceChildren(
    h('header', { class: 'side-card-head' },
      h('span', { class: 'cat-tile cat-neutral' }, icon('clock')),
      h('h3', {}, "Tomorrow's Brief"),
      h('span', { class: 'live-dot', 'aria-hidden': 'true' })
    ),
    h('div', { class: 'next-time' }, displayTime, h('small', {}, ampm)),
    h('p', { class: 'hint' }, 'Freshly curated and voiced before you wake.'),
    h('button', {
      type: 'button',
      class: 'side-toggle',
      onclick: () => switchTab('settings'),
      'aria-label': 'Adjust delivery schedule in settings',
    },
      icon('bell'),
      h('span', {}, 'Delivery & push settings'),
      icon('chev-r')
    ),
    h('div', { class: 'side-foot' },
      h('span', {}, icon('refresh'), 'Automated daily at sunrise'),
      h('span', {}, '7 topics')
    )
  );
}

function renderLineupCard() {
  const card = $('lineupCard');
  if (!card) return;
  const b = state.briefing;
  if (!b || !b.sections?.length) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const totalStories = b.stories?.length || 1;
  const items = b.sections.map((sec) => {
    const count = b.stories.filter((s) => s.section === sec.key).length;
    const pct = Math.round((count / totalStories) * 100);
    return h('div', { class: `lineup-item cat-${sec.key}` },
      h('b', {}, sec.title),
      h('span', {}, `${count} ${count === 1 ? 'story' : 'stories'}`),
      h('div', { class: 'bar' }, h('i', { style: `width:${pct}%; --cat: var(--c-${sec.key}, var(--accent))` }))
    );
  });
  card.replaceChildren(
    h('header', { class: 'side-card-head' },
      h('span', { class: 'cat-tile cat-top' }, icon('playlist')),
      h('h3', {}, "Today's Lineup")
    ),
    h('div', { class: 'lineup-list' }, ...items)
  );
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
  const card = $('archiveCard');
  if (!box) return;
  const dates = state.archiveDates;
  const show = dates.length >= 2;
  box.classList.toggle('hidden', !show);
  if (card) card.classList.toggle('hidden', !show);
  box.replaceChildren(...dates.map((d) => {
    const isCur = d === state.briefing?.date;
    const b = h('button', { class: 'dchip' + (isCur ? ' active' : ''), type: 'button' },
      h('span', {}, chipLabel(d)),
      h('small', {}, isCur ? 'Active' : d)
    );
    b.addEventListener('click', () => selectDate(d));
    return b;
  }));
}

async function selectDate(date) {
  try {
    const pack = await loadStoryPack(date);
    if (pack) {
      state.briefing = pack;
      displayBriefing();
      return;
    }
    state.briefing = null;
    displayBriefing();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* ----------------------------------------------------------------- sections */
function audioLen(story) {
  const secs = Math.round((story.end || 0) - (story.start || 0));
  return secs < 60 ? `${secs}s audio` : `${fmtTime(secs)}`;
}

function storyRow(story) {
  const sec = SECTIONS[story.section] || SECTIONS.top;
  const secKey = story.section || 'top';
  const row = h('article', { class: 'story-row', dataset: { id: story.id } });

  const dot = h('button', { class: 'play-dot', type: 'button', 'aria-label': `Play from: ${story.headline}` },
    icon('play', 'i-play'),
    icon('pause', 'i-pause'),
    h('span', { class: 't' }, fmtTime(story.start || 0)));

  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    if (player.current === story.id) player.toggle();
    else player.playChapter(story.id);
  });

  const catTile = h('div', { class: `story-tile cat-tile cat-${secKey}` },
    icon(sec.icon || 'globe'),
    h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'))
  );

  const main = h('div', { class: 'story-main' },
    catTile,
    h('div', { class: 'story-text' },
      h('div', { class: 'story-meta' },
        h('span', { class: `badge badge-cat cat-${secKey}` }, sec.title),
        h('span', { class: 'dur' }, icon('clock'), audioLen(story)),
        h('span', {}, '·'),
        h('span', {}, story.source || 'The Guardian'),
        story.also?.length ? h('span', {}, `· +${story.also.length} source${story.also.length === 1 ? '' : 's'}`) : null
      ),
      h('h3', {}, story.headline),
      story.summary ? h('p', { class: 'story-snippet' }, story.summary) : null
    ),
    story.image ? h('img', {
      class: 'story-thumb', src: story.image, alt: '', loading: 'lazy', decoding: 'async',
      referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove(),
    }) : null,
    dot
  );

  const detail = h('div', { class: 'story-detail hidden' },
    h('p', { class: 'summary' }, story.summary),
    story.also?.length ? h('p', { class: 'also' }, `Also covered by ${story.also.join(', ')}`) : null,
    h('div', { class: 'story-actions' },
      h('button', { class: 'pill-btn sm', type: 'button', onclick: () => player.playChapter(story.id) }, icon('play'), 'Play from here'),
      story.url ? h('a', { class: 'pill-btn glass-btn sm', href: story.url, target: '_blank', rel: 'noopener noreferrer' }, 'Read article', icon('external')) : null
    ),
    reportRow(story)
  );

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
  const listHead = $('listHead');
  const storyCount = $('storyCount');

  if (!b) {
    if (listHead) listHead.classList.add('hidden');
    box.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Not published yet'),
      h('p', {}, "Today's brief is recorded once each morning for everyone. Reload in a minute, or set your topics in Sources.")));
    return;
  }

  if (listHead) {
    listHead.classList.remove('hidden');
    if (storyCount) storyCount.textContent = `${b.stories.length}`;
  }

  const currentSection = (() => {
    const ch = player.chapters.find((c) => c.id === player.current);
    return b.stories.find((s) => s.id === ch?.id)?.section;
  })();

  let secNum = 1;
  const blocks = (b.sections || []).flatMap((sec) => {
    const stories = b.stories.filter((s) => s.section === sec.key);
    if (!stories.length) return [];
    const here = currentSection === sec.key;
    const head = h('div', { class: 'section-head' },
      h('span', { class: 'num' }, String(secNum++).padStart(2, '0')),
      h('span', { class: 'overline' }, sec.title),
      h('span', { class: 'count' }, `· ${stories.length} ${stories.length === 1 ? 'story' : 'stories'}`),
      here
        ? h('span', { class: 'here' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), player.isPlaying ? 'Playing' : 'Paused')
        : h('button', {
            class: 'play-section', type: 'button',
            'aria-label': `Play ${sec.title}`,
            onclick: () => { player.seekTo(stories[0].start || 0); player.audio.play().catch(() => {}); },
          }, icon('play'), 'Play section')
    );
    const list = h('div', { class: 'section-list' }, ...stories.map(storyRow));
    const block = h('div', { class: 'section-block', dataset: { section: sec.key } }, head, list);
    return [block];
  });

  box.replaceChildren(...blocks);
  syncPlaying();
  followChapter();
  applySearch($('searchInput')?.value);
}

/* ----------------------------------------------------------- search & text size */
function applySearch(query) {
  const q = (query || '').trim().toLowerCase();
  const rows = document.querySelectorAll('.story-row');
  let matchCount = 0;
  rows.forEach((row) => {
    const id = row.dataset.id;
    const story = state.briefing?.stories.find((s) => s.id === id);
    if (!story) return;
    const text = `${story.headline} ${story.summary || ''} ${story.source || ''}`.toLowerCase();
    const match = !q || text.includes(q);
    row.classList.toggle('hidden', !match);
    if (match) matchCount++;
  });
  document.querySelectorAll('.section-block').forEach((block) => {
    const visibleStories = block.querySelectorAll('.story-row:not(.hidden)');
    block.classList.toggle('hidden', visibleStories.length === 0);
  });
  let empty = document.getElementById('searchEmptyNotice');
  if (q && matchCount === 0) {
    if (!empty) {
      empty = h('div', { id: 'searchEmptyNotice', class: 'search-empty' },
        h('h3', {}, 'No stories found'),
        h('p', {}, `No stories match "${query}".`)
      );
      $('sections')?.appendChild(empty);
    }
  } else if (empty) {
    empty.remove();
  }
}

function setTextSize(size) {
  document.documentElement.dataset.textSize = size;
  try { localStorage.setItem('mb-text-size', size); } catch { /* ignore */ }
  document.querySelectorAll('#textSize button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.size === size);
  });
}

function syncPlaying() {
  const id = player.current;
  document.querySelectorAll('.story-row').forEach((row) => {
    const on = row.dataset.id === id;
    row.classList.toggle('current', on);
    row.classList.toggle('playing-now', on && player.isPlaying);
    const dot = row.querySelector('.play-dot');
    if (!dot) return;
    const label = on && player.isPlaying ? 'Pause' : `Play from: ${row.querySelector('h3')?.textContent || ''}`;
    dot.setAttribute('aria-label', label);
  });
}

/**
 * Reading along: the story being read stays open and in view, unless the listener is
 * scrolling themselves — then we keep our hands off the page for a few seconds.
 */
function followChapter() {
  const id = player.current;
  let row = null;
  document.querySelectorAll('.story-row').forEach((r) => {
    const mine = r.dataset.id === id;
    if (mine) row = r;
    r.querySelector('.story-detail')?.classList.toggle('hidden', !mine);
  });
  if (!id || !row || !player.isPlaying || Date.now() - lastScroll < 8000) return;
  if (player.heroInView) return; // Don't scroll window away from hero card while user is reading along
  window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - 96, behavior: 'smooth' });
}

/* ------------------------------------------------------------------ report */
const REPORT_REASONS = [['inaccurate', 'Wrong or misleading'], ['offensive', 'Offensive or harmful'], ['broken', "Doesn't match the article"], ['other', 'Something else']];
let reportStory = null;
let reportReason = null;
/** When the listener last scrolled, so follow-along can stay out of their way. */
let lastScroll = 0;

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

/** The day's shared clips assembled for this listener; null when there is no pack at all.
 *
 * Today's pack may not be published yet (the nightly job hasn't run), so for today only we fall
 * back to the most recent one and flag it, rather than showing an empty player. */
async function loadStoryPack(day) {
  const today = new Date().toLocaleDateString('en-CA');
  try {
    const { settings } = await api.settings();
    let date = day;
    let rows = await api.storyAudio(day);
    if (!rows.length && day === today) {
      const latest = await api.latestStoryDate();
      if (!latest) return null;
      date = latest;
      rows = await api.storyAudio(date);
    }
    if (!rows.length) return null;
    const notes = await api.voiceNotes(date);
    const briefing = buildPackBriefing(rows, settings, { date, voice: settings.voice, notes });
    if (!briefing) return null;
    // A day is playable only once its narrator's clips and framing are all published. Without this
    // a pack that is mid-recording, or being re-recorded, plays two voices inside one brief.
    if (!notes.some((n) => n.note_key === READY_KEY && n.voice === briefing.voice.id)) return null;
    briefing.fresh = date === today;
    return briefing;
  } catch {
    return null;  // no pack that day, or the story_audio table isn't there yet
  }
}

/* ----------------------------------------------------------------- loading */
/** One honest line under the brief: where it came from, and who read it. */
function setFootnote() {
  const b = state.briefing;
  $('footnote').textContent = b ? `The Guardian · read by ${b.voice?.name || 'the narrator'}` : '';
}

function displayBriefing() {
  if (state.briefing) player.load(state.briefing);
  setFootnote();
  renderHeader();
  renderHero();
  renderNotice();
  renderPersonas();
  renderNextCard();
  renderLineupCard();
  renderDateChips();
  renderSections();
}
window.displayBriefing = displayBriefing;

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
  if (tab === 'admin' && !isAdmin(state.profile)) return;
  currentTab = tab;
  document.querySelectorAll('#tabbar .tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  for (const p of ['today', 'sources', 'settings', 'admin']) {
    document.getElementById(`page-${p}`).classList.toggle('hidden', p !== tab);
  }
  window.scrollTo({ top: 0 });
  if (tab === 'sources' && !sourcesPage) {
    sourcesPage = new SourcesPage({ onDirty: syncSaveBar });
    try { await sourcesPage.load(); } catch (err) { recordError(err, 'sourcesPage.load'); toast("Couldn't load your sources.", { error: true }); }
  }
  if (tab === 'settings' && !settingsPage) {
    settingsPage = new SettingsPage({
      onDirty: syncSaveBar,
      goSources: () => switchTab('sources'),
      email: state.profile?.email,
      setRate: (rate) => player.setRate(rate),
    });
    try { await settingsPage.load(); } catch (err) { recordError(err, 'settingsPage.load'); toast("Couldn't load settings.", { error: true }); }
  }
  if (tab === 'admin' && !adminPage) {
    adminPage = new AdminPage();
    try { await adminPage.load(); } catch (err) { recordError(err, 'adminPage.load'); toast("Couldn't load admin state.", { error: true, ms: 6000 }); }
  }
  // Back on Today the hero card takes over; the floating player returns when it scrolls away.
  if (tab === 'today') player.showMini();
  syncMini();
  syncSaveBar();
}

/** APK mini-player rule: on other tabs it shows whenever there's something to resume. */
function syncMini() {
  // On Today the hero card owns it: the floating player waits until the card is out of view.
  if (currentTab === 'today') return player.showMini();
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
  $('installBtn')?.addEventListener('click', install);
  wireSheet($('installSheet'));
  onInstallChange(syncInstallBtn);
  $('themeToggle')?.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  document.addEventListener('mb-theme', syncThemeIcon);
  $('reportSend')?.addEventListener('click', sendReport);
  wireSheet($('reportSheet'));

  // Search input & keyboard shortcut
  $('searchInput')?.addEventListener('input', (e) => applySearch(e.target.value));

  // Text size toggles
  document.querySelectorAll('#textSize button').forEach((btn) => {
    btn.addEventListener('click', () => setTextSize(btn.dataset.size));
  });

  // Action buttons
  $('reorderBtn')?.addEventListener('click', () => switchTab('sources'));
  $('playAllBtn')?.addEventListener('click', () => {
    player.seekTo(0);
    player.audio.play().catch(() => {});
  });
  const narrSheet = $('narratorSheet');
  if (narrSheet) wireSheet(narrSheet);
  const openNarratorSheet = () => {
    renderPersonas();
    narrSheet?.showModal();
  };
  $('narratorChip')?.addEventListener('click', openNarratorSheet);
  $('heroNarratorBtn')?.addEventListener('click', openNarratorSheet);
  $('avatarBtn')?.addEventListener('click', () => switchTab('settings'));

  // Transcript full text / compact view toggle
  const transBox = $('transcript');
  const transExpandBtn = $('transcriptExpandBtn');
  const transExpandLabel = $('transcriptExpandLabel');
  transExpandBtn?.addEventListener('click', () => {
    const isExpanded = transBox?.classList.toggle('expanded');
    transExpandBtn.setAttribute('aria-expanded', String(!!isExpanded));
    if (transExpandLabel) transExpandLabel.textContent = isExpanded ? 'Compact' : 'Full text';
  });

  player.addEventListener('chapter', syncPlaying);
  player.addEventListener('chapter', followChapter);
  player.addEventListener('chapter', syncMini);
  player.addEventListener('state', syncPlaying);
  player.addEventListener('state', syncMini);
  // Follow-along stands down for a moment whenever the listener scrolls the page.
  const noteScroll = () => { lastScroll = Date.now(); };
  for (const ev of ['scroll', 'wheel', 'touchstart']) window.addEventListener(ev, noteScroll, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog[open]') || e.metaKey || e.ctrlKey) return;
    if (e.key === '/') {
      e.preventDefault();
      $('searchInput')?.focus();
      return;
    }
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
  document.body.classList.remove('booting');
  document.body.classList.add('signed-out');
  $('login').classList.remove('hidden');
  if (!landing) landing = new Landing({ onSignedIn: enterApp });
  await landing.show();
}

async function enterApp() {
  landing?.stop();
  document.body.classList.remove('booting', 'signed-out');
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
  syncAdminTab();
  const st = state.profile?.settings || {};
  if (state.profile && !st.onboarded && !st.name) welcome.open(state.status);
  else if (state.profile && !st.push_offered && pushSupported() && Notification.permission === 'default') welcome.open(state.status, { askName: false });
}

/* -------------------------------------------------------------------- boot */
async function start() {
  document.body.classList.remove('booting');
  state.briefingLoading = true;
  renderNotice();
  $('sections').replaceChildren(...Array.from({ length: 3 }, () => h('div', { class: 'skeleton' })));
  const today = new Date().toLocaleDateString('en-CA');
  try {
    const [status, profile] = await Promise.all([api.status(), api.profile()]);
    state.status = status;
    state.profile = profile;
    syncAdminTab();
    applyPhotoMode(profile?.settings?.color_photos);
    renderHeader();
    renderPersonas();
    renderNextCard();
    renderLineupCard();
    await loadArchive();
    // The shared pack *is* the briefing now. When today's hasn't been published yet,
    // loadStoryPack falls back to the most recent one and renderNotice says so.
    state.briefing = await loadStoryPack(today);
    state.briefingLoading = false;
    displayBriefing();
  } catch (err) {
    state.briefingLoading = false;
    recordError(err, 'loadBriefing');
    const cached = store.get('last-briefing', null);
    if (cached?.audio_url?.startsWith('http')) {
      state.briefing = cached;
      displayBriefing();
      toast('Offline mode active. Showing your saved briefing.', { error: true, ms: 5000 });
    } else {
      renderHeader();
      renderNotice();
      renderHero();
      renderSections();
      toast("Couldn't reach the briefing service. Please try again shortly.", { error: true, ms: 5000 });
    }
  } finally {
    document.body.classList.remove('booting');
  }
}

async function init() {
  window.addEventListener('error', (e) => { recordError(e.error || e.message, 'window.onerror'); });
  window.addEventListener('unhandledrejection', (e) => { recordError(e.reason, 'window.unhandledrejection'); });
  syncThemeIcon();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeIcon);
  setTextSize(localStorage.getItem('mb-text-size') || 'md');
  bindEvents();
  syncInstallBtn();
  syncAdminTab();
  renderHeader();
  renderNotice();
  renderPersonas();
  renderNextCard();
  renderLineupCard();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') { started = false; state.profile = null; syncAdminTab(); showLanding(); }
    else if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) setTimeout(enterApp, 0);
  });
  try {
    let session = null;
    try { session = await api.session(); } catch { /* offline */ }
    if (session) { await enterApp(); return; }
    if (store.get('last-briefing', null) && !navigator.onLine) {
      document.body.classList.remove('booting', 'signed-out');
      started = true;
      await start();
      return;
    }
    await showLanding();
  } catch (err) {
    recordError(err, 'app.init');
    await showLanding();
  } finally {
    document.body.classList.remove('booting');
  }
}

init();
