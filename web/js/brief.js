// Client-side briefing builder: the whole pipeline runs in the browser, no
// worker needed. RSS via /api/fetch, summaries via /api/llm with the user's
// own free key, speech via /api/tts with the user's free key. The result is
// shaped exactly like a worker-built briefing so the player, cards and tabs
// work unchanged.

// ------------------------------------------------------------------ voices
// Voice ids look like "gemini:Kore" or "groq:tara".
export const VOICES = [
  // Gemini prebuilt voices, free tier on gemini-2.5-flash-preview-tts.
  { id: 'gemini:Kore', provider: 'gemini', name: 'Kore', accent: 'American', gender: 'female', description: 'Mid-range, expressive', recommended: true },
  { id: 'gemini:Charon', provider: 'gemini', name: 'Charon', accent: 'American', gender: 'male', description: 'Baritone, news-anchor' },
  { id: 'gemini:Puck', provider: 'gemini', name: 'Puck', accent: 'American', gender: 'male', description: 'High, conversational' },
  { id: 'gemini:Aoede', provider: 'gemini', name: 'Aoede', accent: 'American', gender: 'female', description: 'Alto, neutral' },
  { id: 'gemini:Fenrir', provider: 'gemini', name: 'Fenrir', accent: 'American', gender: 'male', description: 'Deep, calm' },
  { id: 'gemini:Leda', provider: 'gemini', name: 'Leda', accent: 'American', gender: 'female', description: 'Bright, warm' },
  // Orpheus voices through Groq's /audio/speech endpoint.
  { id: 'groq:tara', provider: 'groq', name: 'Tara', accent: 'American', gender: 'female', description: 'Orpheus via Groq', recommended: true },
  { id: 'groq:leah', provider: 'groq', name: 'Leah', accent: 'American', gender: 'female', description: 'Orpheus via Groq' },
  { id: 'groq:jess', provider: 'groq', name: 'Jess', accent: 'American', gender: 'female', description: 'Orpheus via Groq' },
  { id: 'groq:leo', provider: 'groq', name: 'Leo', accent: 'American', gender: 'male', description: 'Orpheus via Groq' },
  { id: 'groq:dan', provider: 'groq', name: 'Dan', accent: 'American', gender: 'male', description: 'Orpheus via Groq' },
  { id: 'groq:mia', provider: 'groq', name: 'Mia', accent: 'American', gender: 'female', description: 'Orpheus via Groq' },
  { id: 'groq:zac', provider: 'groq', name: 'Zac', accent: 'American', gender: 'male', description: 'Orpheus via Groq' },
  { id: 'groq:wendy', provider: 'groq', name: 'Wendy', accent: 'American', gender: 'female', description: 'Orpheus via Groq' },
];

export const LLM_PROVIDERS = {
  groq: { label: 'Groq', models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], keyLabel: 'Groq API key', keyUrl: 'https://console.groq.com/keys' },
  gemini: { label: 'Gemini', models: ['gemini-2.5-flash', 'gemini-2.0-flash'], keyLabel: 'Gemini API key', keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { label: 'OpenRouter', models: ['meta-llama/llama-3.3-70b-instruct:free'], keyLabel: 'OpenRouter API key', keyUrl: 'https://openrouter.ai/keys' },
};

const SYSTEM_PROMPT = `You write copy for a warm, trustworthy morning audio news briefing for listeners in Canada.
The spoken text is read aloud by a text-to-speech voice, so it is written for the ear; the summary appears on a news card.

Return a JSON object with exactly these keys:
- "headline": a clear, neutral headline of at most 12 words.
- "summary": the card text, 40 to 60 words of plain factual prose built only from the supplied text.
- "spoken": what the host says, as an array of 2 to 4 beats, 45 to 85 words in all. The first beat is the news itself, who did what, in one sentence; then the key detail; then why it matters or what happens next.

How the spoken beats should sound:
- Like a calm radio host talking to one listener: plain words, contractions, active voice.
- Sentences of 8 to 20 words, with the subject and verb near the start.
- Attribution after the fact, not before it: "The plant will close in March, the company said."
- Commas only where a speaker would breathe. No semicolons, colons, dashes, brackets or quotation marks; paraphrase quotes instead.
- Numbers the way people say them: rounded, written as digits with "percent" and "dollars" in words.
- Never name the news outlet or say "reports" or "according to" about it. Start with the news itself.
- No URLs, emoji, lists or markdown.

Stay strictly factual and neutral. Never add facts that aren't in the text; if the text is thin, say less.`;

