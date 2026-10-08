package me.vattitude.morningbrief.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Headphones
import androidx.compose.material.icons.outlined.RssFeed
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage

/** How much of the bottom of the screen the floating bars cover; screens pad their content by it. */
val LocalBottomInset = compositionLocalOf { 120.dp }

/** Room each screen leaves around its content, clear of the floating bars. */
@Composable
fun screenPadding() = PaddingValues(start = 20.dp, end = 20.dp, top = 24.dp, bottom = LocalBottomInset.current + 16.dp)

/**
 * The floating bars' fill: opaque, and a clear step lighter than the panels behind it in dark mode
 * (white in light mode), so the controls read as a layer above the news.
 */
val Tokens.bar: Color get() = if (dark) Color(0xFF2E2E2B) else Color.White

/** The bars' edge: a fine light rim in dark mode, a soft dark one in light mode. */
private val Tokens.barLine: Color get() = if (dark) Color(0x33FFFFFF) else Color(0x1A000000)

/** The floating bars' pill: a deep shadow, opaque fill and a crisp edge. */
fun Modifier.floating(t: Tokens) = this
    .shadow(if (t.dark) 24.dp else 16.dp, CircleShape,
        ambientColor = Color.Black.copy(alpha = if (t.dark) .7f else .18f),
        spotColor = Color.Black.copy(alpha = if (t.dark) .8f else .28f))
    .clip(CircleShape).background(t.bar).border(1.dp, t.barLine, CircleShape)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Root(vm: AppViewModel) {
    val tab by vm.tab.collectAsState()
    val message by vm.message.collectAsState()
    val st by vm.settings.collectAsState()
    val saved by vm.saved.collectAsState()
    val edited by vm.dirty.collectAsState()
    val pending by vm.pendingEnabled.collectAsState()
    val player by vm.player.collectAsState()
    val playing by vm.nowPlaying.collectAsState()
    val heroVisible by vm.heroVisible.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(message) {
        message?.let {
            snackbar.showSnackbar(it)
            vm.message.value = null
        }
    }
    val t = Mb.t
    val density = LocalDensity.current
    var inset by remember { mutableStateOf(120.dp) }
    val keyboard = WindowInsets.isImeVisible
    // Only a real edit raises the bar: comparing the draft with the saved copy made it appear on
    // its own when the two differed for reasons the user never touched.
    val showSave = (edited || pending.isNotEmpty()) && tab != Tab.Today && !keyboard
    val showMini = playing != null && player.date == playing?.date && (tab != Tab.Today || !heroVisible) && !keyboard
    Box(Modifier.fillMaxSize().backdrop(t)) {
        CompositionLocalProvider(LocalBottomInset provides inset) {
            val m = Modifier.fillMaxSize().statusBarsPadding()
            when (tab) {
                Tab.Today -> TodayScreen(vm, m)
                Tab.Sources -> SourcesScreen(vm, m)
                Tab.Settings -> SettingsScreen(vm, m)
            }
        }
        // The news fades into the background behind the bars, so a headline never runs into a control.
        Box(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(inset + 40.dp).background(
                Brush.verticalGradient(0f to t.bg.copy(alpha = 0f), .3f to t.bg.copy(alpha = .9f), .5f to t.bg),
            ),
        )
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .onSizeChanged { inset = with(density) { it.height.toDp() } }
                .navigationBarsPadding().imePadding().padding(start = 20.dp, end = 20.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            SnackbarHost(snackbar, Modifier.align(Alignment.CenterHorizontally)) {
                Snackbar(it, containerColor = t.ink, contentColor = t.onInk, shape = CircleShape)
            }
            AnimatedVisibility(showSave, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
                SaveBar(onDiscard = vm::discard, onSave = vm::save)
            }
            AnimatedVisibility(showMini && !showSave, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
                playing?.let { MiniPlayer(it, player, colorPhotos = saved.colorPhotos, onOpen = vm::openPlayer, onToggle = vm::togglePlaying, onNext = { vm.jump(true) }) }
            }
            if (!keyboard) TabBar(tab) { vm.tab.value = it }
        }
    }
}

