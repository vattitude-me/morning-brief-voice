// Data access: Supabase (auth, tables) with row-level security keeping each user to their own rows.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Briefing sections in reading order — the seven Guardian categories (app/guardian.py). */
export const SECTIONS = {
  top: { title: 'Top stories', emoji: '📰' },
  ai: { title: 'AI', emoji: '🤖' },
  tech: { title: 'Tech', emoji: '💻' },
  politics: { title: 'Politics', emoji: '🏛️' },
  entertainment: { title: 'Entertainment', emoji: '🎬' },
  science: { title: 'Science', emoji: '🔬' },
  sports: { title: 'Sports', emoji: '🏅' },
  // Not part of the narrated pack: the Sources tab's user-pasted links keep their own bucket.
  custom: { title: 'My Sources', emoji: '⭐' },
};

export const sectionLabel = (key) => { const s = SECTIONS[key] || SECTIONS.top; return `${s.emoji} ${s.title}`; };

/**
 * The narrators the pack records every morning (app/storypack.py). A listener picks one and
 * hears that recording; the clips are shared, so this is a choice of who reads, not a
 * per-listener recording.
 */
export const VOICES = [
  { id: 'her_reference', name: 'Alice', gender: 'female' },
  { id: 'him_reference', name: 'Mike', gender: 'male' },
];

/** The voice a listener picked, falling back to the first for anything older or unknown. */
export const voiceFor = (id) => VOICES.find((v) => v.id === id) || VOICES[0];
export const voiceName = (id) => voiceFor(id).name;

export const DEFAULT_SETTINGS = {
  name: '',
  voice: 'her_reference',
  speed: 1.0,
  daily: true,
  // Every section starts on, at three stories, so a first brief covers all seven.
  stories: { top: 3, ai: 3, tech: 3, politics: 3, entertainment: 3, science: 3, sports: 3 },
  color_photos: true,
  disabled_sources: [],
};

const FRIENDLY = [
  [/row-level security.*sources/i, 'You can have up to 25 links. Remove one to add another.'],
  [/duplicate key.*sources/i, "You've already added that link."],
  [/check constraint.*url/i, 'That doesn\'t look like a web link (it should start with https://).'],
  [/row-level security.*build_requests/i, 'Only admins can rebuild on demand for now.'],
  [/Failed to fetch|NetworkError|Load failed/i, "You're offline or the service can't be reached."],
];

function check({ data, error }) {
  if (error) {
    const raw = error.message || String(error);
    const hit = FRIENDLY.find(([re]) => re.test(raw));
    throw new Error(hit ? hit[1] : raw);
  }
  return data;
}

