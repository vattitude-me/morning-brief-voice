// Admin tab: the day's shared pack, and the switch that re-records it.
// The tab appears for the admin account only. Every action is checked again server-side:
// row-level security on `build_requests`, then the worker, then the batch lock.
import { SECTIONS, VOICES, api, h, toast } from '../api.js';
import { READY_KEY } from '../storypack.js';
import {
  CheckDot, GlassGroup, Hairline, Hint, ListRow, Overline, PillButton, SectionLabel, SwitchRow,
} from '../design.js';

const today = () => new Date().toLocaleDateString('en-CA');
const minutes = (seconds) => `${(Number(seconds || 0) / 60).toFixed(1)} min`;
const at = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null);
const KINDS = {
  pack: 'Rebuild the audio',
  build: 'Rebuild one briefing',
  push_test: 'Test notification',
  delete_account: 'Delete account',
};

function dayLabel(date) {
  if (date === today()) return 'Today';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (date === y.toLocaleDateString('en-CA')) return 'Yesterday';
  return new Date(`${date}T12:00`).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
}

export class AdminPage {
  constructor() {
    this.root = document.querySelector('#page-admin .screen');
    this.status = {};
    this.pack = null;
    this.requests = [];
    this.dates = [];
    this.day = today();
    this.voices = new Set(VOICES.map((v) => v.id));   // both narrators unless trimmed
    this.notesOnly = false;
    this.force = false;
    this.waiting = null;     // the request this page is following
    this.timer = null;
    this.loading = false;
  }

  async load() {
    if (this.loading) return;
    this.loading = true;
    try {
      const [status, dates, requests] = await Promise.all([api.status(), api.storyDates(), api.packRequests()]);
      this.status = status;
      this.dates = [...new Set([today(), ...(dates || [])])].slice(0, 10);
      if (!this.dates.includes(this.day)) this.day = this.dates[0];
      this.requests = requests;
      this.pack = await api.packState(this.day);
      this.render();
      this.keepWatching();
    } finally {
      this.loading = false;
    }
  }

  /** Follows a run that is already going, whoever started it. */
  keepWatching() {
    clearTimeout(this.timer);
    const busy = this.status?.running || this.waiting;
    if (!busy) return;
    this.timer = setTimeout(async () => {
      try { this.status = await api.status(); } catch { /* try again on the next tick */ }
      this.render();
      this.keepWatching();
    }, 4000);
  }

  render() {
    const st = this.status || {};
    this.root.replaceChildren(
      h('header', { class: 'screen-header' },
        h('div', { class: 'overline-row' }, Overline(st.running ? 'Working' : 'Idle')),
        h('h1', { class: 'display' }, 'Admin')),

      SectionLabel('The morning run'),
      this.runGroup(st),

      SectionLabel('Rebuild the audio', { detail: 'One recording, heard by every listener' }),
      this.rebuildGroup(),

      SectionLabel(`Pack for ${dayLabel(this.day)}`, { detail: 'What is published right now' }),
      this.packGroup(),

      SectionLabel('Requests', { detail: 'One job runs at a time' }),
      this.requestsGroup(),

      Hint('A full rebuild takes about as long as the audio it records, so give it a few minutes.'),
    );
  }

  runGroup(st) {
    const last = st.last_run || {};
    const pack = st.last_pack || {};
    const bar = h('div', { class: 'progress-bar' }, h('span', { style: `width:${Math.round((st.progress || 0) * 100)}%` }));
    return GlassGroup(
      ListRow({ label: 'Schedule', value: `${st.batch_time || '—'} · ${st.timezone || '—'}` }),
      Hairline(),
      ListRow({
        label: 'Last run',
        detail: last.date ? `${last.date}${last.summary ? ` · ${last.summary}` : ''}` : 'Nothing recorded yet',
        value: last.date ? (last.ok ? 'OK' : 'Issues') : null,
      }),
      Hairline(),
      ListRow({
        label: st.running ? 'Running now' : 'Idle',
        detail: st.running ? (st.step || 'Working') : 'Nothing running',
        end: st.running ? bar : null,
      }),
      Hairline(),
      ListRow({
        label: 'Last rebuild from here',
        detail: pack.at ? (pack.detail || pack.error || '') : 'None since the page was added',
        value: pack.at ? at(pack.at) : null,
        color: pack.ok === false ? 'var(--err)' : null,
      }),
    );
  }

  rebuildGroup() {
    const dayChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Day to publish under' },
      ...this.dates.map((d) => {
        const b = h('button', { type: 'button', class: 'dchip' + (d === this.day ? ' active' : '') }, dayLabel(d));
        b.addEventListener('click', () => this.pickDay(d));
        return b;
      }));

