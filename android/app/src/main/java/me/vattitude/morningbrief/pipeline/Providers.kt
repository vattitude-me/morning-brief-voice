package me.vattitude.morningbrief.pipeline

/**
 * Services that can write the summaries. All speak the OpenAI chat-completions API, so one
 * client covers them; the user brings their own key and it stays on the phone.
 */
data class AiProvider(
    val id: String,
    val name: String,
    val baseUrl: String,
    /** Tried in order; the next takes over when one is rate-limited or retired. */
    val models: List<String>,
    /** Where to get a key. */
    val keyUrl: String,
    val note: String,
    /** The provider hands out free keys good enough for a daily brief. */
    val freeKey: Boolean = false,
)

val AI_PROVIDERS = listOf(
    AiProvider("groq", "Groq", "https://api.groq.com/openai/v1",
        listOf("openai/gpt-oss-120b", "openai/gpt-oss-20b"), "https://console.groq.com/keys",
        "Free, fast and enough for a daily brief. Sign in and create a key.", freeKey = true),
    AiProvider("gemini", "Gemini", "https://generativelanguage.googleapis.com/v1beta/openai",
        listOf("gemini-3.8-flash", "gemini-3.5-flash-lite"), "https://aistudio.google.com/apikey",
        "Free tier with a Google account, in Google AI Studio.", freeKey = true),
    AiProvider("openrouter", "OpenRouter", "https://openrouter.ai/api/v1",
        listOf("openai/gpt-oss-120b:free", "openai/gpt-oss-20b:free"), "https://openrouter.ai/keys",
        "One key for many models, with free ones to start.", freeKey = true),
    AiProvider("openai", "OpenAI", "https://api.openai.com/v1",
        listOf("gpt-4.1-mini", "gpt-4.1-nano"), "https://platform.openai.com/api-keys",
        "Paid, a few cents a week of briefings."),
    AiProvider("custom", "Other", "", emptyList(), "",
        "Any OpenAI-compatible service: its base URL, a model and your key."),
)

fun aiProvider(id: String?) = AI_PROVIDERS.firstOrNull { it.id == id } ?: AI_PROVIDERS.first()
