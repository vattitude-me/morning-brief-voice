package me.vattitude.morningbrief.data

import android.net.Uri
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import me.vattitude.morningbrief.pipeline.Source
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/** The same public settings as web/config.js: the publishable key is safe to ship, row-level security does the rest. */
const val SUPABASE_URL = "https://oohbmeffdncyzujmeqcz.supabase.co"
const val SUPABASE_KEY = "sb_publishable_HgWQGelTuCEU6ayqFdY4Cg_F_-VVEYv"
val ADMIN_EMAILS = setOf("vatsakrish@gmail.com")

data class Session(val accessToken: String, val refreshToken: String, val expiresAt: Long, val userId: String, val email: String) {
    fun toJson(): JSONObject = JSONObject().put("access_token", accessToken).put("refresh_token", refreshToken)
        .put("expires_at", expiresAt).put("user_id", userId).put("email", email)

    companion object {
        fun fromJson(j: JSONObject) = Session(j.getString("access_token"), j.getString("refresh_token"),
            j.getLong("expires_at"), j.getString("user_id"), j.getString("email"))
    }
}

class SupabaseError(message: String, val status: Int = 0) : Exception(message)

/**
 * Google sign-in (the same account as the web app) and the sources/profiles tables, over plain REST.
 * The app never touches briefings or storage: briefings are built and kept on the phone.
 */
class Supabase(private val prefs: Prefs) {
    private val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
    private val json = "application/json".toMediaType()

    val session: Session? get() = prefs.session

    /**
     * The web app's "Continue with Google", in a browser tab. Google sends people back to [redirect] (the app's own
     * link, which must be in Supabase's allowed redirect URLs) with a code that [finishGoogle] swaps for a session (PKCE).
     */
    fun googleUrl(redirect: String): Uri {
        val verifier = b64(ByteArray(32).also { SecureRandom().nextBytes(it) })
        prefs.pkceVerifier = verifier
        val challenge = b64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        return Uri.parse("$SUPABASE_URL/auth/v1/authorize").buildUpon()
            .appendQueryParameter("provider", "google")
            .appendQueryParameter("redirect_to", redirect)
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("code_challenge_method", "s256")
            .appendQueryParameter("prompt", "select_account")
            .build()
    }

    suspend fun finishGoogle(callback: Uri): Session {
        val params = Uri.parse("?" + listOfNotNull(callback.encodedQuery, callback.encodedFragment).joinToString("&"))
        params.getQueryParameter("error_description")?.let {
            throw SupabaseError(if (Regex("provider is not enabled|unsupported provider", RegexOption.IGNORE_CASE)
                    .containsMatchIn(it)) "Google sign-in isn't switched on yet." else it)
        }
        val code = params.getQueryParameter("code") ?: throw SupabaseError("Google sign-in didn't finish. Try again.")
        val verifier = prefs.pkceVerifier ?: throw SupabaseError("That sign-in link has expired. Try again.")
        val body = JSONObject().put("auth_code", code).put("code_verifier", verifier)
        val res = call("POST", "/auth/v1/token?grant_type=pkce", body, auth = false) as JSONObject
        prefs.pkceVerifier = null
        return saveSession(res)
    }

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    /**
     * The web app's "Delete account": a request the server picks up, which removes the sign-in and everything that
     * cascades from it. The request row goes with the account, so its disappearing means done.
     */
    /** A reader flagging a summary; anyone may send one, signed in or not. Nothing can be read back. */
    suspend fun report(fields: JSONObject) {
        if (prefs.session != null) runCatching { fresh() }
        call("POST", "/rest/v1/content_reports", fields, prefer = "return=minimal")
    }

