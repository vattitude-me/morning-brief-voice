package me.vattitude.morningbrief.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.AcUnit
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.FlashOn
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Umbrella
import androidx.compose.material.icons.outlined.WbCloudy
import androidx.compose.material.icons.outlined.WbSunny
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.material3.TextButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt
import me.vattitude.morningbrief.pipeline.PHONE_VOICE

fun clock(seconds: Double): String {
    val s = seconds.toInt().coerceAtLeast(0)
    return "%d:%02d".format(s / 60, s % 60)
}

@Composable
fun TodayScreen(vm: AppViewModel, modifier: Modifier = Modifier) {
    val briefing by vm.briefing.collectAsState()
    val dates by vm.dates.collectAsState()
    val selected by vm.selected.collectAsState()
    val build by vm.build.collectAsState()
    val player by vm.player.collectAsState()
    val saved by vm.saved.collectAsState()
    val pack by vm.packInstalled.collectAsState()
    val reported by vm.reported.collectAsState()
    var reporting by remember { mutableStateOf<Pair<Card, String>?>(null) }
    reporting?.let { (card, date) -> ReportDialog(vm, card, date) { reporting = null } }
    val context = LocalContext.current
    val t = Mb.t

    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { vm.buildNow() }
    fun startBuild() {
        if (Build.VERSION.SDK_INT >= 33) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS) else vm.buildNow()
    }

    val b = briefing
    val mine = player.date == b?.date
    val position = if (mine) player.position else 0.0
    val playing = mine && player.playing
    val voiceChanged = remember(b, saved, pack) { b != null && vm.voiceChanged(b, saved) }
    val current = b?.cards?.firstOrNull { mine && position >= it.start && position < it.end }
    val chapter = b?.chapters?.lastOrNull { mine && position >= it.start }

    val list = rememberLazyListState()
    val density = LocalDensity.current
    /** Where things are in the list: item indexes by key, and each story's offset within its section. */
    val index = remember { HashMap<String, Int>() }
    val rowTops = remember { HashMap<String, Int>() }
    var touchedAt by remember { mutableLongStateOf(0L) }
    val stillPlaying by rememberUpdatedState(playing)
    LaunchedEffect(list) {
        list.interactionSource.interactions.collect { if (it is DragInteraction.Start) touchedAt = SystemClock.uptimeMillis() }
    }
    // Follow along: bring the story being read into view, unless the reader scrolled in the last few seconds.
    LaunchedEffect(current?.id) {
        val card = current ?: return@LaunchedEffect
        if (!stillPlaying || SystemClock.uptimeMillis() - touchedAt < 8_000) return@LaunchedEffect
        val i = index["s:${card.section}"] ?: return@LaunchedEffect
        val margin = with(density) { 120.dp.roundToPx() }
        list.animateScrollToItem(i, ((rowTops[card.id] ?: 0) - margin).coerceAtLeast(0))
    }
    // The floating player shows once the player card's controls scroll out of sight.
    LaunchedEffect(list) {
        val controls = with(density) { 150.dp.roundToPx() }
        snapshotFlow {
            val hero = index["hero"]
            val info = list.layoutInfo
            hero == null || info.visibleItemsInfo.any { it.index == hero && it.offset + it.size - controls > info.viewportStartOffset }
        }.collect { vm.heroVisible.value = it }
    }
    DisposableEffect(Unit) { onDispose { vm.heroVisible.value = true } }
    val showHero by vm.showHero.collectAsState()
    LaunchedEffect(showHero) { if (showHero > 0) list.animateScrollToItem(0) }

    LazyColumn(modifier.fillMaxSize(), state = list, contentPadding = screenPadding()) {
        var count = 0
        fun entry(key: String? = null, content: @Composable LazyItemScope.() -> Unit) {
            key?.let { index[it] = count }
            count++
            item(key = key, content = content)
        }
        entry {
            val day = b?.date?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: LocalDate.now()
            ScreenHeader(
                overline = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Overline(day.format(DateTimeFormatter.ofPattern("EEE · d MMM", Locale.ENGLISH)), Modifier.weight(1f))
                        b?.wx?.let { wx ->
                            Icon(weatherIcon(wx.code), null, Modifier.size(14.dp), tint = t.muted)
                            Spacer(Modifier.width(6.dp))
                            Overline("${wx.city} ${wx.now}°")
                        }
                    }
                },
                title = "Morning Brief",
                subtitle = if (b == null) "Your news, read aloud each morning." else summaryLine(b),
            )
        }

        if (build.running) entry {
            Notice(Modifier.padding(top = 22.dp)) {
                Text("Making your brief", style = Type.title, color = t.ink)
                Hint(build.step, Modifier.padding(top = 4.dp))
                LinearProgressIndicator(
                    progress = { build.fraction },
                    modifier = Modifier.fillMaxWidth().padding(top = 14.dp).height(6.dp),
                    color = t.ink, trackColor = t.track, strokeCap = StrokeCap.Round, gapSize = 0.dp, drawStopIndicator = {},
                )
                Hint("This takes a few minutes. Feel free to leave the app; it keeps going.", Modifier.padding(top = 10.dp))
            }
        } else build.error?.let { err ->
            entry {
                Notice(Modifier.padding(top = 22.dp)) {
                    Text("Your last brief couldn't be made", style = Type.title, color = t.error)
                    Text(err, Modifier.padding(top = 4.dp), style = Type.body, color = t.ink)
                }
            }
        }

        if (b != null && !build.running && voiceChanged) entry {
            val (id, name) = vm.currentVoice(saved)
            val now = if (id == PHONE_VOICE) "the phone voice" else name
            val then = if (b.voiceId.startsWith("kokoro:")) b.voiceName else "the phone voice"
            Notice(Modifier.padding(top = 22.dp)) {
                Text("You've switched to $now", style = Type.title, color = t.ink)
                Text("This brief was recorded with $then. Re-record it with the same stories, " +
                    "or the new voice starts with your next brief.", Modifier.padding(top = 4.dp), style = Type.body, color = t.muted)
                PillButton("Re-record with $now", Modifier.padding(top = 14.dp)) { vm.revoice(b.date) }
            }
        }

        if (b == null) {
            entry {
                Notice(Modifier.padding(top = 22.dp)) {
                    Text("Your first brief is a tap away", style = Type.title, color = t.ink)
                    Text("Five minutes of the news you choose, read aloud and made right here on your phone. " +
                        "Start with the defaults; you can change sources and voice any time.",
                        Modifier.padding(top = 6.dp), style = Type.body, color = t.muted)
                    PillButton("Make my first brief", Modifier.padding(top = 16.dp), enabled = !build.running) { startBuild() }
                }
            }
            return@LazyColumn
        }

        entry("hero") {
            val cover = (current ?: b.cards.lastOrNull { mine && position >= it.start })?.image
                ?: b.cards.firstOrNull { it.image != null }?.image
            val section = (current?.section ?: chapter?.section)?.let { k -> b.sections.firstOrNull { it.key == k }?.title }
            val state = when {
                !mine || (position < 0.5 && !playing) -> "Ready · ${b.cards.size} stories"
                playing -> listOfNotNull("Now playing", section).joinToString(" · ")
                else -> listOfNotNull("Paused", section).joinToString(" · ")
            }
            val title = current?.headline ?: chapter?.title?.takeIf { mine && it.isNotBlank() } ?: b.title
            Glass(Modifier.fillMaxWidth().padding(top = 22.dp), RoundedCornerShape(26.dp)) {
                Column(Modifier.padding(12.dp)) {
                    if (cover != null) {
                        AsyncImage(
                            model = cover, contentDescription = null, contentScale = ContentScale.Crop, colorFilter = Grayscale,
                            modifier = Modifier.fillMaxWidth().height(190.dp).clip(RoundedCornerShape(16.dp)).background(t.track),
                        )
                    }
                    Column(Modifier.padding(start = 6.dp, end = 6.dp, top = if (cover != null) 16.dp else 6.dp, bottom = 4.dp)) {
                        Overline(state, color = if (playing) t.ink else t.muted)
                        Text(title, Modifier.padding(top = 6.dp), style = Type.title, color = t.ink, maxLines = 2,
                            overflow = TextOverflow.Ellipsis)
                        Progress(b, position, Modifier.padding(top = 12.dp)) { vm.seekTo(it, play = playing || !mine) }
                        Row(Modifier.fillMaxWidth()) {
                            Text(clock(position), Modifier.weight(1f), style = Type.meta, color = t.muted)
                            Text("-" + clock(b.duration - position), style = Type.meta, color = t.muted)
                        }
                        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.Center,
                            verticalAlignment = Alignment.CenterVertically) {
                            Skip(Icons.Filled.SkipPrevious, "Previous story", enabled = mine) { vm.jump(forward = false) }
                            Spacer(Modifier.width(24.dp))
                            InkCircle(if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (playing) "Pause" else "Play",
                                size = 58.dp, enabled = player.ready) { vm.togglePlay() }
                            Spacer(Modifier.width(24.dp))
                            Skip(Icons.Filled.SkipNext, "Next story", enabled = player.ready) {
                                if (mine) vm.jump(forward = true) else b.cards.firstOrNull()?.let { vm.seekTo(it.start) }
                            }
                        }
                        if (!mine) {
                            Hint("Drag along the bar, or tap \u25B6 beside any story, to start there.",
                                Modifier.fillMaxWidth().padding(top = 10.dp), textAlign = TextAlign.Center)
                        }
                    }
                }
            }
        }

        if (dates.size > 1) entry {
            LazyRow(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(dates) { d -> Chip(dayLabel(d), selected = d == selected) { vm.select(d) } }
            }
        }

        for (section in b.sections) {
            val cards = b.cards.filter { it.section == section.key }
            if (cards.isEmpty()) continue
            entry("s:${section.key}") {
                val lead = b.chapters.firstOrNull { it.id == "section:${section.key}" }
                val here = current?.section == section.key
                val holder = remember { arrayOfNulls<LayoutCoordinates>(1) }
                Column(Modifier.onGloballyPositioned { holder[0] = it }) {
                    Row(
                        Modifier.fillMaxWidth().padding(top = 22.dp).clip(RoundedCornerShape(8.dp))
                            .clickable(enabled = lead != null) { lead?.let { vm.seekTo(it.start) } }
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Overline(section.title, Modifier.weight(1f), color = t.ink)
                        if (here) {
                            Box(Modifier.size(6.dp).clip(CircleShape).background(t.ink))
                            Spacer(Modifier.width(6.dp))
                            Overline(if (playing) "Playing" else "Paused", color = t.ink)
                        } else {
                            Overline(if (cards.size == 1) "1 story" else "${cards.size} stories")
                        }
                    }
                    GlassGroup(Modifier.padding(top = 10.dp)) {
                        cards.forEachIndexed { i, card ->
                            if (i > 0) Hairline()
                            StoryRow(
                                card, current = card.id == current?.id, playing = playing,
                                colorPhotos = saved.colorPhotos,
                                modifier = Modifier.onGloballyPositioned { c ->
                                    holder[0]?.takeIf { it.isAttached && c.isAttached }
                                        ?.let { rowTops[card.id] = it.localPositionOf(c, Offset.Zero).y.roundToInt() }
                                },
                                onPlay = { vm.seekTo(card.start) },
                                onOpen = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(card.url))) },
                                reported = card.id in reported,
                                onReport = { reporting = card to b.date },
                            )
                        }
                    }
                }
            }
        }

        if (b.notes.isNotEmpty()) entry {
            Column(Modifier.padding(top = 18.dp, start = 4.dp, end = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (n in b.notes) Hint(n)
            }
        }

        entry {
            PillButton(
                if (b.date == LocalDate.now().toString()) "Make a fresh brief" else "Make today's brief",
                Modifier.fillMaxWidth().padding(top = 22.dp), filled = false, enabled = !build.running, icon = Icons.Outlined.Refresh,
            ) { startBuild() }
        }
    }
}

