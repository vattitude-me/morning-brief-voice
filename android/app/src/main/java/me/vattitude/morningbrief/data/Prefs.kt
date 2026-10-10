package me.vattitude.morningbrief.data

import android.content.Context
import me.vattitude.morningbrief.pipeline.Source
import org.json.JSONArray
import org.json.JSONObject

/** Small key-value state: settings, session, sources and the bits of history a build needs. */
class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("morning-brief", Context.MODE_PRIVATE)

    var settings: Settings
        get() = Settings.fromJson(sp.getString("settings", null)?.let { JSONObject(it) })
        set(value) = sp.edit().putString("settings", value.toJson().toString()).apply()

    var session: Session?
        get() = sp.getString("session", null)?.let { runCatching { Session.fromJson(JSONObject(it)) }.getOrNull() }
        set(value) = sp.edit().putString("session", value?.toJson()?.toString()).apply()

    var isAdmin: Boolean
        get() = sp.getBoolean("is_admin", false)
        set(value) = sp.edit().putBoolean("is_admin", value).apply()

    /** Whether the first-run setup is done; installs from before it existed count as done. */
    var onboarded: Boolean
        get() = if (sp.contains("onboarded")) sp.getBoolean("onboarded", false) else (sp.contains("settings") || sp.contains("last_build"))
        set(value) = sp.edit().putBoolean("onboarded", value).apply()

    /** Ids of stories this phone has reported. */
    var reported: Set<String>
        get() = sp.getStringSet("reported", emptySet())!!
        set(value) = sp.edit().putStringSet("reported", value.toList().takeLast(200).toSet()).apply()

    /** "light", "dark" or "system"; this phone only. */
    var appearance: String
        get() = sp.getString("appearance", null) ?: "system"
        set(value) = sp.edit().putString("appearance", value).apply()

    /** Whether the first-run "while you wait" upsells were shown or dismissed. */
    var upsellsSeen: Boolean
        get() = sp.getBoolean("upsells_seen", false)
        set(value) = sp.edit().putBoolean("upsells_seen", value).apply()

    /** The PKCE secret for a Google sign-in in progress; kept here in case Android stops the app meanwhile. */
    var pkceVerifier: String?
        get() = sp.getString("pkce_verifier", null)
        set(value) = sp.edit().putString("pkce_verifier", value).apply()

    /** Links added while signed out. Ids are negative so they never clash with Supabase ids. */
    var localSources: List<Source>
        get() = sources("local_sources")
        set(value) = putSources("local_sources", value)

    /** The last list of sources read from Supabase, for builds without a network. */
    var cachedSources: List<Source>
        get() = sources("cached_sources")
        set(value) = putSources("cached_sources", value)

    /** Single articles already read in a briefing; like the server, each is used once. */
    var consumed: Set<String>
        get() = sp.getStringSet("consumed", emptySet())!!
        set(value) = sp.edit().putStringSet("consumed", value).apply()

    /** What a link turned out to be (feed, page or article), so it's only detected once. */
    fun detection(url: String): JSONObject? = sp.getString("detect:$url", null)?.let { JSONObject(it) }
    fun saveDetection(url: String, value: JSONObject) = sp.edit().putString("detect:$url", value.toString()).apply()

    var sourceStatus: JSONObject
        get() = JSONObject(sp.getString("source_status", "{}")!!)
        set(value) = sp.edit().putString("source_status", value.toString()).apply()

    var lastBuild: JSONObject
        get() = JSONObject(sp.getString("last_build", "{}")!!)
        set(value) = sp.edit().putString("last_build", value.toString()).apply()

    private fun sources(key: String): List<Source> {
        val arr = JSONArray(sp.getString(key, "[]"))
        return (0 until arr.length()).map {
            val j = arr.getJSONObject(it)
            Source(j.getLong("id"), j.getString("name"), j.getString("url"), j.getString("section"),
                j.optDouble("weight", 1.0), j.optString("kind", "auto"), j.optString("feed_url").ifEmpty { null },
                j.optBoolean("enabled", true), j.optBoolean("builtin", false))
        }
    }

    private fun putSources(key: String, list: List<Source>) {
        val arr = JSONArray()
        for (s in list) {
            arr.put(JSONObject().put("id", s.id).put("name", s.name).put("url", s.url).put("section", s.section)
                .put("weight", s.weight).put("kind", s.kind).put("feed_url", s.feedUrl ?: "")
                .put("enabled", s.enabled).put("builtin", s.builtin))
        }
        sp.edit().putString(key, arr.toString()).apply()
    }

    fun clearAll() {
        sp.edit().clear().putBoolean("onboarded", false).apply()
    }
}
