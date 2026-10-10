package me.vattitude.morningbrief.data

import me.vattitude.morningbrief.pipeline.AiProvider
import me.vattitude.morningbrief.pipeline.DEFAULT_STORIES
import me.vattitude.morningbrief.pipeline.aiProvider
import me.vattitude.morningbrief.pipeline.SECTIONS
import me.vattitude.morningbrief.pipeline.fitBudget
import me.vattitude.morningbrief.pipeline.kokoroVoice
import org.json.JSONArray
import org.json.JSONObject

/**
 * The user's settings. The fields shared with the web app keep the web app's JSON names
 * (profiles.settings), so a signed-in user's choices follow them between web and phone.
 */
data class Settings(
    val name: String = "",
    val city: String = "Toronto",
    val latitude: Double = 43.6532,
    val longitude: Double = -79.3832,
    val weather: Boolean = true,
    val saySources: Boolean = false,
    /** Stories per section; 0 turns a section off. */
    val stories: Map<String, Int> = DEFAULT_STORIES,
    /** Custom reading order of category sections; empty means default SECTIONS order. */
    val sectionOrder: List<String> = emptyList(),
    /** The city for local news; blank means the weather [city]. */
    val newsCity: String = "",
    /** Supabase ids of built-in sources switched off (signed in). */
    val disabledSources: Set<Long> = emptySet(),
    /** URLs of catalog and local-news sources switched off (the Supabase id, when there is one, is in [disabledSources] too). */
    val disabledUrls: Set<String> = emptySet(),
    // Phone-only settings.
    val daily: Boolean = true,
    val readyBy: String = "07:00",
    /** Which narrator reads the news: an id from [PACK_VOICES] ("her_reference" = Alice), or null for the default. */
    val voice: String? = "her_reference",
    val speed: Float = 1.0f,
    val groqKey: String = "",
    /** Who writes the summaries: an [AI_PROVIDERS] id. Groq uses [groqKey]; each other service keeps its own key in [aiKeys]. */
    val aiProvider: String = "groq",
    /** API key per non-Groq provider, keyed by provider id, so a Gemini key never shows up under OpenRouter. */
    val aiKeys: Map<String, String> = emptyMap(),
    /** For a custom provider: an OpenAI-compatible base URL and model; for the others, an optional model override. */
    val aiBaseUrl: String = "",
    val aiModel: String = "",
    val welcomed: Boolean = false,
    /** Show story thumbnails in color; the hero cover stays black and white. */
    val colorPhotos: Boolean = true,
) {
    val localCity: String get() = newsCity.ifBlank { city }
    val readyHour: Int get() = readyBy.substringBefore(':').toIntOrNull()?.coerceIn(0, 23) ?: 7
    val readyMinute: Int get() = readyBy.substringAfter(':').toIntOrNull()?.coerceIn(0, 59) ?: 0
    val provider: AiProvider get() = aiProvider(aiProvider)
    /** The key for the chosen provider; blank means built-in summaries. */
    val summaryKey: String get() = if (provider.id == "groq") groqKey else aiKeys[provider.id].orEmpty()

    fun toJson(): JSONObject = sharedJson()
        .put("android_daily", daily)
        .put("ready_by", readyBy)
        .put("android_voice", voice ?: JSONObject.NULL)
        .put("android_speed", speed.toDouble())
        .put("groq_key", groqKey)
        .put("android_ai_provider", aiProvider)
        .put("android_ai_keys", JSONObject(aiKeys))
        .put("android_ai_base_url", aiBaseUrl)
        .put("android_ai_model", aiModel)
        .put("welcomed", welcomed)
        .put("android_color_photos", colorPhotos)

    val orderedSections: List<String> get() = effectiveSectionOrder(sectionOrder)

    /** Only the fields the web app also uses. */
    fun sharedJson(): JSONObject = JSONObject()
        .put("name", name)
        .put("city", city)
        .put("latitude", latitude)
        .put("longitude", longitude)
        .put("weather", weather)
        .put("say_sources", saySources)
        .put("stories", JSONObject(stories))
        .put("news_city", newsCity)
        .put("disabled_sources", JSONArray(disabledSources.toList()))
        .put("disabled_urls", JSONArray(disabledUrls.toList()))
        .put("speed", speed.toDouble())
        .put("daily", daily)
        .put("color_photos", colorPhotos)
        .apply {
            if (sectionOrder.isNotEmpty()) put("section_order", JSONArray(sectionOrder))
            if (voice != null && (me.vattitude.morningbrief.pipeline.PACK_VOICES.any { it.id == voice } || kokoroVoice(voice) != null)) {
                put("voice", voice)
            }
        }

    /** Takes the shared fields from the server's copy, keeping phone-only settings. */
    fun withShared(remote: JSONObject): Settings = copy(
        name = remote.optString("name", name),
        city = remote.optString("city", city),
        latitude = remote.optDouble("latitude", latitude),
        longitude = remote.optDouble("longitude", longitude),
        weather = remote.optBoolean("weather", weather),
        saySources = remote.optBoolean("say_sources", saySources),
        stories = remote.optJSONObject("stories")?.let { s ->
            fitBudget(SECTIONS.keys.associateWith { k -> s.optInt(k, stories[k] ?: 0) })
        } ?: fitBudget(stories),
        sectionOrder = remote.optJSONArray("section_order")?.let { a ->
            (0 until a.length()).map { a.getString(it) }.filter { it.isNotBlank() }
        } ?: sectionOrder,
        newsCity = remote.optString("news_city", newsCity),
        disabledSources = remote.optJSONArray("disabled_sources")?.let { a -> (0 until a.length()).map { a.getLong(it) }.toSet() }
            ?: disabledSources,
        disabledUrls = remote.optJSONArray("disabled_urls")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
            ?: disabledUrls,
        daily = if (remote.has("daily")) remote.optBoolean("daily", daily) else daily,
        speed = if (remote.has("speed")) remote.optDouble("speed", speed.toDouble()).toFloat() else speed,
        colorPhotos = if (remote.has("color_photos")) remote.optBoolean("color_photos", colorPhotos)
            else if (remote.has("android_color_photos")) remote.optBoolean("android_color_photos", colorPhotos)
            else colorPhotos,
        voice = remote.optString("voice").takeIf { v ->
            v.isNotBlank() && (me.vattitude.morningbrief.pipeline.PACK_VOICES.any { it.id == v } || kokoroVoice(v) != null)
        } ?: voice,
    )

    companion object {
        fun fromJson(json: JSONObject?): Settings {
            json ?: return Settings()
            val base = Settings().withShared(json)
            val sectionOrder = json.optJSONArray("section_order")?.let { a ->
                (0 until a.length()).map { a.getString(it) }.filter { it.isNotBlank() }
            } ?: base.sectionOrder
            val aiKeys = json.optJSONObject("android_ai_keys")?.let { o ->
                o.keys().asSequence().associateWith { o.optString(it) }.filterValues { it.isNotEmpty() }
            } ?: json.optString("android_ai_key", "").takeIf { it.isNotEmpty() }
                ?.let { mapOf(json.optString("android_ai_provider", "groq") to it) } ?: emptyMap()
            return base.copy(
                sectionOrder = sectionOrder,
                disabledUrls = json.optJSONArray("disabled_urls")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
                    ?: emptySet(),
                daily = json.optBoolean("android_daily", true),
                readyBy = json.optString("ready_by", "07:00"),
                voice = json.optString("android_voice").takeIf { it.isNotEmpty() && it != "null" } ?: base.voice,
                speed = json.optDouble("android_speed", 1.0).toFloat(),
                groqKey = json.optString("groq_key", ""),
                aiProvider = json.optString("android_ai_provider", "groq"),
                aiKeys = aiKeys,
                aiBaseUrl = json.optString("android_ai_base_url", ""),
                aiModel = json.optString("android_ai_model", ""),
                welcomed = json.optBoolean("welcomed", false),
                colorPhotos = json.optBoolean("android_color_photos", true),
            )
        }
    }
}

val DEFAULT_SECTION_ORDER: List<String> get() = SECTIONS.keys.toList()

fun effectiveSectionOrder(customOrder: List<String>): List<String> {
    val valid = customOrder.filter { SECTIONS.containsKey(it) }
    val remaining = SECTIONS.keys.filter { it !in valid }
    return valid + remaining
}