/** Previous or next story, beside the play button. */
@Composable
private fun Skip(icon: ImageVector, label: String, enabled: Boolean, onClick: () -> Unit) {
    val t = Mb.t
    Icon(icon, label, Modifier.size(44.dp).clip(CircleShape).clickable(enabled = enabled, onClick = onClick).padding(9.dp),
        tint = if (enabled) t.ink else t.muted.copy(alpha = .5f))
}

/** A glass card for status and prompts. */
@Composable
private fun Notice(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Glass(modifier.fillMaxWidth()) { Column(Modifier.padding(18.dp)) { content() } }
}

/** "12 stories, five minutes. Light drizzle, high 21°." */
private fun summaryLine(b: Briefing): String {
    val n = b.cards.size
    val minutes = (b.duration / 60).roundToInt().coerceAtLeast(1)
    val words = listOf("one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve")
    val m = words.getOrNull(minutes - 1) ?: "$minutes"
    var line = "${if (n == 1) "1 story" else "$n stories"}, $m minute${if (minutes == 1) "" else "s"}."
    b.wx?.let { line += " ${it.conditions.replaceFirstChar { c -> c.uppercase() }}, high ${it.high}°." }
    return line
}

private fun weatherIcon(code: Int): ImageVector = when (code) {
    0, 1 -> Icons.Outlined.WbSunny
    2 -> Icons.Outlined.WbCloudy
    in 51..67, in 80..82 -> Icons.Outlined.Umbrella
    in 71..77, 85, 86 -> Icons.Outlined.AcUnit
    in 95..99 -> Icons.Outlined.FlashOn
    else -> Icons.Outlined.Cloud
}

