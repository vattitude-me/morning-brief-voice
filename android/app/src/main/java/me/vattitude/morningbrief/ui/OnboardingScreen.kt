package me.vattitude.morningbrief.ui

import android.Manifest
import android.app.TimePickerDialog
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import me.vattitude.morningbrief.R
import me.vattitude.morningbrief.pipeline.MAX_PER_SECTION
import me.vattitude.morningbrief.pipeline.SECTIONS
import me.vattitude.morningbrief.pipeline.STORY_BUDGET

private enum class Step { Welcome, Topics, Ready }

/**
 * First run, kept short on purpose: hear what a briefing sounds like, pick topics,
 * then make the first brief. Voice, time, notifications and AI summaries all have
 * sensible defaults and live in Settings.
 */
@Composable
fun OnboardingScreen(vm: AppViewModel) {
    var index by rememberSaveable { mutableIntStateOf(0) }
    val step = Step.entries[index]
    val st by vm.settings.collectAsState()
    val context = LocalContext.current
    val t = Mb.t

    var canNotify by remember {
        mutableStateOf(Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
    }
    var asked by rememberSaveable { mutableStateOf(false) }
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        canNotify = granted
        asked = true
        // Asked from the last step's button: carry on to the first brief either way.
        if (step == Step.Ready) vm.finishOnboarding()
    }

    BackHandler(index > 0) { index-- }
    LaunchedEffect(step) { if (step != Step.Welcome) vm.stopDemo() }

    Column(Modifier.fillMaxSize().backdrop(t).statusBarsPadding().navigationBarsPadding().imePadding()) {
        // Progress: one dash per step.
        Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (i in Step.entries.indices) {
                Box(Modifier.weight(1f).height(3.dp).clip(CircleShape).background(if (i <= index) t.ink else t.track))
            }
        }
        AnimatedContent(step, Modifier.weight(1f), transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "step") { s ->
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 28.dp)) {
                when (s) {
                    Step.Welcome -> Welcome(vm)
                    Step.Topics -> TopicsStep(vm)
                    Step.Ready -> ReadyStep(vm)
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 24.dp, bottom = 16.dp, top = 8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (index > 0) TextButton(onClick = { index-- }) { Text("Back", style = Type.value, color = t.muted) }
            Spacer(Modifier.weight(1f))
            val totalStories = SECTIONS.keys.sumOf { st.stories[it] ?: 0 }
            val topicsEmpty = step == Step.Topics && totalStories == 0
            val label = when (step) {
                Step.Welcome -> "Get started"
                Step.Topics -> if (topicsEmpty) "Pick at least one topic" else "Continue"
                Step.Ready -> "Make my first brief"
                else -> "Continue"
            }
            PillButton(label, enabled = !topicsEmpty) {
                when {
                    // Ask for the ready alert at the moment of commitment, then carry on either way.
                    step == Step.Ready && !canNotify && !asked -> askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                    step == Step.Ready -> vm.finishOnboarding()
                    else -> index++
                }
            }
        }
    }
}

@Composable
private fun Title(overline: String, title: String, lead: String) {
    Overline(overline)
    Text(title, Modifier.padding(top = 10.dp), style = Type.display, color = Mb.t.ink)
    Text(lead, Modifier.padding(top = 10.dp, bottom = 22.dp), style = Type.lead, color = Mb.t.muted)
}

/** The app icon, from its two adaptive layers. */
@Composable
private fun AppMark(size: Int = 84) {
    Box(Modifier.size(size.dp).clip(RoundedCornerShape((size * .28f).dp)), contentAlignment = Alignment.Center) {
        // The layers are 108dp with the visible icon in the middle 72dp.
        val full = (size * 108 / 72).dp
        Image(painterResource(R.drawable.ic_launcher_background), null, Modifier.requiredSize(full))
        Image(painterResource(R.drawable.ic_launcher_foreground), null, Modifier.requiredSize(full))
    }
}

@Composable
private fun Welcome(vm: AppViewModel) {
    val demo by vm.demo.collectAsState()
    val t = Mb.t
    AppMark()
    Spacer(Modifier.height(26.dp))
    Title("Morning Brief", "Your news, read aloud every morning.",
        "Five minutes of the stories you care about, waiting when you wake. Made on your phone, " +
            "with no ads and no account.")
    Glass(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            InkCircle(if (demo != null) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                if (demo != null) "Pause the sample" else "Play a sample brief", size = 52.dp) { vm.toggleDemo() }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("Hear how it sounds", style = Type.title, color = t.ink)
                Text("The start of a real brief, read by Heart", Modifier.padding(top = 2.dp),
                    style = Type.meta, color = t.muted)
                Box(Modifier.padding(top = 10.dp).fillMaxWidth().height(3.dp).clip(CircleShape).background(t.track)) {
                    Box(Modifier.fillMaxWidth(demo ?: 0f).fillMaxHeight().background(t.ink))
                }
            }
        }
    }
    Column(Modifier.padding(top = 22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Feature(Icons.Outlined.RecordVoiceOver, "Sounds like a real host", "Natural voices that run on your phone, even offline")
        Feature(Icons.Outlined.Schedule, "Ready before your alarm", "Made overnight, with one quiet alert when it's done")
        Feature(Icons.Outlined.AutoAwesome, "Only what you follow", "Topics, local news, people, teams or any site you like")
    }
}

