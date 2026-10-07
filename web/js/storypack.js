// The shared daily story pack, mirrored from app/storypack.py.
//
// The worker voices each day's stories once and publishes them as clips in Supabase
// Storage. This module picks the clips a given listener asked for and lays them out
// on one timeline, so the player can play them back to back with no server-side merge.
import { SECTIONS } from './api.js';
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

/** Order the shared rows into one listener's clip list: section order, then rank. */
export function clipsFor(rows, wanted) {
  const bySection = new Map();
  for (const row of rows || []) {
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
 * Turn the day's shared rows into a briefing the existing UI and player understand.
 * Returns `null` when the listener's lineup selects nothing (or the day has no pack).
 */
export function buildBriefing(rows, settings, { date, voice } = {}) {
  const chosen = clipsFor(rows, lineup(settings));
  if (!chosen.length) return null;

  const clips = [];
  const stories = [];
  const chapters = [];
  const counts = new Map();
  let cursor = 0;

  for (const row of chosen) {
    const duration = Number(row.duration) || 0;
    const start = round(cursor);
    const end = round(cursor + duration);
    const id = `${row.section}-${row.rank}`;
    stories.push({
      id, section: row.section, source: row.source || 'The Guardian',
      headline: row.title, summary: row.script || '', url: row.url || null,
      image: null, start, end,
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
    voice: { name: voice || chosen[0].voice || 'Cloned narrator' },
    writer: 'guardian',
    weather: null,
    sections, chapters, stories, clips,
    notes: [],
  };
}