let me = null;
async function userId() {
  if (me) return me.id;
  const { data } = await sb.auth.getSession();
  if (!data.session) throw new Error('Please sign in again.');
  return data.session.user.id;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const api = {
  // ------------------------------------------------------------------ auth
  session: async () => (await sb.auth.getSession()).data.session,
  // Signs in, or creates the account on first use. The email links back here (plus a code if the template has one).
  sendCode: async (email) => check(await sb.auth.signInWithOtp({
    email, options: { shouldCreateUser: true, emailRedirectTo: location.origin },
  })),
  // Redirects to Google, then back here with a session in the URL (detectSessionInUrl picks it up).
  signInWithGoogle: async () => check(await sb.auth.signInWithOAuth({
    provider: 'google', options: { redirectTo: location.origin, queryParams: { prompt: 'select_account' } },
  })),
  verifyCode: async (email, token) => check(await sb.auth.verifyOtp({ email, token, type: 'email' })),
  signOut: () => sb.auth.signOut(),

  async profile() {
    const id = await userId();
    me = check(await sb.from('profiles').select('id,email,is_admin,settings,status').eq('id', id).single());
    return me;
  },

  // ------------------------------------------------------------- briefings
  async latest() {
    const rows = check(await sb.from('briefings').select('data').order('date', { ascending: false }).limit(1));
    return { briefing: rows[0]?.data || null };
  },
  async briefing(day) {
    const rows = check(await sb.from('briefings').select('data').eq('date', day).limit(1));
    return { briefing: rows[0]?.data || null };
  },
  /** The shared per-day clips every listener is merged from (see app/storypack.py). */
  async storyAudio(day) {
    const base = 'date,section,rank,voice,title,url,source';
    const rest = 'script,duration,audio_path';
    try {
      return check(await sb.from('story_audio')
        .select(`${base},image,${rest}`).eq('date', day)) || [];
    } catch {
      // The image column may not exist on an older schema; a brief without
      // thumbnails still works, so fall back rather than losing the whole brief.
      return check(await sb.from('story_audio')
        .select(`${base},${rest}`).eq('date', day)) || [];
    }
  },
  async storyDates() {
    const rows = check(await sb.from('story_audio').select('date').order('date', { ascending: false }).limit(120));
    return [...new Set((rows || []).map((r) => r.date))];
  },
  /** The day's greeting and section intros (see app/storypack.py). */
  async voiceNotes(day) {
    try {
      return check(await sb.from('voice_notes')
        .select('voice,note_key,text,duration,audio_path').eq('date', day)) || [];
    } catch {
      return [];  // table not created yet — a brief without framing still works
    }
  },
  /** The most recent date that has a pack — used when today's hasn't been published yet. */
  async latestStoryDate() {
    const rows = check(await sb.from('story_audio').select('date').order('date', { ascending: false }).limit(1));
    return rows[0]?.date || null;
  },
  async archive() {
    const rows = check(await sb.from('briefings').select('date').order('date', { ascending: false }));
    return { briefings: rows };
  },
  async status() {
    const rows = check(await sb.from('app_status').select('data').eq('id', 1).limit(1));
    return rows[0]?.data || {};
  },

  // -------------------------------------------------------------- requests
  async request(kind) {
    const row = check(await sb.from('build_requests').insert({ kind }).select('id').single());
    return row.id;
  },
  async waitForRequest(id, { timeoutMs = 20 * 60 * 1000, onTick } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const row = check(await sb.from('build_requests').select('status,message').eq('id', id).single());
      onTick?.(row);
      if (row.status === 'done' || row.status === 'error') return row;
      await wait(3000);
    }
    return { status: 'error', message: "The server hasn't picked this up. It may be asleep; try again after 7 AM." };
  },
  generate: () => api.request('build'),
  // The worker deletes the account; its request row goes with it, so "row gone" means done.
  async deleteAccount({ timeoutMs = 3 * 60 * 1000 } = {}) {
    let id;
    try { id = await api.request('delete_account'); } catch {
      throw new Error("Account deletion isn't switched on for this server yet. Please contact the admin.");
    }
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await wait(3000);
      const { data, error } = await sb.from('build_requests').select('status,message').eq('id', id).maybeSingle();
      if (error) continue;
      if (!data) return;
      if (data.status === 'error') throw new Error(data.message || "Your account couldn't be deleted.");
    }
    throw new Error("The server hasn't picked this up yet. Your account is queued for deletion; check back in a few minutes.");
  },

  // --------------------------------------------------------------- sources
  async report({ reason, note, headline, summary, url, source }) {
    return check(await sb.from('content_reports').insert({
      reason, note, headline, summary, url, source, writer: 'web', app: 'web',
    }));
  },
  async sources() {
    const [rows, profile] = await Promise.all([
      sb.from('sources').select('*').order('id').then(check),
      api.profile(),
    ]);
    const disabled = new Set(profile.settings?.disabled_sources || []);
    return {
      sources: rows.map((s) => ({ ...s, builtin: s.user_id == null, enabled: s.user_id == null ? !disabled.has(s.id) : s.enabled })),
    };
  },
  async addSource({ url, section, name }) {
    const row = check(await sb.from('sources').insert({ url, section, name: name || url }).select().single());
    return { source: row };
  },
  async updateSource(source, body) {
    if (source.builtin) {
      const profile = await api.profile();
      const disabled = new Set(profile.settings?.disabled_sources || []);
      if (body.enabled) disabled.delete(source.id); else disabled.add(source.id);
      return api.saveSettings({ disabled_sources: [...disabled] });
    }
    return check(await sb.from('sources').update(body).eq('id', source.id));
  },
  deleteSource: async (id) => check(await sb.from('sources').delete().eq('id', id)),

  // -------------------------------------------------------------- settings
  async settings() {
    const profile = await api.profile();
    const stored = profile.settings || {};
    return { settings: { ...DEFAULT_SETTINGS, ...stored, stories: { ...DEFAULT_SETTINGS.stories, ...(stored.stories || {}) } } };
  },
  async saveSettings(values) {
    const profile = await api.profile();
    const settings = { ...(profile.settings || {}), ...values };
    check(await sb.from('profiles').update({ settings }).eq('id', profile.id));
    me = { ...profile, settings };
    return { settings };
  },

  // ------------------------------------------------------------------ push
  async pushSubscribe(sub) {
    const row = { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, user_id: await userId() };
    return check(await sb.from('push_subscriptions').upsert(row, { onConflict: 'endpoint', ignoreDuplicates: true }));
  },
  pushUnsubscribe: async (sub) => check(await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)),
  async pushTest() {
    const id = await api.request('push_test');
    return api.waitForRequest(id, { timeoutMs: 3 * 60 * 1000 });
  },
};

// Tiny DOM helper: h('div', {class: 'x', onclick}, child, 'text')
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v; // only ever used with static markup
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const icon = (name, cls = '') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

export const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

// "07:05" → "7:05 AM"
export function clockLabel(hhmm) {
  if (!hhmm) return '';
  const [hr, min] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, hr, min).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
}

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`mb-${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`mb-${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

let toastTimer;
export function toast(message, { error = false, ms = 3500 } = {}) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
