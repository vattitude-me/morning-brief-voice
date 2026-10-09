# The Daily Cloud Pack Run

`python -m app pack` voices the day's stories once per narrator and publishes them to Supabase Storage.
Everything else follows from that: clients refuse a day until its narrator is marked ready, so a
morning with no pack shows the previous day instead of something half-made.

## Cloud Architecture

The system is designed for an on-demand, stateless cloud model that spins up, uses temporary storage,
publishes directly to Supabase Storage, and immediately spins down to zero when idle:

```
[Cloud Scheduler (05:00 AM)]
        │
        ▼
[Cloud Run Job / Worker]  ──► [Chatterbox-Turbo GPU Voice Service]
        │                            │
        │ fetch news & scripts       │ synthesizes audio clips
        │                            ▼
        │                    [Temporary memory / buffer]
        │                            │
        └────────────────────────────┼─────────────────────────┐
                                     ▼                         ▼
                        [Supabase Storage: briefings/]   [Supabase DB: story_audio]
                                     │
                                     ▼
                           [Spin down to 0 ($0 idle)]
```

## Running the Pack

### 1. Cloud Scheduler (Production 05:00 AM)
Set up using `scripts/setup-scheduler.sh`:
- Cloud Scheduler triggers the Cloud Run Job `morning-brief-pack` at 05:00 AM every morning.
- The job boots, fetches news, voices clips via Chatterbox-Turbo, uploads to Supabase, and exits.
- When idle, compute resources scale to 0.

### 2. Manual / CLI Run
To run immediately on demand:
```bash
# Automated run with on-demand GPU VM spin-up and spin-down
./scripts/daily_pack_run.sh

# Or directly if VOICE_SERVICE_URL is active
python3 -m app pack --notify
```

### 3. Voice Narrators (Chatterbox-Turbo)
- **Alice** (`her_reference`): Warm, measured British narrator.
- **Mike** (`him_reference`): Calm, steady American narrator.
Each narrator voices 35 stories (5 per section across 7 sections) in ~12 minutes.

### 4. Cleanup & Retention
One day of audio is kept: a successful pack deletes older days from Supabase Storage and database
tables (`prune_older`), ensuring minimal storage usage.