/** The progress bar, one segment per story, with a thumb to drag; tap or drag to move through the briefing. */
@Composable
private fun Progress(b: Briefing, position: Double, modifier: Modifier = Modifier, onSeek: (Double) -> Unit) {
    val t = Mb.t
    val total = b.duration.coerceAtLeast(1.0)
    val marks = remember(b) {
        (listOf(0.0) + b.cards.map { it.start }.filter { it > 0.5 && it < total } + total).distinct().sorted()
    }
    var dragging by remember { mutableStateOf<Double?>(null) }
    val seek by rememberUpdatedState(onSeek)
    val shown = dragging ?: position
    Canvas(
        modifier.fillMaxWidth().height(32.dp)
            .pointerInput(total) { detectTapGestures { seek((it.x / size.width).coerceIn(0f, 1f) * total) } }
            .pointerInput(total) {
                detectHorizontalDragGestures(
                    onDragStart = { dragging = (it.x / size.width).coerceIn(0f, 1f) * total },
                    onHorizontalDrag = { change, _ -> dragging = (change.position.x / size.width).coerceIn(0f, 1f) * total },
                    onDragEnd = { dragging?.let { seek(it) }; dragging = null },
                    onDragCancel = { dragging = null },
                )
            },
    ) {
        val gap = 3.dp.toPx()
        val h = 6.dp.toPx()
        val top = (size.height - h) / 2
        val usable = size.width - gap * (marks.size - 2)
        val r = CornerRadius(h / 2)
        var x = 0f
        var thumb = 0f
        for (i in 0 until marks.size - 1) {
            val w = (usable * (marks[i + 1] - marks[i]) / total).toFloat()
            drawRoundRect(t.ink.copy(alpha = if (t.dark) .18f else .12f), Offset(x, top), Size(w, h), r)
            val done = ((shown - marks[i]) / (marks[i + 1] - marks[i])).coerceIn(0.0, 1.0).toFloat()
            if (done > 0f) {
                drawRoundRect(t.ink, Offset(x, top), Size(w * done, h), r)
                thumb = x + w * done
            }
            x += w + gap
        }
        val radius = (if (dragging != null) 10.dp else 7.dp).toPx()
        val cx = thumb.coerceIn(radius, size.width - radius)
        drawCircle(t.ink, radius, Offset(cx, size.height / 2))
        drawCircle(t.onInk, radius * .38f, Offset(cx, size.height / 2))
    }
}

