package me.vattitude.morningbrief.ui

import android.app.Application
import android.content.ComponentName
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaPlayer
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.MoreExecutors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import me.vattitude.morningbrief.BuildConfig
import me.vattitude.morningbrief.MorningBriefApp
import me.vattitude.morningbrief.R
import me.vattitude.morningbrief.pipeline.StoryWriter
import me.vattitude.morningbrief.data.Settings
import me.vattitude.morningbrief.data.Pack
import me.vattitude.morningbrief.data.StoryPack
import me.vattitude.morningbrief.data.clipUrl
import me.vattitude.morningbrief.pipeline.KOKORO_VOICES
import me.vattitude.morningbrief.pipeline.Kokoro
import me.vattitude.morningbrief.pipeline.KokoroPack
import me.vattitude.morningbrief.pipeline.packVoice
import org.json.JSONArray
import me.vattitude.morningbrief.pipeline.MAX_PER_SECTION
import me.vattitude.morningbrief.pipeline.PHONE_VOICE
import me.vattitude.morningbrief.pipeline.PICKS
import me.vattitude.morningbrief.pipeline.Place
import me.vattitude.morningbrief.pipeline.QUICK_MIX
import me.vattitude.morningbrief.pipeline.Source
import me.vattitude.morningbrief.pipeline.Speech
import me.vattitude.morningbrief.pipeline.fitBudget
import me.vattitude.morningbrief.pipeline.kokoroVoice
import me.vattitude.morningbrief.pipeline.picksCount
import me.vattitude.morningbrief.pipeline.searchPlaces
import me.vattitude.morningbrief.pipeline.withPicks
import me.vattitude.morningbrief.playback.PlaybackService
import me.vattitude.morningbrief.work.BuildState
import me.vattitude.morningbrief.work.Scheduler
import me.vattitude.morningbrief.work.VoicePackWorker
import java.time.LocalDate

enum class Tab { Today, Sources, Settings }

data class PlayerState(val date: String? = null, val playing: Boolean = false, val position: Double = 0.0, val ready: Boolean = false)