/** Unsaved changes on Sources or Settings; the same draft, so either page can save it. */
@Composable
private fun SaveBar(onDiscard: () -> Unit, onSave: () -> Unit) {
    val t = Mb.t
    Row(
        Modifier.fillMaxWidth().height(60.dp).floating(t).padding(start = 20.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Unsaved changes", Modifier.weight(1f), style = Type.value, color = t.ink)
        TextButton(onClick = onDiscard) { Text("Discard", style = Type.value, color = t.muted) }
        PillButton("Save", onClick = onSave)
    }
}

/** The briefing that's playing, when its player card is out of sight: tap to go back to it. */
@Composable
private fun MiniPlayer(b: Briefing, player: PlayerState, colorPhotos: Boolean = false, onOpen: () -> Unit, onToggle: () -> Unit, onNext: () -> Unit) {
    val t = Mb.t
    val pos = player.position
    val card = b.cards.lastOrNull { pos >= it.start && pos < it.end }
    val chapter = b.chapters.lastOrNull { pos >= it.start }
    val section = card?.let { c -> b.sections.firstOrNull { it.key == c.section }?.title }
    val title = card?.headline ?: chapter?.title?.ifBlank { null } ?: b.title
    val total = b.duration.coerceAtLeast(1.0)
    Box(Modifier.fillMaxWidth().height(64.dp).floating(t).clickable(onClick = onOpen)) {
        Row(Modifier.fillMaxSize().padding(start = 8.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            val image = card?.image ?: b.cards.firstOrNull { it.image != null }?.image
            if (image != null) {
                AsyncImage(model = image, contentDescription = null, contentScale = ContentScale.Crop,
                    colorFilter = if (colorPhotos) null else Grayscale,
                    modifier = Modifier.size(46.dp).clip(CircleShape).background(t.track))
            } else {
                Box(Modifier.size(46.dp).clip(CircleShape).background(t.track), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.GraphicEq, null, Modifier.size(20.dp), tint = t.ink)
                }
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = Type.value.copy(fontWeight = FontWeight.Medium), color = t.ink, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
                Text(listOfNotNull(section, "${clock(pos)} / ${clock(b.duration)}").joinToString(" · "),
                    Modifier.padding(top = 2.dp), style = Type.tiny, color = t.muted, maxLines = 1)
                // How far through.
                Box(Modifier.padding(top = 6.dp, end = 8.dp).fillMaxWidth().height(2.dp).clip(CircleShape).background(t.track)) {
                    Box(Modifier.fillMaxWidth((pos / total).toFloat().coerceIn(0f, 1f)).fillMaxHeight().background(t.ink))
                }
            }
            InkCircle(if (player.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                if (player.playing) "Pause" else "Play", size = 42.dp, onClick = onToggle)
            Icon(Icons.Filled.SkipNext, "Next story", Modifier.padding(start = 4.dp).size(42.dp).clip(CircleShape)
                .clickable(onClick = onNext).padding(9.dp), tint = t.ink)
        }
    }
}

@Composable
private fun TabBar(tab: Tab, onSelect: (Tab) -> Unit) {
    val t = Mb.t
    Row(
        Modifier.fillMaxWidth().height(64.dp).floating(t).padding(6.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for ((item, icon) in listOf(
            Tab.Today to Icons.Outlined.Headphones,
            Tab.Sources to Icons.Outlined.RssFeed,
            Tab.Settings to Icons.Outlined.Tune,
        )) {
            val on = item == tab
            Row(
                Modifier.weight(1f).fillMaxHeight().clip(CircleShape)
                    .background(if (on) t.ink else Color.Transparent).clickable { onSelect(item) },
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(icon, null, Modifier.size(19.dp), tint = if (on) t.onInk else t.muted)
                Spacer(Modifier.width(8.dp))
                Text(item.name, style = Type.value.copy(fontWeight = if (on) FontWeight.Medium else FontWeight.Normal),
                    color = if (on) t.onInk else t.muted)
            }
        }
    }
}
