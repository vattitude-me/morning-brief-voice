package me.vattitude.morningbrief.data

import android.content.Context
import me.vattitude.morningbrief.pipeline.Heard
import org.json.JSONObject
import java.io.File
import java.time.LocalDate

/** Briefings live on the phone: briefings/<date>.json plus briefings/<date>.m4a. */
class Briefings(context: Context) {
    val dir = File(context.filesDir, "briefings").apply { mkdirs() }

    fun dates(): List<String> =
        dir.listFiles { f -> f.name.endsWith(".json") }.orEmpty().map { it.name.removeSuffix(".json") }.sortedDescending()

    fun load(date: String): JSONObject? =
        File(dir, "$date.json").takeIf { it.exists() }?.let { runCatching { JSONObject(it.readText()) }.getOrNull() }

    fun audio(date: String) = File(dir, "$date.m4a")

    fun save(date: String, doc: JSONObject, audio: File) {
        audio.copyTo(audio(date), overwrite = true)
        val tmp = File(dir, "$date.json.tmp")
        tmp.writeText(doc.toString())
        tmp.renameTo(File(dir, "$date.json"))
    }

    /** Cards from the last [days] briefings before [today]: their stories aren't told again. */
    fun heard(today: LocalDate, days: Long = 2): List<Heard> {
        val since = today.minusDays(days).toString()
        return dates().filter { it >= since && it < today.toString() }.flatMap { date ->
            val stories = load(date)?.optJSONArray("stories") ?: return@flatMap emptyList()
            (0 until stories.length()).map { i ->
                val card = stories.getJSONObject(i)
                val links = card.optJSONArray("links")
                Heard(
                    url = card.optString("url").ifEmpty { null },
                    title = card.optString("original_title").ifEmpty { card.optString("headline") },
                    links = links?.let { l -> (0 until l.length()).map { l.getJSONObject(it).optString("url") } } ?: emptyList(),
                )
            }
        }
    }

    /** Keeps a week of briefings. */
    fun cleanup(today: LocalDate, keepDays: Long = 7) {
        val cutoff = today.minusDays(keepDays).toString()
        dir.listFiles().orEmpty().filter { it.name.take(10) < cutoff }.forEach { it.delete() }
    }

    /** Deletes all cached briefings and recordings. */
    fun clearAll() {
        dir.listFiles()?.forEach { it.deleteRecursively() }
    }
}
