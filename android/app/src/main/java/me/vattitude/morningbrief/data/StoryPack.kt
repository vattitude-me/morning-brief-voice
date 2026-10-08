package me.vattitude.morningbrief.data

import me.vattitude.morningbrief.pipeline.MAX_PER_SECTION
import me.vattitude.morningbrief.pipeline.SECTIONS
import me.vattitude.morningbrief.pipeline.packVoice
import me.vattitude.morningbrief.pipeline.pickPackVoice
import me.vattitude.morningbrief.ui.Briefing
import me.vattitude.morningbrief.ui.Card
import me.vattitude.morningbrief.ui.Chapter
import me.vattitude.morningbrief.ui.SectionInfo
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalTime

/** One clip on the briefing's timeline: a story, or one of the spoken notes. */
data class Clip(
    val id: String, val title: String, val url: String,
    val duration: Double, val start: Double, val end: Double, val note: Boolean,
)

/** A listener's briefing, assembled from the shared day's clips. */
data class Pack(val briefing: Briefing, val clips: List<Clip>, val version: String)

/** Which greeting to open with, by the listener's local hour (mirrors app/storypack.py). */
fun greetingKey(hour: Int = LocalTime.now().hour): String = when {
    hour < 12 -> "greeting_morning"
    hour < 17 -> "greeting_afternoon"
    else -> "greeting_evening"
}

/** The per-section counts a listener asked for (0 = off), clamped to 0..[MAX_PER_SECTION]. */
fun lineup(stories: Map<String, Int>): Map<String, Int> =
    SECTIONS.keys.associateWith { (stories[it] ?: 0).coerceIn(0, MAX_PER_SECTION) }

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

internal fun clipUrl(path: String) = "$SUPABASE_URL/storage/v1/object/public/briefings/$path"

/**
 * Turns the day's shared clips into one listener's briefing: the greeting, then each
 * section's spoken intro before its first story. Mirrors web/js/storypack.js, so the phone
 * and the browser assemble exactly the same thing from the same rows.
 *
 * Nothing here is per-user except *which* clips are chosen — the audio is generated once
 * for everyone, so cost never grows with the number of listeners.
 */
object StoryPack {
    /**
     * [date] is the day the listener asked for. When that day has no pack — the nightly job hasn't
     * published yet, or it wasn't a news day — the most recent published day is used instead, and
     * the returned pack carries that day in [Briefing.date] so the caller can say where it's from.
     * Null means there is genuinely nothing recorded yet.
     */
    suspend fun fetch(supabase: Supabase, date: String, stories: Map<String, Int>,
                      voice: String? = null): Pack? {
        var day = date
        var rows = supabase.storyAudio(day)
        if (rows.length() == 0) {
            val latest = runCatching { supabase.latestStoryDate() }.getOrNull()
            if (latest != null && latest != day) {
                day = latest
                rows = supabase.storyAudio(day)
            }
        }
        if (rows.length() == 0) return null
        // Every narrator is published each morning, so the day's rows hold all of them:
        // play the one this listener picked.
        val every = rows.objects()
        val spokenBy = pickPackVoice(every.map { it.optString("voice") }, voice)
        val all = if (spokenBy == null) every else every.filter { it.optString("voice") == spokenBy }
        val notes = runCatching { supabase.voiceNotes(day) }.getOrDefault(JSONArray())
        val wanted = lineup(stories)
        val noteByKey = notes.objects().filter { it.optString("voice") == spokenBy }
            .associateBy { it.optString("note_key") }

        val clips = mutableListOf<Clip>()
        val cards = mutableListOf<Card>()
        val chapters = mutableListOf<Chapter>()
        val counts = LinkedHashMap<String, Int>()
        var cursor = 0.0

        fun sayNote(key: String) {
            val note = noteByKey[key] ?: return
            val duration = note.optDouble("duration", 0.0)
            val text = note.optString("text")
            clips += Clip(key, text, clipUrl(note.optString("audio_path")), duration, cursor, cursor + duration, note = true)
            chapters += Chapter(key, "note", text, cursor, cursor + duration, null)
            cursor += duration
        }

        sayNote(greetingKey())

        for (key in SECTIONS.keys) {
            val count = wanted[key] ?: 0
            if (count <= 0) continue
            val chosen = all.filter { it.optString("section") == key }.sortedBy { it.optInt("rank") }.take(count)
            if (chosen.isEmpty()) continue
            sayNote("intro_$key")
            for (row in chosen) {
                val duration = row.optDouble("duration", 0.0)
                val id = "$key-${row.optInt("rank")}"
                val title = row.optString("title")
                val start = cursor
                val end = cursor + duration
                clips += Clip(id, title, clipUrl(row.optString("audio_path")), duration, start, end, note = false)
                cards += Card(
                    id = id, section = key, headline = title, summary = row.optString("script"),
                    url = row.optString("url"), source = row.optString("source").ifEmpty { "The Guardian" },
                    also = emptyList(), image = row.optString("image").takeIf { it.startsWith("http") },
                    start = start, end = end,
                )
                chapters += Chapter(id, "story", title, start, end, key)
                counts[key] = (counts[key] ?: 0) + 1
                cursor += duration
            }
        }
        if (clips.isEmpty()) return null

        val version = all.map { it.optString("created_at") }.maxOrNull().orEmpty()
        val briefing = Briefing(
            date = day,
            title = "Your briefing",
            duration = cursor,
            intro = "",
            weather = null,
            sections = SECTIONS.filterKeys { counts.containsKey(it) }
                .map { (key, section) -> SectionInfo(key, section.title, section.emoji, counts[key] ?: 0) },
            chapters = chapters,
            cards = cards,
            notes = emptyList(),
            // The pack is voiced by the server's cloned narrator, not a phone voice, so
            // voiceId stays empty: there is nothing on this device to re-record.
            voiceName = packVoice(spokenBy).name,
            version = version,
        )
        return Pack(briefing, clips, version)
    }
}