    const voiceRows = VOICES.flatMap((v) => {
      const on = this.voices.has(v.id);
      const row = h('button', {
        type: 'button', class: 'list-row clickable', 'aria-pressed': String(on),
      },
      h('div', { class: 'list-row-text' },
        h('span', { class: 'list-row-label' }, v.name),
        h('span', { class: 'list-row-detail' }, v.gender === 'female' ? 'A woman reads the news' : 'A man reads the news')),
      CheckDot(on));
      row.addEventListener('click', () => {
        if (this.voices.has(v.id)) this.voices.delete(v.id); else this.voices.add(v.id);
        this.render();
      });
      return [row, Hairline()];
    });

    const button = PillButton(this.waiting ? 'Rebuilding…' : 'Rebuild the audio', {
      iconName: 'refresh', onClick: () => this.queue(),
    });
    if (this.waiting) button.disabled = true;

    return GlassGroup(
      dayChips,
      Hairline(),
      ...voiceRows,
      SwitchRow('Greeting and intros only', this.notesOnly, {
        detail: 'Re-record the framing, leave the stories alone',
        onChange: (on) => { this.notesOnly = on; this.render(); },
      }),
      Hairline(),
      SwitchRow('Re-record every clip', this.force, {
        detail: 'Off reuses a story already published for that day',
        onChange: (on) => { this.force = on; this.render(); },
      }),
      Hairline(),
      h('div', { class: 'admin-actions' }, button),
    );
  }

  packGroup() {
    const clips = this.pack?.clips || [];
    const notes = this.pack?.notes || [];
    if (!clips.length && !notes.length) {
      return GlassGroup(
        ListRow({ label: 'Nothing published for this day' }),
        Hint('A rebuild here records whatever Guardian has right now and publishes it under this date.'),
      );
    }
    const wanted = Object.keys(SECTIONS).filter((k) => k !== 'custom');
    const rows = VOICES.flatMap((v) => {
      const mine = clips.filter((c) => c.voice === v.id);
      const have = new Set(mine.map((c) => c.section));
      const missing = wanted.filter((k) => !have.has(k));
      const seconds = mine.reduce((n, c) => n + (Number(c.duration) || 0), 0);
      // The readiness marker is a row in the notes table, not something anybody hears.
      const count = notes.filter((n) => n.voice === v.id && n.note_key !== READY_KEY).length;
      const published = notes.some((n) => n.voice === v.id && n.note_key === READY_KEY);
      return [
        ListRow({
          label: v.name,
          value: `${mine.length} clips · ${minutes(seconds)}`,
          detail: published
            ? `${count} ${count === 1 ? 'note' : 'notes'} · ${missing.length ? `missing ${missing.map((k) => SECTIONS[k].title).join(', ')}` : 'every section covered'}`
            : `still recording · ${count} ${count === 1 ? 'note' : 'notes'} so far`,
        }),
        Hairline(),
      ];
    });
    rows.pop();  // no divider under the last row
    return GlassGroup(...rows);
  }

  requestsGroup() {
    if (!this.requests.length) return GlassGroup(ListRow({ label: 'Nothing requested yet' }));
    const rows = this.requests.flatMap((r) => [
      ListRow({
        label: KINDS[r.kind] || r.kind,
        detail: r.message || (r.status === 'queued' ? 'Waiting for the worker to pick it up' : ''),
        value: `${r.status} · ${at(r.finished_at || r.created_at)}`,
        color: r.status === 'error' ? 'var(--err)' : null,
      }),
      Hairline(),
    ]);
    rows.pop();
    return GlassGroup(...rows);
  }

  async pickDay(day) {
    this.day = day;
    try {
      this.pack = await api.packState(day);
    } catch (err) {
      toast(err.message, { error: true });
    }
    this.render();
  }

  async queue() {
    if (!this.voices.size) { toast('Pick at least one narrator.', { error: true }); return; }
    try {
      const id = await api.queuePack({
        day: this.day, voices: [...this.voices], notesOnly: this.notesOnly, force: this.force,
      });
      this.waiting = { id, status: 'queued', message: '' };
      toast('Queued. The worker picks it up within a minute.');
      this.render();
      await this.follow(id);
    } catch (err) {
      toast(err.message, { error: true, ms: 9000 });
    }
  }

  /** Waits on our own request, refreshing progress as it runs and the pack when it ends. */
  async follow(id) {
    const row = await api.waitForRequest(id, {
      timeoutMs: 90 * 60 * 1000,
      onTick: async (r) => {
        this.waiting = r;
        try { this.status = await api.status(); } catch { /* keep the last reading */ }
        this.render();
      },
    });
    this.waiting = null;
    toast(row.message || 'Finished.', { error: row.status !== 'done', ms: 9000 });
    try { await this.load(); } catch (err) { toast(err.message, { error: true }); }
  }
}
