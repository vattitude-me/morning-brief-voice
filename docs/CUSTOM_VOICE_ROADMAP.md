# Custom Voices & User Sound Styles Roadmap

This document outlines the architectural and product roadmap for introducing **user-cloned voices**, **sound styles**, and **monetization** to Morning Brief.

---

## 1. Product Vision & Hierarchy

Rather than a single voice per user, users can create multiple distinct **Sound Styles** (e.g. *"Morning Coffee"*, *"Evening Unwind"*, *"Punchy Anchor"*).

### Data Model: One-to-Many Relationship (User ──► Voices)

```
┌─────────────────────────────────┐
│           auth.users            │
│  (id, email, subscription_tier) │
└────────────────┬────────────────┘
                 │ 1
                 │
                 │ N
┌────────────────▼──────────────────────────────────────────────────┐
│                      public.user_voices                           │
├───────────────────────────────────────────────────────────────────┤
│ id           UUID PRIMARY KEY DEFAULT gen_random_uuid()           │
│ user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE     │
│ name         TEXT NOT NULL (e.g. "My Morning Energy")             │
│ style_tag    TEXT NOT NULL ('upbeat' | 'calm' | 'anchor')         │
│ audio_url    TEXT NOT NULL (path to original master audio clip)   │
│ conds_url    TEXT NOT NULL (path to .conds.pt embedding in bucket)│
│ temperature  FLOAT DEFAULT 0.75                                   │
│ beat_pause   FLOAT DEFAULT 0.35                                   │
│ is_active    BOOLEAN DEFAULT false                                │
│ created_at   TIMESTAMPTZ DEFAULT now()                            │
└───────────────────────────────────────────────────────────────────┘
```

---

## 2. Unit Economics & Compute Costs

Because custom voices require per-user GPU rendering (unlike the shared daily pack for Alice, Mike, Jerry, and C-3PO), here is the exact compute cost breakdown:

| Cost Factor | Metric | Cost | Notes |
| :--- | :--- | :--- | :--- |
| **GPU Inference Time** | ~15–20 stories (custom user lineup) | ~6 minutes | NVIDIA L4 (24GB VRAM) running Chatterbox-Turbo |
| **Compute Rate** | Google Cloud / RunPod GPU rate | $0.70 / hour | ~$0.0117 per minute |
| **Daily Cost per User** | 6 min × $0.0117/min | **~$0.07 / briefing** | Only runs when user has an active schedule |
| **Monthly Compute** | 30 days × $0.07 | **~$2.10 / month** | Per active daily listener |
| **Storage (Supabase)** | ~15 MB per briefing (pruned after 48h) | **<$0.02 / month** | Negligible |

### Recommended Monetization Models

1. **Monthly Subscription ($9.99 – $14.99 / mo)**:
   - Unlimited daily briefings in their custom cloned voices.
   - **Gross Margin: 78% – 86%**.
2. **One-Time Voice Setup ($19.99) + Base Subscription ($4.99 / mo)**:
   - Covers onboarding verification and server-side voice conditioning.
3. **Multi-Style Pack Add-on**:
   - 1 Voice Style included in Pro; $2.99/mo per additional voice style slot.

---

## 3. Audio Ingestion & Conditioning Pipeline

When a user uploads an audio file (`.wav`, `.mp3`, `.m4a`), the automated cleaning pipeline prevents bad audio, echo, or background music from degrading the clone.

```
[User Audio Upload (.mp3 / .wav / .m4a)]
                   │
                   ▼
       [Audio Pre-processing Gate]
       1. Format Transcoding: Mono 24 kHz WAV via ffmpeg
       2. Voice Isolation: Run noisereduce / DeepFilterNet (strip AC hum & music)
       3. Loudness Normalization: Normalize to -20 LUFS
       4. VAD Slicing: Silero-VAD finds cleanest 12–15s continuous speech segment
                   │
                   ▼
       [Chatterbox-Turbo Embedding Engine]
       - Runs prepare_conditionals() on the 12s clean slice
       - Generates {voice_id}.turbo-v1.conds.pt (~170 KB)
                   │
                   ▼
       [Supabase Storage: voice_embeddings/{user_id}/{voice_id}.pt]
                   │
                   ▼
       [Ready for instant synthesis in daily briefings]
```

---

## 4. Sound Style Parameters

Different moods/cadences for the same speaker are achieved via two mechanisms:

1. **Reference Clip Delivery**:
   - An energetic 12s reference produces lively, upbeat synthesis.
   - A soft, bedtime-cadence reference produces calm, soothing news delivery.
2. **Inference Parameters** (in `voice_service/turbo_voice/engine.py`):
   - **Upbeat / Morning Energy**: `temperature=0.85`, `beat_pause=0.25s`
   - **Calm / Evening Reflection**: `temperature=0.65`, `beat_pause=0.50s`
   - **Authoritative Newsreader**: `temperature=0.70`, `beat_pause=0.35s`

---

## 5. Security & Deepfake Safeguards

1. **In-Audio Consent Attestation**:
   - Require user to speak or include a required verification sentence: *"I authorize Morning Brief to generate my daily news briefing in this voice."*
2. **Audio Watermarking**:
   - Maintain Perth watermarking (built into Chatterbox-Turbo) on all synthetic output so synthetic speech is transparently verifiable.
3. **Verified Accounts**:
   - Custom cloning restricted to authenticated users with a verified payment method on file.
