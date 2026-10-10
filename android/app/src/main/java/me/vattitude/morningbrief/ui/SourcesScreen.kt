package me.vattitude.morningbrief.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import me.vattitude.morningbrief.pipeline.FOLLOW_EXAMPLES
import me.vattitude.morningbrief.pipeline.MAX_PER_SECTION
import me.vattitude.morningbrief.pipeline.PICKS
import me.vattitude.morningbrief.pipeline.SECTIONS
import me.vattitude.morningbrief.pipeline.Section
import me.vattitude.morningbrief.pipeline.Source
import me.vattitude.morningbrief.pipeline.picksCount
import java.net.URI

/** A page of links the app can read without a feed, to show that any link works. */
private const val LINK_EXAMPLE = "cbc.ca/sports/hockey/nhl"

// "Your picks" (names or links people follow) is parked while the seven fixed categories settle,
// exactly as the web app does it: the shared daily pack only carries those seven, so a followed
// source could never be voiced. Everything the card needs is still below — flip this to true to
// bring it back.
private const val SHOW_MY_SOURCES = false

/** A web address rather than a name: "https://…", or a bare domain with an optional path. */
private val LINKISH = Regex("^([\\w-]+\\.)+[a-z]{2,}(:\\d+)?(/\\S*)?$", RegexOption.IGNORE_CASE)

internal fun looksLikeLink(input: String): Boolean =
    input.trim().let { it.startsWith("http://", true) || it.startsWith("https://", true) || LINKISH.matches(it) }

@Composable
fun SourcesScreen(vm: AppViewModel, modifier: Modifier = Modifier) {
    val sources by vm.sources.collectAsState()
    val note by vm.sourcesNote.collectAsState()
    val busy by vm.sourcesBusy.collectAsState()
    val email by vm.signedInEmail.collectAsState()
    val st by vm.settings.collectAsState()
    val pending by vm.pendingEnabled.collectAsState()
    var removing by remember { mutableStateOf<Source?>(null) }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    val t = Mb.t
    fun on(src: Source) = vm.isOn(src, st, pending)

    LaunchedEffect(email) { vm.loadSources() }
    LaunchedEffect(note) {
        if (note != null) {
            delay(8_000)
            vm.sourcesNote.value = null
        }
    }

    LazyColumn(modifier.fillMaxSize(), contentPadding = screenPadding()) {
        item {
            ScreenHeader(
                overline = { Overline(if (email != null) "Synced with the web app" else "On this phone") },
                title = "Sources",
                subtitle = "What goes into tomorrow's brief.",
            )
        }
        note?.let { n -> item { Hint(n, Modifier.padding(top = 12.dp), color = t.error) } }
        if (busy && sources.isEmpty()) item {
            CircularProgressIndicator(Modifier.padding(top = 22.dp).size(24.dp), color = t.ink, strokeWidth = 2.dp)
        }

        item {
            Hint("Set story counts, turn topics off, or open one to review its sources.",
                Modifier.padding(start = 4.dp, top = 4.dp))
        }

        if (SHOW_MY_SOURCES) item {
            Picks(vm, picksCount(st.stories), canRaise = true, sources.filter { it.section in PICKS }, ::on) { removing = it }
        }

        item(key = "topics") {
            GlassGroup {
                SECTIONS.values.filter { it.isCategory || it.key == "local" }.forEachIndexed { i, s ->
                    if (i > 0) Hairline()
                    val n = st.stories[s.key] ?: 0
                    val city = st.localCity.substringBefore(",").trim()
                    val label = if (s.key == "local" && city.isNotBlank()) "${s.title} · $city" else s.title
                    val topicSources = sources.filter { it.section == s.key }
                    val open = (expanded[s.key] ?: false) && topicSources.isNotEmpty()
                    Topic(
                        section = s,
                        label = label,
                        n = n,
                        canRaise = true,
                        open = open,
                        onExpand = { expanded[s.key] = !open },
                        onChange = { vm.setStories(s.key, it) },
                        sources = topicSources,
                        on = ::on,
                        onToggle = { src, enabled -> vm.setEnabled(src, enabled) },
                    ) {
                        if (s.key == "local") LocalCity(vm, st.newsCity, st.city)
                    }
                }
            }
        }
    }

    removing?.let { src ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(if (src.section == "follow") "Stop following ${src.name}?" else "Remove ${src.name}?", style = Type.title) },
            confirmButton = { TextButton(onClick = { vm.removeSource(src); removing = null }) { Text("Remove", color = t.error) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel", color = t.ink) } },
        )
    }
}

