# Changelog

All notable changes to the **Morning Brief** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.35] - 2026-10-10

### Added
- **4 Distinct Neural Narrators**: Added full support and pre-rendered story packs for:
  - 🤖 **C-3PO** (`c3po_reference`) — Polite, precise protocol droid voice style.
  - 🎙️ **Jerry** (`jerry_reference`) — Observational wit and dynamic commentary.
  - 📻 **Alice** (`her_reference`) — Warm British newsreader.
  - 🎙️ **Mike** (`him_reference`) — Crisp American morning news anchor.
- **Anytime-of-Day Greetings**: Dynamic time-based greetings (`Good morning`, `Good afternoon`, `Good evening`) pre-voiced for every narrator to support morning, midday, and evening listening.
- **Transparent Web Fallback & Availability Indicators**:
  - Web client tracks `availableVoices` per briefing date.
  - Narrator picker sheet displays `Pending` badges for voices that haven't yet rendered for a given day.
  - Player honestly notifies listeners if an unrecorded voice was requested and fell back to an active narrator.
- **Automated GCE GPU Lifecycle**: Worker automatically starts the NVIDIA L4 GPU VM (`morning-brief-voice`) on GCE, renders story audio, and unconditionally halts the VM to prevent idle compute costs.
- **Voice Studio & Audio Tooling**: Added 24kHz audio formatter and reference audio synchronizer (`scripts/sync-voices-to-gce.sh`).

### Fixed
- **Android App**:
  - Gated the "your last brief couldn't be made" error banner exclusively to admin accounts.
  - Gracefully fallback to any pre-existing cached briefing for standard listeners.
  - Added auto-timeout dismiss behavior for transient error banners.
- **Cloud Run Batch Worker**:
  - Configured `STORY_VOICES` environment variable explicitly across Google Cloud Run and Cloud Scheduler to voice all 4 narrators every morning at 05:00 AM.
  - Fixed audio generation pipeline to prevent dropping voices during scheduled runs.

---

## [0.1.34] - 2026-10-10

### Added
- **PWA v2 UI Redesign**: Modern frosted-glass aesthetic with compact mobile headers, continuous scrub bars, and circular button invariants.
- **Integrated Read-Along Mode**: Live transcript auto-scrolling with synchronized chapter and story card highlights.
- **Compact Narrator Switcher**: Bottom sheet drawer for rapid 1-tap switching between voice personas.

### Fixed
- **Read-Along Truncation**: Fixed transcript clipping and scroll sync across iOS Safari, iPadOS, and Android Chrome.
- **Player Geometry**: Resolved squished play/pause button states on narrow mobile viewports.

---

## [0.1.33] - 2026-10-09

### Added
- **Spoken Outro Sign-off**: Added a polite closing note (`outro`) after the final story so briefings do not terminate abruptly.
- **Freshness & Archive Indicators**: Added visual pills distinguishing today's sunrise edition from older archived editions.

### Fixed
- **Pack Completeness Gate**: PWA and Android clients strictly enforce `pack_ready` marker verification before playing, preventing partial or mixed-voice briefings mid-render.

---

## [0.1.30 - 0.1.32] - 2026-10-08

### Added
- **Single-Source Guardian Shared Story Pack**: Switched primary daily briefing generation to The Guardian's 7 official editorial categories (`top`, `ai`, `tech`, `politics`, `entertainment`, `science`, `sports`).
- **Extractive Algorithmic Summarizer**: Integrated `trafilatura` article extraction with TF-based lead-paragraph summarization, eliminating LLM hallucinations and rate limits for daily news.
- **0.8s Breath Intervals**: Inserted natural silent audio pauses (`gap.mp3`) between stories and chapter intros to prevent abrupt sentence collisions.
- **Admin Audio Dashboard**: Added real-time monitoring and rebuild controls for published audio packs.

---

## [0.1.18 - 0.1.25] - 2026-10-06

### Added
- **3-Step Welcome Onboarding**: Streamlined first-run experience for topic selection and voice preference.
- **Story Photos Toggle**: Added support for high-resolution color lead photography on story cards.
- **Multi-Provider AI Fallback**: Added support for Bring-Your-Own-Key (BYOK) AI summaries via Google Gemini (Gemini 2.5/3 Flash), Groq, and OpenRouter for custom RSS sources.
- **Cloud Run Deployment**: Containerized batch worker deployed to Google Cloud Run with Cloud Scheduler triggers.

---

## [0.1.0 - 0.1.17] - 2026-10-01

### Added
- **Initial Native Android App**: Jetpack Compose application with Android Media3 background playback, lock-screen controls, and notification integration.
- **Web Progressive Web App (PWA)**: Desktop and mobile PWA with offline caching and responsive light/dark themes.
- **Supabase Backend**: User authentication (Google OAuth & magic links), profile settings sync, and Storage bucket for audio clips.
- **Account Management**: Self-service account deletion cascading through all user data and audio links.