data class Deleting(val busy: Boolean = false, val error: String? = null)
data class SignIn(val busy: Boolean = false, val error: String? = null)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = (app as MorningBriefApp).repo

    val tab = MutableStateFlow(Tab.Today)
    val message = MutableStateFlow<String?>(null)
    val appearance = MutableStateFlow(repo.prefs.appearance)

    fun setAppearance(value: String) {
        repo.prefs.appearance = value
        appearance.value = value
    }

    /** What's saved, and the Settings screen's draft; the draft is only kept once Save is tapped. */
    private val _saved = MutableStateFlow(repo.settings)
    val saved: StateFlow<Settings> = _saved
    private val _settings = MutableStateFlow(repo.settings)
    val settings: StateFlow<Settings> = _settings
    val signedInEmail = MutableStateFlow(repo.email)

    val dates = MutableStateFlow<List<String>>(emptyList())
    val selected = MutableStateFlow<String?>(null)
    val briefing = MutableStateFlow<Briefing?>(null)
    val build: StateFlow<BuildState.Progress> = BuildState.progress

    val player = MutableStateFlow(PlayerState())
    /** The briefing in the player, which may not be the one on screen. */
    val nowPlaying = MutableStateFlow<Briefing?>(null)
    private var nowPlayingTried: String? = null
    /** Whether the Today page's player card is on screen; when it isn't, a small player floats above the tabs. */
    val heroVisible = MutableStateFlow(true)
    /** Bumped to bring the Today page back to its player card. */
    val showHero = MutableStateFlow(0)
    private var controller: MediaController? = null
    private var ticker: Job? = null
    /** The shared day's clips assembled for this listener; null while loading or when a day has no pack. */
    private val packs = mutableMapOf<String, Pack?>()
    /** The pack the player is on, so positions can be read across the whole playlist. */
    private var currentPack: Pack? = null

    val sources = MutableStateFlow<List<Source>>(emptyList())
    val sourcesNote = MutableStateFlow<String?>(null)
    val sourcesBusy = MutableStateFlow(false)
    val sharedUrl = MutableStateFlow<String?>(null)
    /** Switches on the user's own sources not yet saved, by source id. */
    val pendingEnabled = MutableStateFlow<Map<Long, Boolean>>(emptyMap())

    private var preview: Speech? = null

    /** The natural-voice pack on the phone, if any. */
    val packInstalled = MutableStateFlow(KokoroPack.current(app))
    val packDownload: StateFlow<VoicePackWorker.State> = VoicePackWorker.state
    /** The voice whose sample is being prepared, for a spinner. */
    val previewing = MutableStateFlow<String?>(null)
    private var kokoro: Pair<Pair<KokoroPack, Boolean>, Kokoro>? = null
    private var sample: AudioTrack? = null
    private var sampleJob: Job? = null

    val signIn = MutableStateFlow(SignIn())

    init {
        refreshBriefings()
        viewModelScope.launch {
            var wasRunning = BuildState.progress.value.running
            BuildState.progress.collect {
                if (wasRunning && !it.running) refreshBriefings(selectLatest = true)
                wasRunning = it.running
            }
        }
        viewModelScope.launch {
            VoicePackWorker.state.collect {
                if (it.done) {
                    releaseKokoro()
                    packInstalled.value = KokoroPack.current(getApplication())
                    refreshSaved()
                }
            }
        }
    }

    // ---- Lifecycle ------------------------------------------------------------------------

    fun onOpen() {
        val today = LocalDate.now().toString()
        // Before setup is done there's nothing to build with yet; setup makes the first brief itself.
        if (repo.prefs.onboarded) Scheduler.catchUp(getApplication(), repo.settings, repo.briefings.load(today) != null,
            repo.prefs.lastBuild.optString("day").ifEmpty { null })
        refreshBriefings()
        connectPlayer()
        packInstalled.value = KokoroPack.current(getApplication())
        viewModelScope.launch {
            repo.pullSettings()
            refreshSaved()
        }
    }

    // ---- First run -------------------------------------------------------------------------

    val onboarded = MutableStateFlow(repo.prefs.onboarded)

    /** Keeps the choices from setup, then lands on today's brief. Nothing is built on the phone. */
    fun finishOnboarding() {
        stopDemo()
        val new = _settings.value.copy(daily = true)
        _settings.value = new
        viewModelScope.launch {
            repo.saveSettings(new)
            _saved.value = repo.settings
            // Still scheduled: the same worker posts the quiet "your brief is ready" alert.
            Scheduler.schedule(getApplication(), new)
            repo.prefs.onboarded = true
            tab.value = Tab.Today
            onboarded.value = true
            select(LocalDate.now().toString())
        }
    }

    /** A recorded briefing to hear on the welcome screen: the fraction played, or null when stopped. */
    val demo = MutableStateFlow<Float?>(null)
    private var demoPlayer: MediaPlayer? = null
    private var demoJob: Job? = null

    fun toggleDemo() {
        if (demoPlayer != null) return stopDemo()
        stopSample()
        val speech = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        val mp = MediaPlayer.create(getApplication(), R.raw.sample_brief, speech, 0) ?: return
        demoPlayer = mp
        mp.setOnCompletionListener { stopDemo() }
        mp.start()
        demo.value = 0f
        demoJob = viewModelScope.launch {
            while (isActive) {
                demoPlayer?.let { demo.value = it.currentPosition / it.duration.coerceAtLeast(1).toFloat() }
                delay(200)
            }
        }
    }

    fun stopDemo() {
        demoJob?.cancel()
        demoPlayer?.release()
        demoPlayer = null
        demo.value = null
    }

    /** Tries the draft's summary key on a made-up story: null when it works, otherwise what went wrong. */
    suspend fun checkSummaries(): String? = withContext(Dispatchers.IO) { StoryWriter.forSettings(_settings.value).check() }

    // ---- Reports -----------------------------------------------------------------------------

    /** The first-run "while you wait" cards: shown until dismissed or the first brief lands. */
    val upsellsSeen = MutableStateFlow(repo.prefs.upsellsSeen)
    fun dismissUpsells() {
        repo.prefs.upsellsSeen = true
        upsellsSeen.value = true
    }

    /** Stories reported from this phone, so their button says so. */
    val reported = MutableStateFlow(repo.prefs.reported)

    /** Sends a reader's report on a story's summary: null when it's sent, otherwise why not. */
    suspend fun report(card: Card, date: String, reason: String, note: String): String? {
        val fields = org.json.JSONObject()
            .put("reason", reason).put("note", note.trim().take(1000))
            .put("headline", card.headline.take(500)).put("summary", card.summary.take(4000))
            .put("url", card.url.take(2000)).put("source", card.source.take(200))
            .put("writer", card.writer.ifBlank { "unknown" }.take(100))
            .put("app", "android ${BuildConfig.VERSION_NAME} · $date".take(40))
        return try {
            withContext(Dispatchers.IO) { repo.supabase.report(fields) }
            repo.prefs.reported = repo.prefs.reported + card.id
            reported.value = repo.prefs.reported
            null
        } catch (e: Exception) {
            android.util.Log.w("MorningBrief", "Report failed", e)
            "Couldn't send the report. Check your connection and try again."
        }
    }

    fun onClose() {
        stopDemo()
        ticker?.cancel()
        controller?.release()
        controller = null
        stopSample()
        releaseKokoro()
    }

    /** Off the main thread: closing waits for a sample that's still being generated. */
    private fun releaseKokoro() {
        kokoro?.second?.let { k -> Thread { k.close() }.start() }
        kokoro = null
    }

    override fun onCleared() {
        onClose()
        preview?.close()
    }

    // ---- Briefings and playback -----------------------------------------------------------

    fun refreshBriefings(selectLatest: Boolean = false) {
        val list = repo.briefings.dates()
        dates.value = list
        val keep = selected.value?.takeIf { it in list && !selectLatest }
        select(keep ?: list.firstOrNull())
        // A briefing recorded again replaces its audio: drop the old recording from the player.
        controller?.let { c ->
            val loaded = c.currentMediaItem?.mediaId ?: return@let
            val date = loaded.substringBefore('@')
            val now = repo.briefings.load(date)?.let { Briefing.from(it).mediaId }
            if (now != loaded) {
                c.stop()
                c.clearMediaItems()
                tick()
            }
        }
    }

    /** The voice a briefing would be recorded in now: a Kokoro voice id, or [PHONE_VOICE]. */
    fun currentVoice(st: Settings = _saved.value): Pair<String, String> {
        val k = kokoroVoice(st.voice) ?: KOKORO_VOICES.first().takeIf { st.voice == null }
        return if (k != null && packInstalled.value != null) k.id to k.name else PHONE_VOICE to "Phone voice"
    }

    /** Whether [b] was recorded in a different voice from the one now chosen. */
    fun voiceChanged(b: Briefing, st: Settings = _saved.value): Boolean {
        if (b.voiceId.isEmpty()) return false
        val recorded = if (kokoroVoice(b.voiceId) != null) b.voiceId else PHONE_VOICE
        return recorded != currentVoice(st).first
    }

    fun revoice(date: String) = Scheduler.revoice(getApplication(), date)

    fun select(date: String?) {
        selected.value = date
        briefing.value = date?.let { packs[it] }?.briefing
            ?: date?.let { repo.briefings.load(it) }?.let { Briefing.from(it) }
        if (date != null) fetchPack(date)
    }

    /**
     * The day's shared clips, assembled for this listener's line-up. Fetched in the background
     * and kept, so moving between days is instant the second time. When the requested day has no
     * pack yet, [StoryPack.fetch] returns the most recent published day instead.
     */
    private fun fetchPack(date: String) {
        if (!repo.signedIn || packs.containsKey(date)) return
        viewModelScope.launch {
            val pack = runCatching {
                StoryPack.fetch(repo.supabase, date, _settings.value.stories, _settings.value.voice)
            }.getOrNull()
            packs[date] = pack
            if (pack != null && selected.value == date) {
                nowPlayingTried = null
                briefing.value = pack.briefing
                load(date)
                tick()
            }
        }
    }

    /** Look again for today's brief: the overnight job may have published it since we last checked. */
    fun refreshPack() {
        val today = LocalDate.now().toString()
        packs.remove(today)
        select(today)
    }

    fun buildNow() {
        Scheduler.buildNow(getApplication())
    }

    private fun connectPlayer() {
        if (controller != null) return
        val ctx = getApplication<Application>()
        viewModelScope.launch {
            val c = runCatching {
                MediaController.Builder(ctx, SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java)))
                    .buildAsync().await()
            }.getOrNull() ?: return@launch
            controller = c
            c.addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) = tick()
            })
            tick()
            ticker = viewModelScope.launch {
                while (isActive) {
                    tick()
                    delay(250)
                }
            }
        }
    }

    private fun tick() {
        val c = controller ?: return
        val id = c.currentMediaItem?.mediaId
        val date = id?.substringBefore('@')
        if (nowPlaying.value?.mediaId != id && nowPlayingTried != id) {
            nowPlayingTried = id
            nowPlaying.value = date?.let { d ->
                packs[d]?.briefing ?: briefing.value?.takeIf { it.date == d }
                    ?: repo.briefings.load(d)?.let { Briefing.from(it) }
            }
        }
        player.value = PlayerState(date = date, playing = c.isPlaying, position = globalPosition(c), ready = true)
    }

    /**
     * Seconds into the whole briefing. A playlist's position is per-item, so the clips before the
     * current one are added on; with no pack it is just the single file's position.
     */
    private fun globalPosition(c: MediaController): Double {
        val pack = currentPack ?: return c.currentPosition / 1000.0
        val before = pack.clips.take(c.currentMediaItemIndex.coerceAtLeast(0)).sumOf { it.duration }
        return before + c.currentPosition / 1000.0
    }

    /** Seeks across the whole briefing, mapping seconds onto a (clip, offset) pair for a pack. */
    private fun seekGlobal(c: MediaController, seconds: Double, play: Boolean = false) {
        val pack = currentPack
        val target = seconds.coerceAtLeast(0.0)
        if (pack == null || pack.clips.isEmpty()) {
            c.seekTo((target * 1000).toLong())
        } else {
            var acc = 0.0
            var index = pack.clips.lastIndex
            for ((i, clip) in pack.clips.withIndex()) {
                if (target < acc + clip.duration) { index = i; break }
                acc += clip.duration
            }
            val offset = (target - acc).coerceIn(0.0, pack.clips[index].duration)
            c.seekTo(index, (offset * 1000).toLong())
        }
        if (play) c.play()
    }

    /** To the next story, or back to the start of this one (the one before, if this one just began). */
    fun jump(forward: Boolean) {
        val c = controller ?: return
        val b = nowPlaying.value ?: return
        val pos = globalPosition(c)
        val starts = b.cards.map { it.start }
        val target = if (forward) {
            starts.firstOrNull { it > pos + 0.5 } ?: return
        } else {
            val current = starts.lastOrNull { it <= pos + 0.5 }
            if (current != null && pos - current > 3) current else starts.lastOrNull { it < (current ?: pos) - 0.5 } ?: 0.0
        }
        seekGlobal(c, target)
        tick()
    }

    /** From the floating player: back to Today, showing the briefing that's playing. */
    fun openPlayer() {
        nowPlaying.value?.date?.let { if (it != selected.value) select(it) }
        tab.value = Tab.Today
        showHero.value++
    }

    fun togglePlaying() {
        val c = controller ?: return
        if (c.currentMediaItem == null) return
        if (c.isPlaying) c.pause() else c.play()
        tick()
    }

    /** Loads [date] into the player if it isn't already there. Uses the shared pack when there is one. */
    private fun load(date: String): MediaController? {
        val c = controller ?: return null
        val pack = packs[date]
        val b = pack?.briefing ?: briefing.value?.takeIf { it.date == date }
            ?: repo.briefings.load(date)?.let { Briefing.from(it) }
        val id = b?.mediaId ?: date
        if (c.currentMediaItem?.mediaId != id) {
            if (pack != null && pack.clips.isNotEmpty()) {
                // One MediaItem per clip: Media3 queues them, so a section's intro flows
                // straight into its first story with no gap and no re-encoding.
                currentPack = pack
                c.setMediaItems(pack.clips.map { clip ->
                    MediaItem.Builder()
                        .setMediaId(id)
                        .setUri(clip.url)
                        .setMediaMetadata(MediaMetadata.Builder().setTitle(clip.title).setArtist("Morning Brief").build())
                        .build()
                })
            } else {
                currentPack = null
                val item = MediaItem.Builder()
                    .setMediaId(id)
                    .setUri(Uri.fromFile(repo.briefings.audio(date)))
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(b?.title ?: date).setArtist("Morning Brief").build())
                    .build()
                c.setMediaItem(item)
            }
            c.prepare()
        }
        return c
    }

    fun togglePlay() {
        val date = selected.value ?: return
        val c = load(date) ?: return
        if (c.isPlaying) c.pause() else c.play()
        tick()
    }

    fun seekTo(seconds: Double, play: Boolean = true) {
        val date = selected.value ?: return
        val c = load(date) ?: return
        seekGlobal(c, seconds, play)
        tick()
    }

    fun skip(seconds: Int) {
        val c = controller ?: return
        if (c.currentMediaItem == null) return
        seekGlobal(c, globalPosition(c) + seconds)
        tick()
    }

    // ---- Sources -----------------------------------------------------------------------------

    fun loadSources() {
        viewModelScope.launch {
            sourcesBusy.value = true
            val (list, note) = repo.sources(st = _settings.value)
            sources.value = list
            sourcesNote.value = note
            sourcesBusy.value = false
        }
    }

    /** Whether [source] is on in the draft: catalog switches live in the settings, the user's own in [pendingEnabled]. */
    fun isOn(source: Source, st: Settings, pending: Map<Long, Boolean>): Boolean = when {
        source.builtin -> source.url !in st.disabledUrls && source.id !in st.disabledSources
        else -> pending[source.id] ?: source.enabled
    }

    /** Switches a source on or off in the draft; nothing is kept until [save]. */
    fun setEnabled(source: Source, enabled: Boolean) {
        if (source.builtin) {
            update { st ->
                st.copy(
                    disabledUrls = if (enabled) st.disabledUrls - source.url else st.disabledUrls + source.url,
                    disabledSources = when {
                        source.id < 0 -> st.disabledSources
                        enabled -> st.disabledSources - source.id
                        else -> st.disabledSources + source.id
                    },
                )
            }
        } else {
            val pending = pendingEnabled.value
            pendingEnabled.value = if (enabled == source.enabled) pending - source.id else pending + (source.id to enabled)
        }
    }

    suspend fun addSource(url: String, section: String): String? = try {
        val found = repo.addSource(url, section)
        loadSources()
        sharedUrl.value = null
        val what = when (found.kind) {
            "feed" -> "a news feed"
            "page" -> "a page of links"
            else -> "a single article (read once)"
        }
        message.value = "Added ${found.name.ifBlank { "the link" }} as $what."
        null
    } catch (e: Exception) {
        e.message ?: "That link couldn't be added."
    }

    /** Follows a name or topic; returns an error to show, or null. */
    suspend fun follow(query: String): String? = try {
        val headlines = repo.follow(query)
        loadSources()
        message.value = "Following ${query.trim()}. Today: ${headlines.first()}"
        null
    } catch (e: Exception) {
        e.message ?: "Couldn't follow that."
    }

    /** Stories for a topic, in the draft: at most [MAX_PER_SECTION], with no cap on the brief as a whole. */
    fun setStories(section: String, n: Int) = update { st ->
        st.copy(stories = st.stories + (section to n.coerceIn(0, MAX_PER_SECTION)))
    }

    /** Stories from the user's picks: follows and links share one count. */
    fun setPicks(n: Int) = update { st ->
        st.copy(stories = withPicks(st.stories, n.coerceIn(0, MAX_PER_SECTION)))
    }

    /** Fills the draft with the suggested balanced mix of topics. */
    fun applyQuickMix() = update { it.copy(stories = fitBudget(QUICK_MIX)) }

    /** The city for local news; blank follows the weather city. */
    fun setNewsCity(city: String) {
        update { it.copy(newsCity = city) }
        loadSources()
    }

    fun removeSource(source: Source) {
        viewModelScope.launch {
            runCatching { repo.removeSource(source) }.exceptionOrNull()?.let { message.value = it.message }
            loadSources()
        }
    }

    fun shared(url: String) {
        sharedUrl.value = url
        tab.value = Tab.Sources
    }

    // ---- Settings -----------------------------------------------------------------------------

    /** Changes the draft; nothing is kept until [save]. */
    fun update(change: (Settings) -> Settings) {
        _settings.value = change(_settings.value)
    }

    /** Changes the draft and keeps it right away; for flows with no Save button. */
    fun updateAndSave(change: (Settings) -> Settings) {
        update(change)
        val new = _settings.value
        viewModelScope.launch {
            repo.saveSettings(new)
            _saved.value = repo.settings
        }
    }

    fun save() {
        val new = _settings.value
        val switches = pendingEnabled.value
        viewModelScope.launch {
            val old = repo.settings
            val problem = repo.saveSettings(new)
            val switchProblem = sources.value.filter { !it.builtin && it.id in switches }.firstNotNullOfOrNull { src ->
                repo.setEnabled(src, switches.getValue(src.id))
            }
            pendingEnabled.value = emptyMap()
            if (old.daily != new.daily || old.readyBy != new.readyBy) Scheduler.schedule(getApplication(), new)
            _saved.value = repo.settings
            if (switches.isNotEmpty() || old.localCity != new.localCity) loadSources()
            val today = briefing.value?.takeIf { it.date == LocalDate.now().toString() }
            message.value = problem ?: switchProblem ?: if (old.voice != new.voice && today != null && voiceChanged(today)) {
                "Saved. You can re-record today's brief in the new voice on the Today page."
            } else "Saved. Your next brief uses these."
        }
    }

    fun discard() {
        val cityChanged = _settings.value.localCity != _saved.value.localCity
        _settings.value = _saved.value
        pendingEnabled.value = emptyMap()
        if (cityChanged) loadSources()
    }

    /** Takes in changes saved elsewhere (sync, sign-in, a finished download), keeping a draft in progress. */
    private fun refreshSaved() {
        val before = _saved.value
        val now = repo.settings
        _saved.value = now
        if (_settings.value == before) _settings.value = now
    }

    suspend fun places(query: String): List<Place> = withContext(Dispatchers.IO) { searchPlaces(query) }

    fun loadVoices() {
        packInstalled.value = KokoroPack.current(getApplication())
        if (preview == null) viewModelScope.launch {
            preview = preview ?: runCatching { Speech.open(getApplication()) }.getOrNull()
        }
    }

    fun downloadVoices(pack: KokoroPack) = VoicePackWorker.start(getApplication(), pack)

    fun cancelDownload() = VoicePackWorker.cancel(getApplication())

    fun removeVoices() {
        stopSample()
        releaseKokoro()
        KokoroPack.entries.forEach { it.remove(getApplication()) }
        packInstalled.value = null
        viewModelScope.launch {
            val st = repo.settings
            if (kokoroVoice(st.voice) != null) repo.saveSettings(st.copy(voice = PHONE_VOICE))
            refreshSaved()
            if (kokoroVoice(_settings.value.voice) != null) _settings.value = _settings.value.copy(voice = PHONE_VOICE)
            message.value = "Natural voices removed"
        }
    }

    fun packSize(): Long = packInstalled.value?.sizeOnDisk(getApplication()) ?: 0L

    private var narratorPlayer: MediaPlayer? = null

    /**
     * Plays today's greeting in a narrator's own voice: the real clip the briefing plays, so
     * what you hear in Settings is exactly what you get in the morning.
     */
    fun previewNarrator(id: String) {
        stopSample()
        preview?.stop()
        narratorPlayer?.release()
        narratorPlayer = null
        viewModelScope.launch {
            val today = LocalDate.now().toString()
            val notes = runCatching { repo.supabase.voiceNotes(today) }.getOrDefault(JSONArray())
            val note = (0 until notes.length()).map { notes.getJSONObject(it) }
                .firstOrNull { it.optString("voice") == id && it.optString("note_key") == "greeting_morning" }
            if (note == null) {
                message.value = "${packVoice(id).name} hasn't been recorded for today yet."
                return@launch
            }
            val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
            val player = MediaPlayer()
            player.setAudioAttributes(attrs)
            player.setDataSource(getApplication(), Uri.parse(clipUrl(note.optString("audio_path"))))
            player.setOnPreparedListener { it.start() }
            player.setOnCompletionListener {
                previewing.value = null
                it.release()
                if (narratorPlayer === it) narratorPlayer = null
            }
            player.setOnErrorListener { mp, _, _ ->
                previewing.value = null
                mp.release()
                true
            }
            narratorPlayer = player
            previewing.value = id
            player.prepareAsync()
        }
    }

    /** Plays a short greeting in [voice]: Kokoro voices are generated here, phone voices spoken directly. */
    fun previewVoice(voice: String?) {
        stopSample()
        preview?.stop()
        val speed = settings.value.speed
        val who = settings.value.name.trim().ifEmpty { null }
        val line = "Good morning${who?.let { ", $it" } ?: ""}! Here's your briefing for today, starting with the top stories."
        val k = kokoroVoice(voice)
        val pack = packInstalled.value
        if (k == null || pack == null) {
            val s = preview ?: return
            s.setVoice(null)
            s.setSpeed(speed)
            s.speak(line)
            return
        }
        previewing.value = k.id
        sampleJob = viewModelScope.launch {
            try {
                val pcm = withContext(Dispatchers.Default) {
                    val key = pack to k.british
                    val engine = kokoro?.takeIf { it.first == key }?.second ?: run {
                        releaseKokoro()
                        Kokoro.open(pack.dir(getApplication()), k.british).also { kokoro = key to it }
                    }
                    engine.generate(line, k, speed)
                }
                play(pcm.samples, pcm.rate)
            } catch (e: Exception) {
                if (e !is kotlinx.coroutines.CancellationException) message.value = "Couldn't play the sample: ${e.message}"
            } finally {
                previewing.value = null
            }
        }
    }

    private fun play(samples: FloatArray, rate: Int) {
        if (samples.isEmpty()) return
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(samples.size * 4)
            .build()
        track.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
        track.play()
        sample = track
    }

    private fun stopSample() {
        sampleJob?.cancel()
        sample?.let { runCatching { it.stop() }; it.release() }
        sample = null
    }

    /** The web app's Google sign-in page; Google sends people back to the app's own link, handled by [finishGoogle]. */
    fun googleSignInUrl(): Uri = repo.supabase.googleUrl("${getApplication<Application>().packageName}://auth")

    fun finishGoogle(callback: Uri) {
        signIn.value = SignIn(busy = true)
        viewModelScope.launch {
            runCatching { repo.supabase.finishGoogle(callback) }.onSuccess { signedIn() }.onFailure {
                signIn.value = SignIn(error = it.message)
            }
        }
    }

    private suspend fun signedIn() {
        signIn.value = SignIn()
        signedInEmail.value = repo.email
        repo.pullSettings()
        refreshSaved()
        loadSources()
        message.value = "Signed in. Your sources and settings now match the web app."
    }

    val deleting = MutableStateFlow<Deleting?>(null)

    fun deleteAccount() {
        deleting.value = Deleting(busy = true)
        viewModelScope.launch {
            runCatching { repo.supabase.deleteAccount() }.onSuccess {
                deleting.value = null
                signOut()
                message.value = "Your account has been deleted."
            }.onFailure {
                deleting.value = Deleting(error = it.message)
            }
        }
    }

    fun signOut() {
        repo.supabase.signOut()
        signedInEmail.value = null
        loadSources()
    }
}