/**
 * One topic as an expandable card: the header always shows its story count, and tapping it reveals
 * every source in the topic (so a topic set to Off can still be browsed and its sources toggled).
 */
@Composable
private fun Topic(
    section: Section,
    label: String,
    n: Int,
    canRaise: Boolean,
    open: Boolean,
    onExpand: () -> Unit,
    onChange: (Int) -> Unit,
    sources: List<Source>,
    on: (Source) -> Boolean,
    onToggle: (Source, Boolean) -> Unit,
    local: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    val t = Mb.t
    val openable = sources.isNotEmpty()
    Column {
        Row(
            Modifier.fillMaxWidth().clickable(enabled = openable, onClick = onExpand)
                .padding(horizontal = 4.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f).padding(end = 10.dp)) {
                Text(label, style = Type.title, color = t.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val sourceCount = when (sources.size) {
                    1 -> "1 source"
                    0 -> ""
                    else -> "${sources.size} sources"
                }
                val storyCount = if (n == 0) "Off" else "$n ${if (n == 1) "story" else "stories"}"
                val summary = if (sourceCount.isEmpty()) storyCount else "$sourceCount · $storyCount"
                Text(summary, Modifier.padding(top = 3.dp), style = Type.meta, color = t.muted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            StoryStepper(n, canRaise, MAX_PER_SECTION, onChange)
            if (openable) {
                Spacer(Modifier.width(2.dp))
                Icon(if (open) Icons.Outlined.KeyboardArrowDown else Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                    if (open) "Hide ${section.title}" else "Show ${section.title}",
                    Modifier.size(20.dp), tint = t.muted)
            }
        }
        AnimatedVisibility(open, enter = expandVertically(), exit = shrinkVertically()) {
            Column {
                Hairline()
                Column(Modifier.padding(horizontal = 4.dp)) {
                    local()
                    sources.forEachIndexed { i, src ->
                        if (i > 0 || section.key == "local") Hairline()
                        SourceRow(src, on(src), onToggle = { onToggle(src, it) })
                    }
                    if (n == 0) Hint("This topic is off. Raise the count to include its stories.",
                        Modifier.padding(bottom = 12.dp), color = t.error)
                }
            }
        }
    }
}

private fun host(url: String) = runCatching { URI(url).host?.removePrefix("www.") }.getOrNull() ?: url

@Composable
private fun SourceRow(src: Source, on: Boolean, onToggle: (Boolean) -> Unit, onRemove: ((Source) -> Unit)? = null) {
    val t = Mb.t
    Row(
        Modifier.fillMaxWidth().clickable { onToggle(!on) }.padding(vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(src.name, style = if (src.section == "follow") Type.title else Type.body, color = t.ink,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            val detail = if (src.section == "follow") "Followed · news from anywhere it's reported" else host(src.url) + when (src.kind) {
                "article" -> " · single article"
                "page" -> " · page of links"
                else -> " · feed"
            }
            Text(detail, Modifier.padding(top = 3.dp), style = Type.tiny, color = t.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (onRemove != null && !src.builtin) {
            Icon(Icons.Outlined.Close, "Remove", Modifier.padding(end = 6.dp).size(36.dp).clip(CircleShape)
                .clickable { onRemove(src) }.padding(9.dp), tint = t.muted)
        }
        CheckDot(on)
    }
}

@Composable
private fun LocalCity(vm: AppViewModel, newsCity: String, weatherCity: String) {
    var picking by remember { mutableStateOf(false) }
    ListRow(
        "City",
        value = when {
            newsCity.isNotBlank() -> newsCity.substringBefore(",")
            weatherCity.isNotBlank() -> "${weatherCity.substringBefore(",")} (weather)"
            else -> "Not set"
        },
        caret = true,
        onClick = { picking = !picking },
    )
    if (picking) {
        Column(Modifier.padding(bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            CitySearch(vm) { p ->
                vm.setNewsCity(if (p.region.isNotBlank()) "${p.name}, ${p.region}" else p.name)
                picking = false
            }
            if (newsCity.isNotBlank() && weatherCity.isNotBlank()) {
                Chip("Use the weather city (${weatherCity.substringBefore(",")})") { vm.setNewsCity(""); picking = false }
            }
        }
    }
}

/** A pill field with the round ink button beside it. */
@Composable
private fun AddField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    icon: ImageVector,
    label: String,
    working: Boolean,
    workingText: String,
    error: String?,
    keyboard: KeyboardOptions,
    modifier: Modifier = Modifier,
    onGo: () -> Unit,
) {
    Column(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            PillField(value, onChange, placeholder, Modifier.weight(1f), icon = icon, error = error != null,
                keyboardOptions = keyboard, keyboardActions = KeyboardActions(onDone = { onGo() }, onGo = { onGo() }))
            Spacer(Modifier.width(8.dp))
            InkCircle(Icons.Outlined.Add, label, enabled = value.isNotBlank(), busy = working, onClick = onGo)
        }
        error?.let { Hint(it, Modifier.padding(top = 8.dp, start = 18.dp), color = Mb.t.error) }
        if (working) Hint(workingText, Modifier.padding(top = 8.dp, start = 18.dp))
    }
}

/**
 * The user's own picks in one place: type a name (a player, team, company, topic) to follow it through the news,
 * or paste a link to read that site. Both share one story count.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Picks(
    vm: AppViewModel,
    n: Int,
    canRaise: Boolean,
    picks: List<Source>,
    on: (Source) -> Boolean,
    onRemove: (Source) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val shared by vm.sharedUrl.collectAsState()
    var input by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(shared) { shared?.let { input = it } }
    val link = looksLikeLink(input)
    fun go() {
        if (input.isBlank() || working) return
        working = true
        scope.launch {
            error = if (link) vm.addSource(input, "custom") else vm.follow(input)
            if (error == null) input = ""
            working = false
        }
    }
    SectionLabel(SECTIONS.getValue("custom").title,
        detail = "Follow a person, team or topic by name, or paste any news link. You can also share a link to this app.") {
        StoryStepper(n, canRaise, MAX_PER_SECTION) { vm.setPicks(it) }
    }
    AddField(input, { input = it; error = null }, "A name, team, topic or link", if (link) Icons.Outlined.Link else Icons.Outlined.Search,
        if (link) "Add link" else "Follow", working, if (link) "Checking the link…" else "Looking for news about ${input.trim()}…",
        error, KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done)) { go() }
    if (picks.isEmpty()) {
        FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (ex in FOLLOW_EXAMPLES + LINK_EXAMPLE) Chip(ex) { input = ex; error = null }
        }
        return
    }
    GlassGroup(Modifier.padding(top = 12.dp)) {
        picks.forEachIndexed { i, src ->
            if (i > 0) Hairline()
            SourceRow(src, on(src), onToggle = { vm.setEnabled(src, it) }, onRemove = onRemove)
        }
    }
    if (n == 0) Hint("Your picks are set to Off, so these won't be in your brief.", Modifier.padding(top = 8.dp, start = 4.dp),
        color = Mb.t.error)
}
