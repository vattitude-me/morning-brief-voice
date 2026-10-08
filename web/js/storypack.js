// The shared daily story pack, mirrored from app/storypack.py.
//
// The worker voices each day's stories once and publishes them as clips in Supabase
// Storage. This module picks the clips a given listener asked for and lays them out
// on one timeline, so the player can play them back to back with no server-side merge.
import { SECTIONS, voiceName } from './api.js';
import { SUPABASE_URL } from '../config.js';

/** Reading order — the same seven categories the worker publishes (app/guardian.py). */
export const SECTION_ORDER = ['top', 'ai', 'tech', 'politics', 'entertainment', 'science', 'sports'];
export const MAX_PER_SECTION = 5;

/** The per-section story counts a user asked for (0 = off), clamped to 0..MAX. */
export function lineup(settings) {
  const chosen = (settings && settings.stories) || {};
  const out = {};
  for (const key of SECTION_ORDER) {
    const n = Number.parseInt(chosen[key], 10);
    out[key] = Number.isFinite(n) ? Math.max(0, Math.min(n, MAX_PER_SECTION)) : 0;
  }
  return out;
}

/** The public Storage URL for a clip's object path. */
export function clipUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/public/briefings/${path}`;
}

/**
 * Which voice's clips to play: the one this listener picked, or — when that recording isn't
 * published (a render that failed, or a voice they used to have) — whichever one is there.
 */
export function pickVoice(rows, chosen) {
  const ids = (rows || []).map((r) => r.voice).filter(Boolean);
  if (!ids.length) return null;
  if (chosen && ids.includes(chosen)) return chosen;
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Order one listener's clips: their voice, then section order, then rank. */
export function clipsFor(rows, wanted, voice) {
  const bySection = new Map();
  for (const row of rows || []) {
    if (voice && row.voice !== voice) continue;
    if (!bySection.has(row.section)) bySection.set(row.section, []);
    bySection.get(row.section).push(row);
  }
  const ordered = [];
  for (const key of SECTION_ORDER) {
    const count = wanted[key] || 0;
    if (count <= 0) continue;
    const picked = (bySection.get(key) || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0)).slice(0, count);
    ordered.push(...picked);
  }
  return ordered;
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * A breath between two clips, in seconds. Without it the end of one story runs into the start of
 * the next and the two read as a single sentence. It is a real silent clip rather than a delay in
 * the player, so the timeline stays true: story times, seeking and the total all count it.
 */
export const BREATH = 0.8;
const GAP_URL = '/audio/gap.mp3';

/**
 * The marker note a narrator's day carries once every clip and every spoken note is published
 * (app/storypack.py). A day without it is still being recorded, so its audio must not be played.
 */
export const READY_KEY = 'pack_ready';

/** Which greeting to open with, by the listener's local hour (mirrors app/storypack.py). */
export function greetingKey(hour = new Date().getHours()) {
  if (hour < 12) return 'greeting_morning';
  if (hour < 17) return 'greeting_afternoon';
  return 'greeting_evening';
}

/**
 * Turn the day's shared rows into a briefing the existing UI and player understand.
 *
 * `notes` are the pre-voiced greeting and section intros: the greeting opens the brief
 * (picked from the clock) and each section's line plays before its first story, so it
 * reads like a programme rather than a playlist. Notes become clusters on the same
 * timeline, so they are seekable and never overlap a story.
 *
 * Returns `null` when the listener's lineup selects nothing (or the day has no pack).
 */
export function buildBriefing(rows, settings, { date, voice, notes = [], hour } = {}) {
  const id = pickVoice(rows, voice);
  const chosen = clipsFor(rows, lineup(settings), id);
  if (!chosen.length) return null;

  const byKey = new Map(
    (notes || []).filter((n) => !id || n.voice === id).map((n) => [n.note_key, n]),
  );

  const clips = [];
  const stories = [];
  const chapters = [];
  const counts = new Map();
  let cursor = 0;

  /** A silent clip between two voiced ones, so a story never starts on the last word. */
  const breath = () => {
    if (!cursor) return;
    const start = round(cursor);
    const end = round(cursor + BREATH);
    clips.push({ id: `gap-${clips.length}`, url: GAP_URL, duration: BREATH, section: null, rank: 0,
      title: '', start, end, gap: true });
    cursor += BREATH;
  };

  const sayNote = (key) => {
    const note = byKey.get(key);
    if (!note) return;
    breath();
    const duration = Number(note.duration) || 0;
    const start = round(cursor);
    const end = round(cursor + duration);
    clips.push({ id: key, url: clipUrl(note.audio_path), duration, section: null, rank: 0,
      title: note.text, start, end, note: true });
    chapters.push({ id: key, kind: 'note', title: note.text, start, end });
    cursor += duration;
  };

  sayNote(greetingKey(hour));

  let currentSection = null;
  for (const row of chosen) {
    if (row.section !== currentSection) {
      sayNote(`intro_${row.section}`);
      currentSection = row.section;
    }
    breath();
    const duration = Number(row.duration) || 0;
    const start = round(cursor);
    const end = round(cursor + duration);
    const id = `${row.section}-${row.rank}`;
    stories.push({
      id, section: row.section, source: row.source || 'The Guardian',
      headline: row.title, summary: row.script || '', url: row.url || null,
      image: row.image || null, start, end,
    });
    chapters.push({ id, kind: 'story', title: row.title, start, end, section: row.section });
    clips.push({
      id, url: clipUrl(row.audio_path), duration, section: row.section, rank: row.rank,
      title: row.title, start, end,
    });
    counts.set(row.section, (counts.get(row.section) || 0) + 1);
    cursor += duration;
  }

  const sections = SECTION_ORDER
    .filter((key) => counts.has(key))
    .map((key) => ({ key, title: SECTIONS[key].title, count: counts.get(key) }));

  return {
    date,
    title: 'Your briefing',
    duration: round(cursor),
    generated_at: new Date().toISOString(),
    voice: { id, name: voiceName(id) },
    writer: 'guardian',
    weather: null,
    sections, chapters, stories, clips,
    notes: [],
  };
}
