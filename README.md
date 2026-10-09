<div align="center">

<img src="docs/play-store/feature-graphic.png" alt="Morning Brief — Your news, read aloud every morning" width="100%" style="border-radius: 16px; margin-bottom: 20px;" />

# ☀️ Morning Brief

**Wake up to the news, read aloud.**  
A calm, curated 5-minute audio briefing delivered every morning by a warm, natural neural voice.  
No ads. No algorithmic clickbait. Zero doom-scrolling.

[![Web PWA](https://img.shields.io/badge/Web-PWA_Ready-2f6fed?style=flat-square&logo=googlechrome&logoColor=white)](web/)
[![Android App](https://img.shields.io/badge/Android-APK_v0.2+-1a9b5b?style=flat-square&logo=android&logoColor=white)](android/)
[![Neural Voice](https://img.shields.io/badge/Voice-Chatterbox--Turbo-6a4cf5?style=flat-square)](voice_service/)
[![Privacy First](https://img.shields.io/badge/Privacy-No_Ads_%7C_No_Tracking-0D0D0D?style=flat-square)]()

[**Try Web Experience**](#-listen-on-the-web) · [**Get Android App**](#-get-the-android-app) · [**Features**](#-why-morning-brief) · [**Technical Guide**](docs/TECHNICAL.md)

</div>

---

## ☕ Why Morning Brief?

Start your morning smarter, calmer, and informed. While you make your coffee, head out for a run, or commute to work, **Morning Brief** gathers the stories that matter to you overnight and turns them into a high-quality, five-minute spoken audio briefing ready the moment you wake up.

* **🎙️ Natural Neural Narrators**: Voiced by warm, human-like narrators (**Alice & Mike**) with natural pacing, audio pauses, and expressive delivery.
* **📰 Personalized to You**: Choose your favorite topics (Top Stories, World, Business, Tech, Science, Health, Sports, Entertainment), set your city for local weather and news, or track specific people, teams, and custom RSS links.
* **⏱️ Snappy 5-Minute Format**: Around 12 to 16 key stories, each summarized specifically for listening. Hear the essentials without fluff.
* **💡 Interactive Follow-Along**: Each story card lights up and scrolls into view as it's read aloud. Tap any story card to jump straight to that story, or click through to read the full original article.
* **🔒 Private by Design**: No sponsored content, no intrusive tracking pixels, and no ad networks. Your preferences stay yours.

---

## 🖥️ Modern Web & PWA Experience

Access your briefing from any modern browser on your desktop, laptop, iPad, or iPhone. Features a modern frosted-glass interface with smooth audio scrubbing and seamless light and dark mode support.

<div align="center">

### Light Mode
<img src="docs/screenshots/web-desktop-light.png" alt="Morning Brief Web Desktop Light Mode" width="100%" style="border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);" />

### Dark Mode
<img src="docs/screenshots/web-desktop-dark.png" alt="Morning Brief Web Desktop Dark Mode" width="100%" style="border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);" />

</div>

> **Tip**: On Chrome, Edge, or iOS Safari, click **Install** or **Add to Home Screen** to install Morning Brief as a standalone Progressive Web App (PWA) with offline caching and web push notifications.

---

## 📱 Native Android App

Prefer a dedicated mobile app? The native Android app provides an on-the-go experience with background audio playback, lock-screen media controls, and customizable notifications.

<div align="center">

| Today's Briefing | Spoken Audio Follow-Along | Your Topics & Sources | Settings & Voices |
| :---: | :---: | :---: | :---: |
| <img src="docs/screenshots/android-today-light.png" width="220" alt="Android Today Light" /> | <img src="docs/screenshots/android-playing-dark.png" width="220" alt="Android Playing Dark" /> | <img src="docs/screenshots/android-sources-light.png" width="220" alt="Android Sources Light" /> | <img src="docs/screenshots/android-settings-light.png" width="220" alt="Android Settings Light" /> |

</div>

- **Background Audio**: Seamless audio playback with Android Media3 notification controls.
- **Smart Queueing**: 12 stories balanced across your selected topics, with visual indicators of how full your daily brief is.
- **Flexible Narrators**: Stream cloud-voiced briefings or generate on-device audio offline.
- **Custom AI Summaries**: Use default built-in summaries or bring your own free API key from Google Gemini, Groq, or OpenRouter.

---

## 🚀 Getting Started

### 🌐 Listen on the Web
1. Visit the Morning Brief web app.
2. Hit **Play** on the landing page to listen to today’s public sample briefing immediately—no account required.
3. Click **Start your brief** to sign in with Google or a magic email link to customize your personal topics and city.

### 🤖 Get the Android App
1. Download the latest `.apk` from our [GitHub Releases](https://github.com/vattitude-me/morning-brief-voice/releases).
2. Open the file on your Android device (Android 10+) and complete the quick 2-step setup.
3. Choose your topics and set the time you want your briefing ready every morning.

---

## 🗺️ What's Next & Feedback

We're constantly improving Morning Brief based on listener feedback:
- **Expressive Voice Styles**: Fun promo narrators and custom voice tones ([Voice Roadmap](docs/CUSTOM_VOICE_ROADMAP.md)).
- **Smart Feedback**: Suggest features or report inaccurate story summaries directly within the app settings.
- **Interactive Transcripts**: Word-level highlight sync and quick bookmarking.

---

## 🛠️ For Developers & Self-Hosters

Looking to deploy your own instance, run the nightly batch worker, or explore the codebase? Technical and operational details are documented in dedicated guides:

- 📖 [**Technical & Architecture Guide (`docs/TECHNICAL.md`)**](docs/TECHNICAL.md) — Complete architecture diagrams, Supabase database schema, Docker Compose environments, configuration variables, nightly automation, and testing.
- 📱 [**Android App Guide (`android/README.md`)**](android/README.md) — Gradle build steps, Jetpack Compose architecture, and release signing.
- 🎙️ [**Voice Service Guide (`voice_service/README.md`)**](voice_service/README.md) — Running the Chatterbox-Turbo neural TTS engine, FastAPI endpoints, GPU/MPS acceleration, and adding custom voices.
- 🌙 [**Nightly Automation (`docs/nightly.md`)**](docs/nightly.md) — Setting up macOS LaunchAgents or cron jobs for scheduled rendering.

---

<div align="center">

Made with care for a more peaceful morning routine.  
Free · No ads · No tracking

</div>
