package me.vattitude.morningbrief.work

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import me.vattitude.morningbrief.MainActivity
import me.vattitude.morningbrief.MorningBriefApp
import me.vattitude.morningbrief.R
import me.vattitude.morningbrief.data.Repo
import me.vattitude.morningbrief.data.StoryPack
import me.vattitude.morningbrief.pipeline.BuildFailed
import me.vattitude.morningbrief.pipeline.Builder
import me.vattitude.morningbrief.ui.Briefing
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate

class BuildWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val app = context.applicationContext as MorningBriefApp

    override suspend fun getForegroundInfo(): ForegroundInfo = foreground("Getting started", 0f)

    override suspend fun doWork(): Result {
        val scheduled = inputData.getBoolean(SCHEDULED, false)
        val revoice = inputData.getString(REVOICE)
        val repo = app.repo
        if (!BuildState.lock.tryLock()) return Result.success()
        val result = try {
            if (revoice != null) revoice(repo, revoice) else attempt(repo, scheduled)
        } finally {
            if (BuildState.progress.value.running) BuildState.update(BuildState.Progress())
            BuildState.lock.unlock()
        }
        // A retry keeps its place in the chain; otherwise plan tomorrow.
        if (scheduled && result != Result.retry()) Scheduler.schedule(applicationContext, repo.settings, fromWorker = true)
        return result
    }

    private suspend fun attempt(repo: Repo, scheduled: Boolean): Result {
        if (!repo.isAdmin) {
            // Normal listeners rely on the shared daily audio pack published each morning,
            // never on-device Kokoro/scraping builds.
            val today = LocalDate.now().toString()
            return try {
                if (repo.signedIn) {
                    val pack = StoryPack.fetch(repo.supabase, today, repo.settings.stories, repo.settings.voice)
                    if (pack != null && pack.briefing.date == today) {
                        notifyDone("Your morning brief is ready", readySummary(pack.briefing))
                        return Result.success()
                    }
                }
                if (scheduled && runAttemptCount < 3) Result.retry() else Result.success()
            } catch (e: Exception) {
                if (scheduled && runAttemptCount < 3) Result.retry() else Result.success()
            }
        }

        runCatching { setForeground(foreground("Getting started", 0f)) }
        repo.prefs.lastBuild = JSONObject().put("day", LocalDate.now().toString()).put("started", Instant.now().toString())
        BuildState.update(BuildState.Progress(running = true, step = "Getting started"))
        return try {
            val doc = Builder(applicationContext, repo).build { step, fraction ->
                BuildState.update(BuildState.Progress(running = true, step = step, fraction = fraction))
                runCatching { setForeground(foreground(step, fraction)) }
            }
            repo.prefs.lastBuild = repo.prefs.lastBuild.put("ok", true).put("finished", Instant.now().toString())
            BuildState.update(BuildState.Progress())
            notifyDone("Your morning brief is ready", readySummary(doc))
            Result.success()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            val message = (e as? BuildFailed)?.message ?: "Something went wrong: ${e.message ?: e.javaClass.simpleName}"
            repo.prefs.lastBuild = repo.prefs.lastBuild.put("ok", false).put("error", message)
            BuildState.update(BuildState.Progress(error = message))
            if (scheduled && e !is BuildFailed && runAttemptCount < 2) return Result.retry()
            notifyDone("Couldn't make today's brief", message)
            Result.failure()
        }
    }

    /** Records an existing briefing again in the voice now chosen. */
    private suspend fun revoice(repo: Repo, date: String): Result {
        runCatching { setForeground(foreground("Getting started", 0f, "Re-recording your brief")) }
        BuildState.update(BuildState.Progress(running = true, step = "Getting started"))
        return try {
            Builder(applicationContext, repo).revoice(date) { step, fraction ->
                BuildState.update(BuildState.Progress(running = true, step = step, fraction = fraction))
                runCatching { setForeground(foreground(step, fraction, "Re-recording your brief")) }
            }
            BuildState.update(BuildState.Progress())
            Result.success()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            val message = (e as? BuildFailed)?.message ?: "Couldn't re-record: ${e.message ?: e.javaClass.simpleName}"
            BuildState.update(BuildState.Progress(error = message))
            Result.failure()
        }
    }

    private fun readySummary(doc: JSONObject): String {
        val minutes = (doc.optDouble("duration") / 60).let { if (it < 1) 1 else Math.round(it).toInt() }
        val stories = doc.optJSONArray("stories")
        val count = stories?.length() ?: 0
        // Leading with the top story gives a reason to tap.
        val lead = stories?.optJSONObject(0)?.optString("headline")?.trim().orEmpty()
        val tail = "$count stories, about $minutes min."
        return if (lead.isBlank()) "$tail Tap to listen." else "$lead · $tail"
    }

    private fun readySummary(b: Briefing): String {
        val minutes = (b.duration / 60).let { if (it < 1) 1 else Math.round(it).toInt() }
        val count = b.cards.size
        val lead = b.cards.firstOrNull()?.headline?.trim().orEmpty()
        val tail = "$count stories, about $minutes min."
        return if (lead.isBlank()) "$tail Tap to listen." else "$lead · $tail"
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        applicationContext, 0,
        Intent(applicationContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun foreground(step: String, fraction: Float, title: String = "Making your brief"): ForegroundInfo {
        val n: Notification = NotificationCompat.Builder(applicationContext, MorningBriefApp.CHANNEL_BUILD)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(step)
            .setProgress(100, (fraction * 100).toInt(), fraction <= 0f)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openApp())
            .build()
        return ForegroundInfo(PROGRESS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    private fun notifyDone(title: String, text: String) {
        val n = NotificationCompat.Builder(applicationContext, MorningBriefApp.CHANNEL_READY)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .build()
        val allowed = ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (allowed) NotificationManagerCompat.from(applicationContext).notify(DONE_ID, n)
    }

    companion object {
        const val SCHEDULED = "scheduled"
        const val REVOICE = "revoice"
        private const val PROGRESS_ID = 41
        private const val DONE_ID = 42
    }
}