/**
 * One story. The round button plays from it; tapping the row opens its summary. The story being read is tinted
 * and opens by itself.
 */
@Composable
private fun StoryRow(
    card: Card,
    current: Boolean,
    playing: Boolean,
    colorPhotos: Boolean = false,
    modifier: Modifier = Modifier,
    onPlay: () -> Unit,
    onOpen: () -> Unit,
    reported: Boolean = false,
    onReport: () -> Unit = {},
) {
    val t = Mb.t
    var open by remember(current) { mutableStateOf(current) }
    val tint = t.ink.copy(alpha = if (t.dark) .10f else .06f)
    Column(
        modifier.fillMaxWidth()
            .drawBehind {
                if (current) drawRoundRect(tint, Offset(-8.dp.toPx(), 5.dp.toPx()),
                    Size(size.width + 16.dp.toPx(), size.height - 10.dp.toPx()), CornerRadius(16.dp.toPx()))
            }
            .clickable { open = !open }.padding(vertical = 14.dp).animateContentSize(),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.width(40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier.size(32.dp).clip(CircleShape)
                        .background(if (current) t.ink else t.track)
                        .clickable(onClickLabel = "Play from this story", onClick = onPlay),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(if (current && playing) Icons.Outlined.GraphicEq else Icons.Filled.PlayArrow,
                        if (current && playing) "Playing" else "Play from here", Modifier.size(16.dp),
                        tint = if (current) t.onInk else t.ink)
                }
                Text(clock(card.start), Modifier.padding(top = 4.dp), style = Type.tiny, color = if (current) t.ink else t.muted)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(card.headline, style = Type.title, color = t.ink)
                val secs = (card.end - card.start).roundToInt()
                val meta = listOfNotNull(
                    card.source.ifBlank { null },
                    (if (secs < 60) "${secs}s" else clock(secs.toDouble())) + " of audio",
                    card.also.size.takeIf { it > 0 }?.let { "+$it source${if (it == 1) "" else "s"}" },
                )
                Text(meta.joinToString(" · "), Modifier.padding(top = 5.dp), style = Type.meta, color = t.muted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (card.image != null) {
                Spacer(Modifier.width(12.dp))
                AsyncImage(model = card.image, contentDescription = null, contentScale = ContentScale.Crop,
                    colorFilter = if (colorPhotos) null else Grayscale,
                    modifier = Modifier.size(56.dp).clip(RoundedCornerShape(12.dp)).background(t.track))
            }
        }
        if (open) {
            Column(Modifier.padding(start = 52.dp, top = 10.dp)) {
                Text(card.summary, style = Type.body, color = t.ink)
                if (card.also.isNotEmpty()) {
                    Hint("Also covered by ${card.also.joinToString(", ")}", Modifier.padding(top = 6.dp))
                }
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!current) PillButton("Play from here", icon = Icons.Filled.PlayArrow, onClick = onPlay)
                    PillButton("Article", filled = false, icon = Icons.AutoMirrored.Outlined.OpenInNew, onClick = onOpen)
                }
                // Summaries are written by AI, so anyone can flag one that's wrong or harmful without leaving the app.
                Row(
                    Modifier.padding(top = 10.dp).clip(CircleShape)
                        .clickable(enabled = !reported, onClickLabel = "Report this summary", onClick = onReport)
                        .padding(vertical = 6.dp, horizontal = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Outlined.Flag, null, Modifier.size(14.dp), tint = t.muted)
                    Spacer(Modifier.width(6.dp))
                    Text(if (reported) "Reported. Thanks" else "Report this summary", style = Type.meta, color = t.muted)
                }
            }
        }
    }
}

