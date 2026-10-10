"""Runtime configuration, read once from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env_file() -> None:
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return
    try:
        with env_path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip("'\"")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


_load_env_file()


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _list(name: str) -> tuple[str, ...]:
    return tuple(x.strip().lower() for x in os.getenv(name, "").split(",") if x.strip())


@dataclass(frozen=True)
class Config:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("DATA_DIR", ROOT / "data")))
    model_dir: Path = field(
        default_factory=lambda: Path(os.getenv("MODEL_DIR", Path(os.getenv("DATA_DIR", ROOT / "data")) / "models"))
    )
    timezone: str = os.getenv("BRIEFING_TIMEZONE", "America/Toronto")
    batch_time: str = os.getenv("BATCH_TIME", "07:05")
    keep_days: int = int(os.getenv("KEEP_DAYS", "2"))
    # Off when the phones build their own briefings: the worker then only answers on-demand requests.
    daily_batch: bool = _bool("DAILY_BATCH", True)
    # Supabase: the worker uses the secret key, which bypasses row-level security. Never ship it to the browser.
    supabase_url: str = os.getenv("SUPABASE_URL", "").rstrip("/")
    supabase_secret_key: str = os.getenv("SUPABASE_SECRET_KEY", "")
    bucket: str = os.getenv("SUPABASE_BUCKET", "briefings")
    # Groq writes the summaries; each model has its own free-tier limits, so we fall through the list.
    groq_api_key: str | None = os.getenv("GROQ_API_KEY") or None
    groq_models: tuple[str, ...] = tuple(
        m.strip() for m in os.getenv("GROQ_MODELS", "openai/gpt-oss-120b,openai/gpt-oss-20b").split(",") if m.strip()
    )
    # Gemini AI Studio support
    gemini_api_key: str | None = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or None
    gemini_models: tuple[str, ...] = tuple(
        m.strip() for m in os.getenv("GEMINI_MODELS", "gemini-2.5-flash,gemini-1.5-flash").split(",") if m.strip()
    )
    admin_emails: tuple[str, ...] = _list("ADMIN_EMAILS")
    # "issues" pushes the admin only when a run had problems; "always" after every run.
    admin_notify: str = os.getenv("ADMIN_NOTIFY", "issues").strip().lower()
    vapid_subject: str = os.getenv("VAPID_SUBJECT", "mailto:admin@example.com")
    allow_private_urls: bool = _bool("ALLOW_PRIVATE_URLS")
    max_custom_sources: int = int(os.getenv("MAX_CUSTOM_SOURCES", "15"))
    # The Cloned narrator: the LAN/GPU voice service that voices the shared daily stories.
    voice_url: str = os.getenv("VOICE_SERVICE_URL", "").rstrip("/")
    story_voice: str = os.getenv("STORY_VOICE", "her_reference")
    # Every voice the pack renders each day. A listener hears the one they picked, and the
    # clips are shared, so the cost is stories × voices rather than × listeners.
    story_voices: tuple[str, ...] = tuple(
        v.strip() for v in os.getenv("STORY_VOICES", "her_reference,him_reference,jerry_reference,c3po_reference").split(",") if v.strip()
    )
    stories_per_section: int = int(os.getenv("STORIES_PER_SECTION", "5"))

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.model_dir, self.cache_dir):
            d.mkdir(parents=True, exist_ok=True)


def load() -> Config:
    cfg = Config()
    cfg.ensure_dirs()
    return cfg
