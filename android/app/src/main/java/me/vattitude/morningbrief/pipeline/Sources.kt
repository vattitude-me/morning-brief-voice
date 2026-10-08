package me.vattitude.morningbrief.pipeline

import org.json.JSONObject
import java.net.URLEncoder
import kotlin.math.roundToInt

/** A briefing section. [stories] is the default count; 0 leaves it off. */
data class Section(val key: String, val title: String, val emoji: String, val topic: String, val stories: Int = 0) {
    /** A topic picked from the catalog (World, Sports...), as opposed to Local and the user's picks. */
    val isCategory: Boolean get() = key !in setOf("local", "follow", "custom")
}

/**
 * A news source. [id] is the Supabase row id when signed in; local sources use negative ids.
 * [kind] is feed, page, article or auto (not yet detected).
 */
data class Source(
    val id: Long,
    val name: String,
    val url: String,
    val section: String,
    val weight: Double = 1.0,
    val kind: String = "feed",
    val feedUrl: String? = null,
    val enabled: Boolean = true,
    val builtin: Boolean = false,
)

/** app/catalog/sources.json, shared with the worker and bundled as a resource. */
private val CATALOG: JSONObject by lazy {
    val stream = Source::class.java.getResourceAsStream("/sources.json") ?: error("The source catalog is missing")
    JSONObject(stream.bufferedReader().use { it.readText() })
}

/**
 * The seven pack sections, in reading order — exactly the keys the worker publishes
 * (app/guardian.py) and the web app uses. A section is now one feed (The Guardian),
 * not a bag of outlets, so these are fixed rather than read from the bundled catalog.
 */
val SECTIONS: LinkedHashMap<String, Section> = linkedMapOf(
    "top" to Section("top", "Top stories", "📰", "the top stories"),
    "ai" to Section("ai", "AI", "🤖", "the latest in AI"),
    "tech" to Section("tech", "Tech", "💻", "the latest in tech"),
    "politics" to Section("politics", "Politics", "🏛️", "politics"),
    "entertainment" to Section("entertainment", "Entertainment", "🎬", "entertainment"),
    "science" to Section("science", "Science", "🔬", "science"),
    "sports" to Section("sports", "Sports", "🏅", "sports"),
)

/**
 * What a brand-new phone starts with: every section on, at three stories — the same
 * default as the web app, so a first brief covers all seven out of the box.
 */
val DEFAULT_STORIES: Map<String, Int> get() = SECTIONS.mapValues { DEFAULT_PER_SECTION }

/** A balanced first brief: the same as the default. Offered as a one-tap start during setup. */
val QUICK_MIX: Map<String, Int> = SECTIONS.mapValues { DEFAULT_PER_SECTION }

/**
 * A story takes about 22 seconds to hear, its share of the section leads included, and the greeting,
 * weather and sign-off about half a minute more.
 */
const val STORY_BUDGET = 35
const val MAX_PER_SECTION = 5
const val DEFAULT_PER_SECTION = 3
private const val SECONDS_PER_STORY = 22
private const val SECONDS_AROUND = 30

/** Minutes to hear a brief of [stories] stories, rounded. */
fun briefMinutes(stories: Int): Int = ((stories * SECONDS_PER_STORY + SECONDS_AROUND) / 60.0).roundToInt().coerceAtLeast(1)

/** People followed and links added are one list on the phone, "Your picks", sharing one count. */
val PICKS = listOf("follow", "custom")

fun picksCount(stories: Map<String, Int>): Int = PICKS.sumOf { stories[it] ?: 0 }

/** Splits the picks count between the two sections the web app and server keep apart. */
fun withPicks(stories: Map<String, Int>, n: Int): Map<String, Int> = stories + ("follow" to n / 2) + ("custom" to n - n / 2)

/** Fits counts to the limits: at most [MAX_PER_SECTION] a section (picks counted together) and [STORY_BUDGET] in all. */
fun fitBudget(stories: Map<String, Int>): Map<String, Int> {
    val out = LinkedHashMap<String, Int>()
    for (k in SECTIONS.keys) if (k !in PICKS) out[k] = (stories[k] ?: 0).coerceIn(0, MAX_PER_SECTION)
    out["picks"] = picksCount(stories).coerceIn(0, MAX_PER_SECTION)
    // Over budget (counts from before the limit, or from the web app): trim the biggest, later sections first.
    while (out.values.sum() > STORY_BUDGET) {
        val key = out.entries.reversed().maxBy { it.value }.key
        out[key] = out.getValue(key) - 1
    }
    val picks = out.remove("picks")!!
    return withPicks(out, picks)
}

/** The catalog's sources. Their ids are negative and stable; signed in, the Supabase row's id replaces it. */
val BUILTIN_SOURCES: List<Source> by lazy {
    val arr = CATALOG.getJSONArray("sources")
    (0 until arr.length()).map { i ->
        val j = arr.getJSONObject(i)
        Source(-100_000L - i, j.getString("name"), j.getString("url"), j.getString("section"), j.optDouble("weight", 1.0),
            feedUrl = j.getString("url"), builtin = true)
    }
}

/** News for a city: its own outlets where the catalog knows them, and Google News for anywhere. */
fun localSources(city: String): List<Source> {
    val name = city.substringBefore(',').trim()
    if (name.isEmpty()) return emptyList()
    val local = CATALOG.getJSONObject("local")
    val key = name.lowercase().let { local.getJSONObject("aliases").optString(it).ifEmpty { it } }
    val known = local.getJSONObject("cities").optJSONArray(key)
    val everywhere = local.getJSONArray("everywhere")
    val picks = (0 until (known?.length() ?: 0)).map { known!!.getJSONObject(it) } +
        (0 until everywhere.length()).map { everywhere.getJSONObject(it) }
    val encoded = URLEncoder.encode(name, "UTF-8").replace("+", "%20")
    return picks.mapIndexed { i, j ->
        val url = j.getString("url").replace("{city}", encoded)
        Source(-200_000L - i, j.getString("name").replace("{city}", name), url, "local", j.optDouble("weight", 1.0),
            feedUrl = url, builtin = true)
    }
}

/** A news search feed for a person, team or topic. */
fun followUrl(query: String): String =
    CATALOG.getJSONObject("follow").getString("url").replace("{query}", URLEncoder.encode(query.trim(), "UTF-8"))

fun isFollowUrl(url: String): Boolean = url.startsWith(followUrl("").substringBefore('?'))

/** Names to try in the Follow box. */
val FOLLOW_EXAMPLES: List<String> by lazy {
    CATALOG.getJSONObject("follow").getJSONArray("examples").let { a -> (0 until a.length()).map { a.getString(it) } }
}