private val REPORT_REASONS = listOf(
    "inaccurate" to "Wrong or misleading",
    "offensive" to "Offensive or harmful",
    "broken" to "Doesn't match the article",
    "other" to "Something else",
)

/** Flags a story's AI-written summary for review. */
@Composable
private fun ReportDialog(vm: AppViewModel, card: Card, date: String, onDismiss: () -> Unit) {
    val t = Mb.t
    val scope = rememberCoroutineScope()
    var reason by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!sending) onDismiss() },
        containerColor = t.bg,
        title = { Text("Report this summary", style = Type.title, color = t.ink) },
        text = {
            Column {
                Text("Summaries are written by AI and can get things wrong. What's the problem?",
                    style = Type.body, color = t.muted)
                Column(Modifier.padding(top = 12.dp)) {
                    REPORT_REASONS.forEach { (key, label) ->
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { reason = key }
                                .padding(vertical = 10.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CheckDot(reason == key)
                            Spacer(Modifier.width(12.dp))
                            Text(label, style = Type.value, color = t.ink)
                        }
                    }
                }
                PillField(note, { note = it.take(1000) }, "Anything to add? (optional)", Modifier.padding(top = 8.dp).fillMaxWidth())
                error?.let { Hint(it, Modifier.padding(top = 8.dp), color = t.error) }
            }
        },
        confirmButton = {
            PillButton("Send", enabled = reason != null, busy = sending) {
                val why = reason ?: return@PillButton
                sending = true
                error = null
                scope.launch {
                    error = vm.report(card, date, why, note)
                    sending = false
                    if (error == null) {
                        vm.message.value = "Thanks. We'll take a look."
                        onDismiss()
                    }
                }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !sending) { Text("Cancel", color = t.ink) } },
    )
}

private fun dayLabel(date: String): String {
    val d = runCatching { LocalDate.parse(date) }.getOrNull() ?: return date
    val today = LocalDate.now()
    return when (d) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> d.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.ENGLISH))
    }
}