// ------------------------------------------------------------------ helpers
export async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('morning-brief', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('audio');
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbTx(store, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const st = tx.objectStore(store);
    const out = fn(st);
    tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => reject(tx.error);
  });
}
export const audioCache = {
  get: (key) => idbTx('audio', 'readonly', (s) => s.get(key)).catch(() => undefined),
  set: (key, blob) => idbTx('audio', 'readwrite', (s) => s.put(blob, key)).catch(() => {}),
};
export const briefingCache = {
  get: (key) => idbTx('meta', 'readonly', (s) => s.get(key)).catch(() => undefined),
  set: (key, val) => idbTx('meta', 'readwrite', (s) => s.put(val, key)).catch(() => {}),
};

const stripHtml = (html) => {
  const d = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  return (d.body.textContent || '').replace(/\s+/g, ' ').trim();
};

// ------------------------------------------------------------------ feeds
async function fetchFeed(url) {
  const r = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error(`Feed returned ${r.status}`);
  const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Not a readable feed');
  const items = [...xml.querySelectorAll('item'), ...xml.querySelectorAll('entry')];
  return items.map((it) => {
    const q = (sel) => it.querySelector(sel)?.textContent?.trim() || '';
    const link = it.querySelector('link')?.getAttribute('href') || q('link') || q('guid');
    const img = it.querySelector('media\\:content, content, enclosure')?.getAttribute('url') || '';
    return {
      title: stripHtml(q('title')).slice(0, 200),
      link: link.trim(),
      desc: stripHtml(q('description') || q('summary') || it.querySelector('content\\:encoded')?.textContent || '').slice(0, 2000),
      pubDate: Date.parse(q('pubDate') || q('published') || q('updated')) || 0,
      image: /^https?:.*\.(png|jpe?g|webp|gif)(\?|$)/i.test(img) ? img : '',
    };
  }).filter((i) => i.title && i.link);
}

