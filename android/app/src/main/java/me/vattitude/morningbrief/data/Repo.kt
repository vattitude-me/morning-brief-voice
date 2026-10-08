package me.vattitude.morningbrief.data

import android.content.Context
import me.vattitude.morningbrief.pipeline.Detection
import me.vattitude.morningbrief.pipeline.Fetcher
import me.vattitude.morningbrief.pipeline.Source
import me.vattitude.morningbrief.pipeline.followUrl
import me.vattitude.morningbrief.pipeline.isFollowUrl
import me.vattitude.morningbrief.pipeline.localSources
import me.vattitude.morningbrief.pipeline.normalizeUrl
import org.json.JSONObject

/**
 * Settings and sources. Signed out, everything is local. Signed in, Supabase is the source of truth
 * (edits go there first, as in the web app) and the phone keeps a copy for builds without a network.
 */
class Repo(context: Context) {
    val prefs = Prefs(context)
    val supabase = Supabase(prefs)
    val briefings = Briefings(context)

    val signedIn: Boolean get() = prefs.session != null
    val email: String? get() = prefs.session?.email

    var settings: Settings
        get() = prefs.settings
        private set(value) {
            prefs.settings = value
        }

    /** Saves locally, then shares the common fields with the web app. Returns a problem to show, if any. */
    suspend fun saveSettings(new: Settings): String? {
        val old = settings
        settings = new
        if (!signedIn || old.sharedJson().toString() == new.sharedJson().toString()) return null
        return runCatching { supabase.saveSettings(new.sharedJson()) }.exceptionOrNull()?.let {
            "Saved on this phone, but not synced: ${it.message}"
        }
    }

    /** Pulls the shared settings from the web app (signed in only). */
    suspend fun pullSettings() {
        if (!signedIn) return
        runCatching { supabase.profileSettings() }.getOrNull()?.let { settings = settings.withShared(it) }
    }

    /**
     * The catalog (from the app, so new categories work before the server lists them), local news for the
     * user's city, and the user's own links and follows, with [Source.enabled] reflecting their choices.
     * [remote] falls back to the cached copy.
     */
    suspend fun sources(remote: Boolean = true, st: Settings = settings): Pair<List<Source>, String?> {
        var note: String? = null
        val rows = when {
            !signedIn -> prefs.localSources
            remote -> runCatching { supabase.sources().also { prefs.cachedSources = it } }.getOrElse {
                note = "Couldn't reach your account, so your saved list of sources was used."
                prefs.cachedSources
            }
            else -> prefs.cachedSources
        }
        // Signed in, a catalog source takes its Supabase id, so switching it off also reaches the web app.
        val ids = rows.filter { it.builtin }.associate { it.url to it.id }
        val catalog = localSources(st.localCity).map { s ->
            val id = ids[s.url] ?: s.id
            s.copy(id = id, enabled = s.url !in st.disabledUrls && id !in st.disabledSources)
        }
        return catalog + rows.filter { !it.builtin } to note
    }

    suspend fun setEnabled(source: Source, enabled: Boolean): String? {
        val st = settings
        return when {
            source.builtin -> saveSettings(st.copy(
                disabledUrls = if (enabled) st.disabledUrls - source.url else st.disabledUrls + source.url,
                disabledSources = when {
                    source.id < 0 -> st.disabledSources
                    enabled -> st.disabledSources - source.id
                    else -> st.disabledSources + source.id
                },
            ))
            signedIn -> runCatching { supabase.updateSource(source.id, JSONObject().put("enabled", enabled)) }
                .exceptionOrNull()?.message
            else -> {
                prefs.localSources = prefs.localSources.map { if (it.id == source.id) it.copy(enabled = enabled) else it }
                null
            }
        }
    }

    /** Checks what the link is first, so a bad link is caught while the user is still here. */
    suspend fun addSource(input: String, section: String): Detection {
        val url = normalizeUrl(input)
        val found = Fetcher(15).detect(url)
        prefs.saveDetection(url, detectionJson(found))
        val name = found.name.ifBlank { url }.take(200)
        if (signedIn) {
            supabase.addSource(url, section, name)
        } else {
            val local = prefs.localSources
            if (local.any { it.url == url }) throw IllegalArgumentException("You've already added that link.")
            if (local.size >= 25) throw IllegalArgumentException("You can have up to 25 links. Remove one to add another.")
            val id = (local.minOfOrNull { it.id } ?: 0L).coerceAtMost(0L) - 1
            prefs.localSources = local + Source(id, name, url, section, kind = found.kind, feedUrl = found.feedUrl)
        }
        return found
    }

    /** Follows a person, team or topic through a news search; returns a few of today's headlines about it. */
    suspend fun follow(query: String): List<String> {
        val name = query.trim().take(100)
        if (name.length < 2) throw IllegalArgumentException("Type a name or a topic to follow.")
        val url = followUrl(name)
        val probe = Source(0, name, url, "follow", feedUrl = url)
        val found = Fetcher(15).fetchSource(probe)
        if (found.isEmpty()) throw IllegalArgumentException("No recent news about $name. Check the spelling, or try a broader topic.")
        prefs.saveDetection(url, JSONObject().put("kind", "feed").put("feed_url", url).put("name", name))
        if (signedIn) {
            supabase.addSource(url, "follow", name)
        } else {
            val local = prefs.localSources
            if (local.any { it.url == url }) throw IllegalArgumentException("You're already following $name.")
            if (local.size >= 25) throw IllegalArgumentException("You can have up to 25 links and follows. Remove one to add another.")
            val id = (local.minOfOrNull { it.id } ?: 0L).coerceAtMost(0L) - 1
            prefs.localSources = local + Source(id, name, url, "follow", kind = "feed", feedUrl = url)
        }
        return found.take(3).map { it.title }
    }

    suspend fun removeSource(source: Source) {
        if (signedIn) supabase.deleteSource(source.id)
        else prefs.localSources = prefs.localSources.filter { it.id != source.id }
    }

    /** Links Supabase still lists as "auto" (the server hasn't looked at them) are detected here, once. */
    suspend fun resolve(source: Source): Source? {
        if (source.kind != "auto") return source
        if (isFollowUrl(source.url)) return source.copy(kind = "feed", feedUrl = source.url)
        val url = normalizeUrl(source.url)
        val known = prefs.detection(url) ?: runCatching { detectionJson(Fetcher(15).detect(url)) }.getOrNull()
            ?.also { prefs.saveDetection(url, it) } ?: return null
        return source.copy(kind = known.getString("kind"), feedUrl = known.optString("feed_url").ifEmpty { null })
    }

    private fun detectionJson(d: Detection) =
        JSONObject().put("kind", d.kind).put("feed_url", d.feedUrl ?: "").put("name", d.name)
}