    suspend fun deleteAccount(timeoutMs: Long = 10_000L) {
        val s = try {
            fresh()
        } catch (e: SupabaseError) {
            if (prefs.session == null || e.status in 400..499) {
                signOut()
                return
            }
            throw e
        }
        val uid = s.userId

        // 1. Instant Supabase RPC deletion (deletes auth.users and cascades everything, exactly like web)
        val rpcSuccess = runCatching {
            call("POST", "/rest/v1/rpc/delete_user_account", JSONObject(), prefer = "return=minimal")
            true
        }.getOrDefault(false)

        if (rpcSuccess) {
            signOut()
            return
        }

        // 2. Direct cleanup of user tables via RLS
        runCatching { call("DELETE", "/rest/v1/push_subscriptions?user_id=eq.$uid") }
        runCatching { call("DELETE", "/rest/v1/sources?user_id=eq.$uid") }
        runCatching { call("DELETE", "/rest/v1/profiles?id=eq.$uid") }

        // 3. Fallback: Queue delete_account in build_requests if background worker is listening
        val id = runCatching {
            val rows = call("POST", "/rest/v1/build_requests?select=id", JSONObject().put("kind", "delete_account"),
                prefer = "return=representation") as? JSONArray
            rows?.optJSONObject(0)?.optLong("id")
        }.getOrNull()

        if (id != null) {
            val end = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < end) {
                delay(1500)
                val found = runCatching { call("GET", "/rest/v1/build_requests?select=status,message&id=eq.$id") as? JSONArray }
                    .getOrNull()
                val row = found?.optJSONObject(0)
                if (row == null) break // Row deleted with account
                if (row.optString("status") == "error") {
                    throw SupabaseError(row.optString("message").ifEmpty { "Your account couldn't be deleted." })
                }
                if (row.optString("status") == "done") break
            }
        }
        signOut()
    }

    fun signOut() {
        prefs.session = null
        prefs.isAdmin = false
    }

    suspend fun profileSettings(): JSONObject {
        val s = fresh()
        val rows = call("GET", "/rest/v1/profiles?select=settings,is_admin&id=eq.${s.userId}") as JSONArray
        val row = rows.optJSONObject(0) ?: JSONObject()
        val isAdm = row.optBoolean("is_admin", false) || ADMIN_EMAILS.contains(s.email.lowercase())
        prefs.isAdmin = isAdm
        return row.optJSONObject("settings") ?: JSONObject()
    }

    /**
     * The day's shared story clips (app/storypack.py): the worker voices each story once and
     * everyone listens to the same rows, so this is identical for every listener. Read-only.
     */
    suspend fun storyAudio(date: String): JSONArray {
        fresh()
        val base = "section,rank,voice,title,url,source"
        val rest = "script,duration,audio_path,created_at"
        val query = { cols: String -> "/rest/v1/story_audio?select=$cols&date=eq.$date&order=section.asc,rank.asc" }
        return try {
            call("GET", query("$base,image,$rest")) as JSONArray
        } catch (e: SupabaseError) {
            // An older database without the image column: a brief without thumbnails still works.
            if (Regex("column .* does not exist", RegexOption.IGNORE_CASE).containsMatchIn(e.message.orEmpty())) {
                call("GET", query("$base,$rest")) as JSONArray
            } else throw e
        }
    }

    /** The most recent day that has a published pack, or null when there isn't one yet. */
    suspend fun latestStoryDate(): String? {
        fresh()
        return try {
            val rows = call("GET", "/rest/v1/story_audio?select=date&order=date.desc&limit=1") as JSONArray
            rows.optJSONObject(0)?.optString("date")?.takeIf { it.isNotBlank() }
        } catch (e: SupabaseError) {
            null
        }
    }

    /** The day's greeting and section intros. A database without the table simply has no framing. */
    suspend fun voiceNotes(date: String): JSONArray {
        fresh()
        return try {
            call("GET", "/rest/v1/voice_notes?select=voice,note_key,text,duration,audio_path&date=eq.$date") as JSONArray
        } catch (e: SupabaseError) {
            if (Regex("Could not find the table|does not exist", RegexOption.IGNORE_CASE).containsMatchIn(e.message.orEmpty())) {
                JSONArray()
            } else throw e
        }
    }

    /** Merges the shared fields into the stored settings, leaving the web app's own (voice, daily...) alone. */
    suspend fun saveSettings(shared: JSONObject) {
        val s = fresh()
        val merged = profileSettings()
        for (key in shared.keys()) merged.put(key, shared.get(key))
        call("PATCH", "/rest/v1/profiles?id=eq.${s.userId}", JSONObject().put("settings", merged))
    }

    suspend fun sources(): List<Source> {
        fresh()
        val rows = call("GET", "/rest/v1/sources?select=*&order=id") as JSONArray
        return (0 until rows.length()).map { sourceFrom(rows.getJSONObject(it)) }
    }

    suspend fun addSource(url: String, section: String, name: String): Source {
        val s = fresh()
        val body = JSONObject().put("user_id", s.userId).put("url", url).put("section", section).put("name", name)
        val rows = call("POST", "/rest/v1/sources?select=*", body, prefer = "return=representation") as JSONArray
        return sourceFrom(rows.getJSONObject(0))
    }

    suspend fun updateSource(id: Long, values: JSONObject) {
        fresh()
        call("PATCH", "/rest/v1/sources?id=eq.$id", values)
    }

    suspend fun deleteSource(id: Long) {
        fresh()
        call("DELETE", "/rest/v1/sources?id=eq.$id")
    }

    private fun sourceFrom(j: JSONObject) = Source(
        id = j.getLong("id"),
        name = j.optString("name"),
        url = j.optString("url"),
        section = j.optString("section", "custom"),
        weight = j.optDouble("weight", 1.0),
        kind = j.optString("kind", "auto"),
        feedUrl = j.optString("feed_url").takeIf { it.isNotEmpty() && it != "null" },
        enabled = j.optBoolean("enabled", true),
        builtin = j.isNull("user_id"),
    )

    /** The current session, refreshed when it's about to expire. */
    private suspend fun fresh(): Session {
        val s = prefs.session ?: throw SupabaseError("Please sign in again.", 401)
        if (s.expiresAt - 60 > System.currentTimeMillis() / 1000) return s
        val res = try {
            call("POST", "/auth/v1/token?grant_type=refresh_token", JSONObject().put("refresh_token", s.refreshToken), auth = false)
        } catch (e: SupabaseError) {
            if (e.status in 400..499) prefs.session = null
            throw e
        }
        return saveSession(res as JSONObject)
    }

    private fun saveSession(res: JSONObject): Session {
        val user = res.getJSONObject("user")
        val session = Session(
            accessToken = res.getString("access_token"),
            refreshToken = res.getString("refresh_token"),
            expiresAt = res.optLong("expires_at", System.currentTimeMillis() / 1000 + res.optLong("expires_in", 3600)),
            userId = user.getString("id"),
            email = user.optString("email"),
        )
        prefs.session = session
        if (ADMIN_EMAILS.contains(session.email.lowercase())) {
            prefs.isAdmin = true
        }
        return session
    }

    private suspend fun call(method: String, path: String, body: JSONObject? = null, auth: Boolean = true,
                             prefer: String? = null): Any? = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(SUPABASE_URL + path).header("apikey", SUPABASE_KEY)
        if (auth) prefs.session?.let { builder.header("Authorization", "Bearer ${it.accessToken}") }
        prefer?.let { builder.header("Prefer", it) }
        val payload = body?.toString()?.toRequestBody(json)
        builder.method(method, payload ?: if (method == "GET" || method == "DELETE") null else "".toRequestBody(json))
        val (code, text) = try {
            client.newCall(builder.build()).execute().use { it.code to (it.body?.string() ?: "") }
        } catch (e: IOException) {
            throw SupabaseError("You're offline or the service can't be reached.")
        }
        if (code >= 400) throw SupabaseError(friendly(text), code)
        val trimmed = text.trim()
        when {
            trimmed.startsWith("[") -> JSONArray(trimmed)
            trimmed.startsWith("{") -> JSONObject(trimmed)
            else -> null
        }
    }

    private fun friendly(raw: String): String {
        val msg = runCatching {
            val j = JSONObject(raw)
            j.optString("msg").ifEmpty { j.optString("message") }.ifEmpty { j.optString("error_description") }
        }.getOrNull().orEmpty().ifEmpty { raw.take(200) }
        return when {
            Regex("row-level security.*sources", RegexOption.IGNORE_CASE).containsMatchIn(msg) ->
                "You can have up to 25 links. Remove one to add another."
            Regex("duplicate key.*sources", RegexOption.IGNORE_CASE).containsMatchIn(msg) -> "You've already added that link."
            Regex("flow state|code verifier", RegexOption.IGNORE_CASE).containsMatchIn(msg) ->
                "Google sign-in didn't finish. Try again."
            else -> msg
        }
    }
}
