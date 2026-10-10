// Admin tab: the day's shared pack, and the switch that re-records it.
// The tab appears for the admin account only. Every action is checked again server-side:
// row-level security on `build_requests`, then the worker, then the batch lock.
import { BUILTIN_VOICES, SECTIONS, VOICES, api, deleteCustomVoice, h, icon, saveCustomVoice, toast } from '../api.js';
import { READY_KEY } from '../storypack.js';
import { processReferenceAudio } from '../audio-processor.js';
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
    this.log = [];
    this.logError = null;
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
      const [status, dates, requests, log] = await Promise.all([
        api.status().catch(() => ({ running: false })),
        api.storyDates().catch(() => [today()]),
        api.packRequests().catch(() => []),
        api.runLog(3).catch((err) => { this.logError = err?.message || String(err); return []; }),
      ]);
      this.status = status || {};
      this.dates = [...new Set([today(), ...(dates || [])])].slice(0, 10);
      if (!this.dates.includes(this.day)) this.day = this.dates[0];
      this.requests = requests || [];
      this.log = log || [];
      this.pack = await api.packState(this.day).catch(() => null);
    } catch (err) {
      console.warn('Admin load failed, rendering fallback UI:', err);
    } finally {
      this.render();
      this.keepWatching();
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

      SectionLabel('Recent runs', { detail: 'Last three days, newest first' }),
      this.logGroup(),

      SectionLabel('Narrators & Voice Studio', { detail: 'Active voices, reference audio & Chatterbox-Turbo 24kHz formatter' }),
      this.narratorsGroup(),

      SectionLabel('Rebuild the audio', { detail: 'One recording, heard by every listener' }),
      this.rebuildGroup(),

      SectionLabel(`Pack for ${dayLabel(this.day)}`, { detail: 'What is published right now' }),
      this.packGroup(),

      SectionLabel('Requests', { detail: 'One job runs at a time' }),
      this.requestsGroup(),

      SectionLabel('System Diagnostics & Error Log', { detail: 'Captured client & network exceptions' }),
      this.diagnosticsGroup(),

      Hint('A full rebuild takes about as long as the audio it records, so give it a few minutes.'),
    );
  }

  narratorsGroup() {
    const list = h('div', { class: 'narrators-admin-list' }, ...VOICES.map((v) => {
      const isCustom = !v.builtin;
      const avatar = h('span', { class: 'narrator-avatar' }, icon(v.icon || 'mic'));
      const text = h('div', { class: 'narrator-info' },
        h('div', { class: 'narrator-title-row' },
          h('span', { class: 'narrator-name' }, v.name),
          h('span', { class: 'tag-ink' }, v.id),
          isCustom ? h('span', { class: 'tag-ink tag-warn' }, 'Custom') : h('span', { class: 'tag-ink tag-accent' }, 'Standard')
        ),
        h('p', { class: 'narrator-meta' }, `${v.gender === 'female' ? 'Female' : 'Male'} · ${v.style || v.desc || 'Spoken news'}`)
      );

      const actions = h('div', { class: 'narrator-actions' });
      if (isCustom) {
        const delBtn = h('button', {
          type: 'button',
          class: 'pill-btn glass-btn sm',
          style: 'color:var(--err); padding: .25rem .6rem;',
          title: `Delete voice ${v.name}`,
          onclick: () => {
            if (confirm(`Remove custom narrator "${v.name}" (${v.id})?`)) {
              deleteCustomVoice(v.id);
              this.voices.delete(v.id);
              toast(`Removed narrator ${v.name}.`);
              this.render();
            }
          },
        }, icon('trash'), 'Delete');
        actions.appendChild(delBtn);
      }

      return h('div', { class: 'narrator-item' }, avatar, text, actions);
    }));

    // Form inputs
    let processedAudio = null;
    let audioUrl = null;

    const nameInput = h('input', { type: 'text', class: 'text-input sm', placeholder: 'e.g. Jerry Seinfeld, C-3PO' });
    const idInput = h('input', { type: 'text', class: 'text-input sm', placeholder: 'e.g. jerry_reference' });
    nameInput.addEventListener('input', () => {
      if (!idInput.dataset.manual) {
        idInput.value = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_reference';
      }
    });
    idInput.addEventListener('input', () => { idInput.dataset.manual = 'true'; });

    const genderSelect = h('select', { class: 'text-input sm' },
      h('option', { value: 'male' }, 'Male'),
      h('option', { value: 'female' }, 'Female')
    );
    const styleInput = h('input', { type: 'text', class: 'text-input sm', placeholder: 'e.g. Observational comedy style' });
    const iconSelect = h('select', { class: 'text-input sm' },
      h('option', { value: 'smile' }, 'Smile (Comedy / Warm)'),
      h('option', { value: 'bot' }, 'Bot (Droid / Tech)'),
      h('option', { value: 'mic' }, 'Mic (Broadcast)'),
      h('option', { value: 'radio' }, 'Radio (Crisp News)'),
      h('option', { value: 'spark' }, 'Spark (Unique Character)')
    );

    const statusBadge = h('div', { class: 'audio-status-badge hidden' });
    const audioPreview = h('audio', { controls: true, class: 'audio-preview-player hidden' });
    const downloadBtn = h('button', {
      type: 'button',
      class: 'pill-btn glass-btn sm hidden',
      onclick: () => {
        if (!processedAudio?.blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(processedAudio.blob);
        a.download = `${idInput.value.trim() || 'voice_reference'}.wav`;
        a.click();
      },
    }, icon('download'), 'Download 24kHz WAV');

    const fileInput = h('input', { type: 'file', accept: 'audio/*', class: 'file-input-hidden' });
    const dropzone = h('div', { class: 'audio-dropzone', onclick: () => fileInput.click() },
      icon('wave'),
      h('div', { class: 'dropzone-text' },
        h('b', {}, 'Select or drop voice recording'),
        h('small', {}, 'Accepts any format (WAV, MP3, M4A, AAC). Auto-converted to 24kHz Mono 16-bit PCM WAV.')
      )
    );

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      statusBadge.className = 'audio-status-badge busy';
      statusBadge.textContent = 'Converting to 24kHz Mono 16-bit PCM WAV…';
      statusBadge.classList.remove('hidden');

      try {
        processedAudio = await processReferenceAudio(file);
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        audioUrl = URL.createObjectURL(processedAudio.blob);
        audioPreview.src = audioUrl;
        audioPreview.classList.remove('hidden');
        downloadBtn.classList.remove('hidden');

        statusBadge.className = 'audio-status-badge ' + (processedAudio.isOptimal ? 'ok' : (processedAudio.isUsable ? 'warn' : 'err'));
        const durStr = `${processedAudio.duration.toFixed(1)}s`;
        const sizeStr = `${(processedAudio.sizeBytes / 1024).toFixed(0)} KB`;
        statusBadge.textContent = `✓ 24,000 Hz Mono WAV (${durStr}, ${sizeStr}) · ${processedAudio.isOptimal ? 'Optimal length for Chatterbox-Turbo' : (processedAudio.isUsable ? 'Usable (8-30s recommended)' : 'Too short (<5.0s)')}`;
      } catch (err) {
        statusBadge.className = 'audio-status-badge err';
        statusBadge.textContent = `Conversion error: ${err.message}`;
      }
    });

    const saveBtn = PillButton('Save Narrator', {
      iconName: 'plus',
      onClick: async () => {
        const name = nameInput.value.trim();
        const id = idInput.value.trim();
        if (!name || !id) {
          toast('Please enter a narrator name and voice ID.', { error: true });
          return;
        }
        if (processedAudio && !processedAudio.isUsable) {
          toast('Reference clip is too short. Chatterbox-Turbo requires >= 5.0 seconds.', { error: true });
          return;
        }

        saveBtn.classList.add('busy');
        try {
          const newVoice = {
            id,
            name,
            gender: genderSelect.value,
            style: styleInput.value.trim() || 'Custom narrator',
            desc: styleInput.value.trim() || 'Custom narrator',
            icon: iconSelect.value,
            duration: processedAudio?.duration ? Math.round(processedAudio.duration) : null,
          };

          if (processedAudio?.blob) {
            toast(`Uploading 24kHz reference audio for ${name}…`);
            await api.uploadVoiceFile(id, processedAudio.blob);
          }

          saveCustomVoice(newVoice);
          this.voices.add(id);
          toast(`✓ Narrator "${name}" registered with 24kHz reference WAV.`);
          this.render();
        } catch (err) {
          toast(err.message, { error: true });
        } finally {
          saveBtn.classList.remove('busy');
        }
      },
    });

    return GlassGroup(
      list,
      Hairline(),
      h('div', { class: 'add-voice-form' },
        h('h3', { class: 'form-title' }, 'Add Narrator & Format Reference Audio'),
        h('div', { class: 'form-grid' },
          h('label', {}, 'Narrator Name', nameInput),
          h('label', {}, 'Voice ID (Reference)', idInput),
          h('label', {}, 'Gender', genderSelect),
          h('label', {}, 'Style / Delivery', styleInput),
          h('label', {}, 'Icon', iconSelect)
        ),
        fileInput,
        dropzone,
        statusBadge,
        audioPreview,
        h('div', { class: 'form-actions' }, downloadBtn, saveBtn)
      )
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

  /**
   * The morning's own record. The same line is pushed to the admin's phone, but a phone can be
   * asleep, out of data or signed out, so the report is written here where it cannot be missed.
   */
  logGroup() {
    if (this.logError) {
      return GlassGroup(
        ListRow({ label: 'Not switched on yet' }),
        Hint('The database needs the run log section of supabase/schema.sql. Run it in the Supabase SQL editor, then reload.'),
      );
    }
    if (!this.log.length) {
      return GlassGroup(
        ListRow({ label: 'Nothing reported yet' }),
        Hint('Every pack and every morning report writes a line here, whether or not the phone was told.'),
      );
    }
    const rows = [];
    let day = null;
    for (const entry of this.log) {
      if (entry.run_date !== day) {
        day = entry.run_date;
        rows.push(h('div', { class: 'run-log-day' }, dayLabel(day)));
      }
      rows.push(h('div', { class: 'run-log-entry' },
        h('div', { class: 'run-log-head' },
          h('span', { class: `run-log-dot ${entry.status}` }),
          h('span', { class: 'run-log-title' }, entry.title),
          h('span', { class: 'run-log-time' }, at(entry.created_at))),
        entry.body && entry.body !== entry.title ? h('p', { class: 'run-log-body' }, entry.body) : null,
        entry.detail && entry.detail !== entry.body
          ? h('div', { class: 'run-log-meta' },
              h('span', { class: 'run-log-badge' }, entry.detail.startsWith('Took') ? `⏱ ${entry.detail}` : entry.detail))
          : null,
        entry.voices?.length
          ? h('div', { class: 'run-log-voices' },
            ...entry.voices.map((v) => h('span', { class: v.ready ? '' : 'bad' },
              `${v.name} ${v.ready ? 'ready' : 'missing'}`)))
          : null));
    }
    return GlassGroup(h('div', { class: 'run-log', role: 'log' }, ...rows));
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

  diagnosticsGroup() {
    const logs = api.diagnostics() || [];
    if (!logs.length) {
      return GlassGroup(
        ListRow({
          label: 'System status normal',
          detail: 'No unhandled errors or network failures recorded.',
          value: '✓ Healthy',
          color: 'var(--ok)',
        }),
      );
    }
    const copyBtn = PillButton('Copy diagnostics', {
      iconName: 'share',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
          toast('Copied diagnostics report to clipboard.', { type: 'success' });
        } catch {
          toast('Unable to access clipboard.', { error: true });
        }
      },
    });
    const clearBtn = PillButton('Clear error log', {
      iconName: 'trash',
      onClick: () => {
        api.clearDiagnostics();
        this.render();
        toast('Error log cleared.', { type: 'success' });
      },
    });

    const rows = logs.slice(0, 10).flatMap((err) => {
      const summary = h('div', { class: 'diag-entry' },
        h('div', { class: 'diag-head' },
          h('span', { class: 'diag-dot' }),
          h('span', { class: 'diag-ctx' }, err.context || 'App'),
          h('span', { class: 'diag-time' }, at(err.timestamp))),
        h('p', { class: 'diag-msg' }, err.message),
        err.stack ? h('details', { class: 'diag-stack-wrap' },
          h('summary', {}, 'Stack trace'),
          h('pre', { class: 'diag-stack' }, err.stack)) : null);
      return [summary, Hairline()];
    });
    rows.pop();

    return GlassGroup(
      ...rows,
      h('div', { class: 'admin-actions', style: 'margin-top:12px;display:flex;gap:8px;' }, copyBtn, clearBtn),
    );
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