function rankItems(items, weight) {
  const now = Date.now();
  return items
    .map((i) => ({ ...i, score: (weight || 1) * (i.pubDate ? Math.max(0.2, 1 - (now - i.pubDate) / (36e5 * 36)) : 0.4) }))
    .sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------ script
function extractive(desc) {
  const sents = (desc || '').match(/[^.!?]+[.!?]+/g) || [];
  const summary = sents.slice(0, 2).join(' ').trim().slice(0, 400) || 'Details are still coming in.';
  return { headline: '', summary, spoken: [summary] };
}

async function summarize(story, llm) {
  if (!llm?.apiKey) return { ...extractive(story.desc), writer: 'built-in' };
  const text = `Headline: ${story.title}\n\n${story.desc}`.slice(0, 3000);
  const r = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: llm.provider, apiKey: llm.apiKey, model: llm.model, maxTokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Write briefing copy for this story:\n\n${text}` },
      ],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `Summarizer failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  let parsed;
  try { parsed = JSON.parse(data.text); } catch { throw new Error('The summarizer returned garbled text.'); }
  if (!parsed.summary) throw new Error('The summarizer returned an empty summary.');
  return {
    headline: (parsed.headline || story.title).slice(0, 140),
    summary: parsed.summary,
    spoken: Array.isArray(parsed.spoken) && parsed.spoken.length ? parsed.spoken : [parsed.summary],
    writer: llm.provider,
  };
}

function sectionLead(topics, i, city) {
  const topic = topics[i].replace('{city}', city || 'your area');
  const cap = topic[0].toUpperCase() + topic.slice(1) + '.';
  if (topics.length === 1) return cap;
  if (i === 0) return `First, ${topic}.`;
  if (i === topics.length - 1) return `And finally, ${topic}.`;
  return `Next, ${topic}.`;
}

export function buildScript({ storiesBySection, sectionMeta, name, date, weather, saySources, city }) {
  const dateStr = date.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
  const hello = name ? `Good morning, ${name}!` : 'Good morning!';
  const intro = `${hello} It's ${dateStr}. ${weather ? weather + ' ' : ''}Here's your briefing.`;
  const outro = `That's your briefing for this ${date.toLocaleDateString('en-CA', { weekday: 'long' })}. Have a wonderful day, and I'll talk to you tomorrow morning.`;
  const topics = [...storiesBySection.keys()].map((k) => sectionMeta[k]?.topic || sectionMeta[k]?.title || k);
  const segments = [{ key: 'intro', kind: 'section', title: 'Intro', text: intro }];
  const stories = [];
  let i = 0;
  for (const [section, list] of storiesBySection) {
    const lead = sectionLead(topics, i, city);
    i++;
    list.forEach((s, j) => {
      const beats = [...s.copy.spoken];
      if (saySources) beats.push(`From ${s.source}.`);
      const text = `${j === 0 ? lead + ' ' : ''}${beats.join('\n')}`;
      segments.push({ key: s.id, kind: 'story', title: s.copy.headline || s.title, text });
      stories.push(s);
    });
  }
  segments.push({ key: 'outro', kind: 'section', title: 'Outro', text: outro });
  return { segments, stories, intro, outro };
}

// ------------------------------------------------------------------ speech
function chunkText(text, max = 900) {
  const sents = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sents) {
    if ((cur + s).length > max && cur) { chunks.push(cur.trim()); cur = ''; }
    cur += s + ' ';
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

async function ttsChunk(text, tts) {
  const cacheKey = `tts:${tts.provider}:${tts.voice}:${await sha256(text)}`;
  const hit = await audioCache.get(cacheKey);
  if (hit) return hit;
  const [provider, voice] = tts.voice.split(':');
  const r = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, apiKey: tts.apiKey, text, voice }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const err = new Error(data.error || `Voice failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  const blob = new Blob([await r.arrayBuffer()], { type: 'audio/wav' });
  await audioCache.set(cacheKey, blob);
  return blob;
}

// Decode every chunk, lay them end to end at 24 kHz, re-encode as one WAV.
async function concatWav(blobs) {
  const ctx = new OfflineAudioContext(1, 44100, 44100);
  const buffers = [];
  for (const b of blobs) {
    const ab = await b.arrayBuffer();
    buffers.push(await ctx.decodeAudioData(ab.slice(0)));
  }
  const sr = 24000;
  const out = new OfflineAudioContext(1, Math.max(1, buffers.reduce((n, x) => n + Math.round((x.length / x.sampleRate) * sr), 0)), sr);
  let at = 0;
  const durations = [];
  for (const buf of buffers) {
    const src = out.createBufferSource();
    src.buffer = buf;
    src.connect(out.destination);
    src.start(at / sr);
    const len = Math.round((buf.length / buf.sampleRate) * sr);
    durations.push(len / sr);
    at += len;
  }
  const rendered = await out.startRendering();
  const data = rendered.getChannelData(0);
  const wav = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(wav);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wstr(36, 'data'); v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return { blob: new Blob([wav], { type: 'audio/wav' }), durations };
}

// ------------------------------------------------------------------ weather
async function getWeather(lat, lon, city) {
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weathercode&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`);
    const j = await r.json();
    const deg = (v) => (v < 0 ? `minus ${Math.abs(Math.round(v))}` : String(Math.round(v)));
    const codes = { 0: 'clear skies', 1: 'mostly clear skies', 2: 'partly cloudy skies', 3: 'cloudy skies', 45: 'fog', 48: 'fog', 51: 'light drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 95: 'a thunderstorm' };
    const cond = codes[j.current?.weathercode] || 'fair skies';
    const now = Math.round(j.current?.temperature_2m ?? 0);
    const high = Math.round(j.daily?.temperature_2m_max?.[0] ?? now);
    const low = Math.round(j.daily?.temperature_2m_min?.[0] ?? now);
    const precip = j.daily?.precipitation_probability_max?.[0] ?? 0;
    let line = `In ${city} it's ${deg(now)} degrees right now, heading for a high of ${deg(high)} with ${cond}.`;
    if (precip >= 40) line += ` There's a ${precip} percent chance of rain, so grab an umbrella.`;
    return { line, card: { now, high, low, city, conditions: cond } };
  } catch { return { line: '', card: null }; }
}

// ------------------------------------------------------------------ builder
export async function buildBriefing({ settings, builtin, customSources, catalog, onProgress }) {
  const tick = (step, f) => onProgress?.(step, f);
  const date = new Date();
  const dateKey = date.toLocaleDateString('en-CA');
  const counts = settings.stories || {};
  const llm = {
    provider: settings.llm_provider || 'groq',
    model: settings.llm_model || LLM_PROVIDERS[settings.llm_provider || 'groq'].models[0],
    apiKey: (settings.llm_keys || {})[settings.llm_provider || 'groq'] || '',
  };
  const tts = {
    voice: VOICES.some((v) => v.id === settings.voice) ? settings.voice : 'gemini:Kore',
    apiKey: '',
  };
  const [ttsProvider] = tts.voice.split(':');
  tts.apiKey = (settings.llm_keys || {})[ttsProvider] || '';
  if (!tts.apiKey) throw new Error(`Add your ${LLM_PROVIDERS[ttsProvider]?.label || ttsProvider} API key in Settings to voice the briefing.`);

  // 1. Fetch feeds.
  tick('Reading your sources', 0.05);
  const sectionMeta = Object.fromEntries(catalog.sections.map((s) => [s.key, s]));
  const bySection = new Map();
  const seen = new Set();
  const jobs = [];
  for (const src of builtin) {
    if ((counts[src.section] || 0) <= 0) continue;
    jobs.push((async () => {
      try {
        const items = await fetchFeed(src.url);
        return { section: src.section, weight: src.weight || 1, name: src.name, items };
      } catch { return { section: src.section, weight: src.weight || 1, name: src.name, items: [] }; }
    })());
  }
  for (const src of customSources) {
    if ((counts.custom || 0) <= 0) break;
    const feedUrl = src.feed_url || src.url;
    jobs.push((async () => {
      try {
        const items = await fetchFeed(feedUrl);
        return { section: 'custom', weight: src.weight || 1, name: src.name, items };
      } catch { return { section: 'custom', weight: src.weight || 1, name: src.name, items: [] }; }
    })());
  }
  const feeds = await Promise.all(jobs);
  tick('Picking the top stories', 0.25);

  // 2. Rank and pick.
  const storiesBySection = new Map();
  for (const key of Object.keys(counts)) {
    const n = counts[key] || 0;
    if (!n) continue;
    const pool = [];
    for (const f of feeds) {
      if (f.section !== key) continue;
      for (const it of rankItems(f.items, f.weight)) {
        const id = (await sha256(it.link)).slice(0, 16);
        if (seen.has(id)) continue;
        seen.add(id);
        pool.push({ id, section: key, source: f.name, title: it.title, url: it.link, desc: it.desc, image: it.image, published: it.pubDate ? new Date(it.pubDate).toISOString() : null, score: it.score });
      }
    }
    pool.sort((a, b) => b.score - a.score);
    if (pool.length) storiesBySection.set(key, pool.slice(0, n));
  }
  if (![...storiesBySection.values()].some((l) => l.length)) {
    throw new Error("Couldn't read any of your sources. Check your connection and try again.");
  }

  // 3. Summarize.
  const all = [...storiesBySection.values()].flat();
  let done = 0;
  let writer = 'built-in';
  for (const s of all) {
    tick(`Writing ${done + 1} of ${all.length}`, 0.25 + (0.35 * done) / all.length);
    try {
      const copy = await summarize(s, llm);
      s.copy = copy;
      if (copy.writer !== 'built-in') writer = copy.writer;
    } catch (err) {
      if (err.status === 401) throw new Error('Your API key was rejected. Check it in Settings.');
      s.copy = { ...extractive(s.desc), headline: s.title, writer: 'built-in' };
    }
    done++;
  }

  // 4. Weather + script.
  tick('Checking the weather', 0.62);
  const wx = settings.weather === false ? { line: '', card: null }
    : await getWeather(settings.latitude || 43.6532, settings.longitude || -79.3832, settings.city || 'Toronto');
  const { segments, stories } = buildScript({
    storiesBySection, sectionMeta,
    name: settings.name || '', date, weather: wx.line,
    saySources: !!settings.say_sources, city: settings.city || 'Toronto',
  });

  // 5. Speak.
  const blobs = [];
  for (let i = 0; i < segments.length; i++) {
    tick(`Recording ${i + 1} of ${segments.length}`, 0.65 + (0.25 * i) / segments.length);
    const chunks = chunkText(segments[i].text);
    const parts = [];
    for (const c of chunks) parts.push(await ttsChunk(c, tts));
    // Stitch the chunk wavs for this segment back together (skip re-encode per chunk).
    blobs.push(parts.length === 1 ? parts[0] : (await concatWav(parts)).blob);
  }

  // 6. Assemble one audio file + chapters.
  tick('Putting it together', 0.93);
  const { blob: audio, durations } = await concatWav(blobs);
  let at = 0;
  const chapters = segments.map((s, i) => {
    const ch = { id: s.key, kind: s.kind, title: s.title, start: at };
    at += durations[i] || 0;
    return ch;
  });
  stories.forEach((s) => {
    const ch = chapters.find((c) => c.id === s.id);
    s.start = ch ? ch.start : 0;
    s.end = s.start + (durations[chapters.indexOf(ch)] || 0);
    s.headline = s.copy.headline || s.title;
    s.summary = s.copy.summary;
  });

  const voiceName = (VOICES.find((v) => v.id === tts.voice) || {}).name || tts.voice;
  const briefing = {
    date: dateKey,
    title: "Today's briefing",
    duration: at,
    stories: stories.map(({ copy, score, desc, ...s }) => s),
    sections: [...storiesBySection.keys()].map((key) => ({
      key, title: sectionMeta[key]?.title || key, count: storiesBySection.get(key).length,
    })),
    chapters,
    voice: { name: voiceName },
    weather: wx.card,
    writer: writer === 'built-in' ? 'built-in' : 'ai',
    generated_at: new Date().toISOString(),
    notes: [],
  };
  if (writer === 'built-in') {
    briefing.notes.push({ level: 'info', message: 'Summaries were written by the built-in summarizer. Add a free AI key in Settings for richer summaries.' });
  }
  await briefingCache.set(`briefing:${dateKey}`, { briefing, audio });
  return { briefing, audio };
}

// Load today's locally-built briefing (audio included).
export async function loadLocalBriefing(dateKey) {
  const row = await briefingCache.get(`briefing:${dateKey}`);
  if (!row) return null;
  return { briefing: row.briefing, audio: row.audio };
}