@Composable
private fun Feature(icon: ImageVector, title: String, detail: String) {
    val t = Mb.t
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(38.dp).clip(CircleShape).background(t.glass), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(19.dp), tint = t.ink)
        }
        Spacer(Modifier.width(14.dp))
        Column {
            Text(title, style = Type.title, color = t.ink)
            Text(detail, style = Type.meta, color = t.muted)
        }
    }
}

@Composable
private fun TopicsStep(vm: AppViewModel) {
    val st by vm.settings.collectAsState()
    val t = Mb.t
    val total = SECTIONS.keys.sumOf { st.stories[it] ?: 0 }
    val full = total >= STORY_BUDGET
    Title("Your topics", "What goes in your brief?",
        "Twelve stories, split however you like — up to $MAX_PER_SECTION from each topic. Nothing is picked for you.")
    Glass(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp)) {
            Row(verticalAlignment = Alignment.Bottom) {
                Text("$total of $STORY_BUDGET stories", Modifier.weight(1f), style = Type.title, color = t.ink)
            }
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                repeat(STORY_BUDGET) { i ->
                    Box(Modifier.weight(1f).height(6.dp).clip(CircleShape).background(if (i < total) t.ink else t.track))
                }
            }
            PillButton(if (total == 0) "Start with a balanced mix" else "Fill a balanced mix", filled = false,
                modifier = Modifier.padding(top = 14.dp), onClick = { vm.applyQuickMix() })
        }
    }
    GlassGroup(Modifier.padding(top = 12.dp)) {
        SECTIONS.values.filter { it.isCategory || it.key == "local" }.forEachIndexed { i, s ->
            if (i > 0) Hairline()
            val n = st.stories[s.key] ?: 0
            Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(32.dp).clip(CircleShape).background(t.glass), contentAlignment = Alignment.Center) {
                    Text(s.emoji, style = Type.body)
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(s.title, style = Type.body, color = t.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("Up to $MAX_PER_SECTION stories", Modifier.padding(top = 2.dp), style = Type.tiny, color = t.muted)
                }
                StoryStepper(n, canRaise = !full, max = MAX_PER_SECTION) { vm.setStories(s.key, it) }
            }
        }
    }
    if (total == 0) Hint("Pick at least one topic — or start with the balanced mix above.",
        Modifier.padding(top = 12.dp, start = 4.dp), color = t.error)
}

@Composable
private fun ReadyStep(vm: AppViewModel) {
    val st by vm.settings.collectAsState()
    val context = LocalContext.current
    val t = Mb.t
    Title("All set", "Your first brief is one tap away.",
        "Made with the phone's voice, ready every morning. Tune everything later in Settings.")
    GlassGroup {
        val time = LocalTime.of(st.readyHour, st.readyMinute)
        ListRow("Ready by",
            value = time.format(DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)),
            caret = true,
            onClick = {
                TimePickerDialog(context, { _, h, m -> vm.update { it.copy(readyBy = "%02d:%02d".format(h, m)) } },
                    st.readyHour, st.readyMinute, false).show()
            })
        Hairline()
        val total = SECTIONS.keys.sumOf { st.stories[it] ?: 0 }
        val topics = SECTIONS.values.filter { (st.stories[it.key] ?: 0) > 0 }.joinToString(", ") { it.title }
        ListRow("Topics", detail = topics.ifEmpty { "None yet" }, value = "$total stories")
        Hairline()
        Row(Modifier.fillMaxWidth().padding(vertical = 15.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Your name", style = Type.body, color = t.ink)
            Spacer(Modifier.width(16.dp))
            BasicTextField(
                st.name, { v -> vm.update { it.copy(name = v.take(40)) } }, Modifier.weight(1f), singleLine = true,
                textStyle = Type.value.copy(color = t.ink, textAlign = TextAlign.End),
                cursorBrush = SolidColor(t.ink),
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterEnd) {
                        if (st.name.isEmpty()) Text("Optional, for the greeting", style = Type.value, color = t.muted)
                        inner()
                    }
                },
            )
        }
    }
    Hint("Your first brief takes a few minutes. After that, a new one is waiting every morning.",
        Modifier.padding(top = 14.dp, start = 4.dp))
    Hint("Want a more natural voice? Download one later in Settings, under Voice.",
        Modifier.padding(top = 8.dp, start = 4.dp))
}
