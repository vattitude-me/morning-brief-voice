package me.vattitude.morningbrief.ui

import android.Manifest
import android.app.TimePickerDialog
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import me.vattitude.morningbrief.BuildConfig
import me.vattitude.morningbrief.R
import me.vattitude.morningbrief.pipeline.AI_PROVIDERS
import me.vattitude.morningbrief.pipeline.KOKORO_VOICES
import me.vattitude.morningbrief.pipeline.KokoroPack
import me.vattitude.morningbrief.pipeline.PHONE_VOICE
import me.vattitude.morningbrief.pipeline.Place
import me.vattitude.morningbrief.pipeline.kokoroVoice
import me.vattitude.morningbrief.work.Scheduler

private val TIME = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)

@Composable
private fun SwitchRow(label: String, checked: Boolean, detail: String? = null, onChange: (Boolean) -> Unit) =
    ListRow(label, detail = detail, onClick = { onChange(!checked) }) {
        Spacer(Modifier.width(12.dp))
        MbSwitch(checked, onChange)
    }

/** A one-line warning with its fix, e.g. notifications switched off. */
@Composable
private fun Nudge(text: String, action: String, onClick: () -> Unit) {
    val t = Mb.t
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.WarningAmber, null, tint = t.error, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Text(text, Modifier.weight(1f), style = Type.meta, color = t.ink)
        TextButton(onClick = onClick) { Text(action, style = Type.value.copy(fontWeight = FontWeight.Medium), color = t.ink) }
    }
}

@Composable
fun SettingsScreen(vm: AppViewModel, modifier: Modifier = Modifier) {
    val st by vm.settings.collectAsState()
    val saved by vm.saved.collectAsState()
    val appearance by vm.appearance.collectAsState()
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val t = Mb.t

    // Permissions can change in the system screens we send people to, so re-check on resume.
    var resumed by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            resumed++
            vm.loadVoices()
        }
    }
    val canNotify = remember(resumed) {
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { resumed++ }

    Box(modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = LocalBottomInset.current + 16.dp),
        ) {
            val ready = LocalTime.of(saved.readyHour, saved.readyMinute)
            ScreenHeader(
                overline = {
                    Overline(if (!saved.daily) "Daily brief off" else {
                        val now = LocalDateTime.now()
                        var next = now.toLocalDate().atTime(ready)
                        if (!next.isAfter(now)) next = next.plusDays(1)
                        "Next brief · ${next.format(DateTimeFormatter.ofPattern("EEE h:mm a", Locale.ENGLISH))}"
                    })
                },
                title = "Settings",
            )

            SectionLabel("Brief")
            GlassGroup {
                SwitchRow("Make one every morning", st.daily,
                    detail = if (st.daily) "Starts about ${Scheduler.LEAD_MINUTES} minutes earlier, whenever the phone is online" else null,
                ) { on -> vm.update { it.copy(daily = on) } }
                Hairline()
                ListRow("Ready by", value = LocalTime.of(st.readyHour, st.readyMinute).format(TIME), caret = st.daily,
                    color = if (st.daily) t.ink else t.muted,
                    onClick = if (!st.daily) null else {
                        {
                            TimePickerDialog(context, { _, h, m -> vm.update { it.copy(readyBy = "%02d:%02d".format(h, m)) } },
                                st.readyHour, st.readyMinute, false).show()
                        }
                    })
                if (!canNotify) Hairline()
                if (!canNotify) Nudge("Notifications are off", "Allow") {
                    askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
                Hairline()
                SwitchRow("Say where each story is from", st.saySources) { on -> vm.update { it.copy(saySources = on) } }
                Hairline()
                ListRow("Topics and story counts", caret = true, onClick = { vm.tab.value = Tab.Sources })
            }

            SectionLabel("Voice")
            VoiceGroup(vm)

            SectionLabel("Greeting and weather")
            GlassGroup {
                Row(Modifier.fillMaxWidth().padding(vertical = 15.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Your name", style = Type.body, color = t.ink)
                    Spacer(Modifier.width(16.dp))
                    BasicTextField(
                        st.name, { v -> vm.update { it.copy(name = v.take(40)) } }, Modifier.weight(1f), singleLine = true,
                        textStyle = Type.value.copy(color = t.ink, textAlign = TextAlign.End), cursorBrush = SolidColor(t.ink),
                        decorationBox = { inner ->
                            Box(contentAlignment = Alignment.CenterEnd) {
                                if (st.name.isEmpty()) Text("For the greeting", style = Type.value, color = t.muted)
                                inner()
                            }
                        },
                    )
                }
                Hairline()
                SwitchRow("Start with the weather", st.weather) { on -> vm.update { it.copy(weather = on) } }
                if (st.weather) {
                    var picking by remember { mutableStateOf(false) }
                    Hairline()
                    ListRow("Weather city", value = st.city.ifBlank { "Not set" }, caret = true, onClick = { picking = !picking })
                    if (picking) Column(Modifier.padding(bottom = 14.dp)) {
                        CitySearch(vm) { p ->
                            vm.update { it.copy(city = p.name, latitude = p.latitude, longitude = p.longitude) }
                            picking = false
                        }
                    }
                }
            }

            SectionLabel("Appearance")
            val looks = listOf("light", "dark", "system")
            Segmented(listOf("Light", "Dark", "System"), looks.indexOf(appearance).coerceAtLeast(0), height = 40.dp, glass = true) {
                vm.setAppearance(looks[it])
            }
            GlassGroup(Modifier.padding(top = 12.dp)) {
                SwitchRow("Color story photos", st.colorPhotos,
                    detail = "Thumbnails in full color; the large cover stays black and white") { on ->
                    vm.update { it.copy(colorPhotos = on) }
                }
            }

            SectionLabel("Account")
            AccountGroup(vm)

            SectionLabel("Advanced")
            GlassGroup {
                var open by remember { mutableStateOf(false) }
                ListRow("AI-written summaries",
                    detail = if (st.summaryKey.isBlank()) "Off: summaries are made on the phone" else "On, with ${st.provider.name}",
                    caret = !open, onClick = { open = !open })
                if (open) SummaryPicker(vm, Modifier.padding(bottom = 14.dp))
            }

            Row(Modifier.padding(top = 22.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Hint("Morning Brief ${BuildConfig.VERSION_NAME}", Modifier.weight(1f))
                TextButton(onClick = { openPage(context, PRIVACY_URL) }) { Text("Privacy", style = Type.meta, color = t.ink) }
                TextButton(onClick = { openPage(context, TERMS_URL) }) { Text("Terms", style = Type.meta, color = t.ink) }
            }
        }
    }
}

@Composable
private fun VoiceGroup(vm: AppViewModel) {
    val st by vm.settings.collectAsState()
    val pack by vm.packInstalled.collectAsState()
    val natural = kokoroVoice(st.voice) != null || (st.voice == null && pack != null)
    var open by remember { mutableStateOf(false) }

    GlassGroup {
        val current = kokoroVoice(st.voice) ?: KOKORO_VOICES.first()
        ListRow("Voice",
            value = when {
                !natural -> "Phone"
                pack == null -> "Natural, not downloaded"
                else -> "${current.name} · ${current.accent}"
            },
            caret = !open, onClick = { open = !open })

        if (open) VoicePicker(vm, Modifier.padding(bottom = 14.dp))

        Hairline()
        ListRow("Playback speed") {
            val speed = (st.speed * 20).roundToInt()
            PillStepper("${"%.2f".format(speed / 20f)}×", speed > 16, speed < 26, "Slower", "Faster",
                { vm.update { it.copy(speed = (speed - 1) / 20f) } }, { vm.update { it.copy(speed = (speed + 1) / 20f) } })
        }
    }
}

/** Phone or natural voices: download, choose and hear them. In Settings and in the first-run setup. */
@Composable
internal fun VoicePicker(vm: AppViewModel, modifier: Modifier = Modifier) = Column(modifier) {
    val st by vm.settings.collectAsState()
    val pack by vm.packInstalled.collectAsState()
    val download by vm.packDownload.collectAsState()
    val previewing by vm.previewing.collectAsState()
    val natural = kokoroVoice(st.voice) != null || (st.voice == null && pack != null)
    var lastKokoro by remember { mutableStateOf(kokoroVoice(st.voice)?.id ?: KOKORO_VOICES.first().id) }
    var confirmRemove by remember { mutableStateOf(false) }
    val t = Mb.t
    val current = kokoroVoice(st.voice) ?: KOKORO_VOICES.first()
    Segmented(listOf("Phone", "Natural"), if (natural) 1 else 0) {
        vm.update { s -> s.copy(voice = if (it == 0) PHONE_VOICE else lastKokoro) }
    }
    if (!natural) {
        Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                OfflineTag()
                Hint("Your phone's built-in voice. Always offline, no download — but flatter than the natural voices.",
                    Modifier.padding(top = 6.dp))
            }
            Spacer(Modifier.width(12.dp))
            InkCircle(Icons.Filled.PlayArrow, "Play a sample", size = 40.dp, busy = previewing == PHONE_VOICE) {
                vm.previewVoice(PHONE_VOICE)
            }
        }
    } else {
        val installed = pack
        if (installed == null) {
            Column(Modifier.padding(top = 14.dp)) {
                OfflineTag()
                Hint("Better voices are part of the app: a one-time ${KokoroPack.HD.megabytes} MB " +
                    "download (Wi-Fi recommended), then they work offline — even in airplane mode.",
                    Modifier.padding(top = 6.dp))
            }
        } else {
            Column(Modifier.padding(top = 6.dp)) {
                for (v in KOKORO_VOICES) {
                    val on = v.id == current.id
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            lastKokoro = v.id
                            vm.update { it.copy(voice = v.id) }
                            vm.previewVoice(v.id)
                        }.padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CheckDot(on)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text("${v.name} · ${v.accent}", style = if (on) Type.title else Type.body, color = t.ink)
                            Text(v.description, style = Type.meta, color = t.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (previewing == v.id) {
                            CircularProgressIndicator(Modifier.size(18.dp), color = t.ink, strokeWidth = 2.dp)
                        }
                    }
                }
            }
        }

        Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            when {
                download.running -> {
                    Text("Downloading natural voices… ${(download.fraction * 100).toInt()}%", style = Type.body, color = t.ink)
                    LinearProgressIndicator(
                        progress = { download.fraction }, modifier = Modifier.fillMaxWidth().height(6.dp),
                        color = t.ink, trackColor = t.track, strokeCap = StrokeCap.Round, gapSize = 0.dp, drawStopIndicator = {},
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Hint("You can leave this screen; it keeps going.", Modifier.weight(1f))
                        PillButton("Cancel", filled = false) { vm.cancelDownload() }
                    }
                }
                installed == null -> {
                    download.error?.let { Hint(it, color = t.error) }
                    PillButton("Download natural voices") { vm.downloadVoices(KokoroPack.HD) }
                }
                confirmRemove -> {
                    Hint("Remove the voices? Briefings will use the phone's voice.")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PillButton("Keep", filled = false) { confirmRemove = false }
                        PillButton("Remove") { confirmRemove = false; vm.removeVoices() }
                    }
                }
                else -> {
                    download.error?.let { Hint(it, color = t.error) }
                    val mb = remember(installed) { vm.packSize() / 1_000_000 }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f)) {
                            OfflineTag()
                            Hint(if (installed == KokoroPack.STANDARD) "You have the older, smaller voices. The full-quality " +
                                "ones sound noticeably cleaner (${KokoroPack.HD.megabytes} MB)." else "Using $mb MB on this phone",
                                Modifier.padding(top = 6.dp))
                        }
                        if (installed == KokoroPack.STANDARD) PillButton("Upgrade") { vm.downloadVoices(KokoroPack.HD) }
                        PillButton("Remove", filled = false) { confirmRemove = true }
                    }
                }
            }
        }
    }
}

/** A small pill tag; tappable when onClick is given. */
@Composable
private fun Tag(label: String, onClick: (() -> Unit)? = null) {
    val t = Mb.t
    Box(
        Modifier.height(22.dp).clip(CircleShape).background(t.ink)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = Type.tiny.copy(fontWeight = FontWeight.Bold), color = t.onInk)
    }
}

/** A tappable "FREE" badge: jumps straight to where the provider hands out keys. */
@Composable
private fun FreeTag(onClick: () -> Unit) = Tag("FREE", onClick)

/** Marks a voice as on-device: part of the app, no internet needed. */
@Composable
private fun OfflineTag() = Tag("OFFLINE")

/** Who writes the summaries: a service and the user's key for it, with a link to get one and a check. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SummaryPicker(vm: AppViewModel, modifier: Modifier = Modifier) = Column(modifier) {
    val st by vm.settings.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val t = Mb.t
    val p = st.provider
    var checking by remember { mutableStateOf(false) }
    var result by remember(st.aiProvider, st.summaryKey, st.aiBaseUrl, st.aiModel) { mutableStateOf<String?>(null) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (option in AI_PROVIDERS) Row(verticalAlignment = Alignment.CenterVertically) {
            Chip(option.name, selected = option.id == p.id) {
                vm.update { it.copy(aiProvider = option.id) }
            }
            // The free key, one tap away: the tag jumps straight to where keys are made.
            if (option.freeKey && option.keyUrl.isNotEmpty()) {
                Spacer(Modifier.width(6.dp))
                FreeTag { openPage(context, option.keyUrl) }
            }
        }
    }
    Hint(p.note, Modifier.padding(top = 12.dp))
    if (p.keyUrl.isNotEmpty()) {
        TextButton(onClick = { openPage(context, p.keyUrl) }, Modifier.padding(start = 0.dp)) {
            Icon(Icons.AutoMirrored.Outlined.OpenInNew, null, Modifier.size(16.dp), tint = t.ink)
            Spacer(Modifier.width(6.dp))
            Text("Get a ${p.name} key", style = Type.value.copy(fontWeight = FontWeight.Medium), color = t.ink)
        }
    } else Spacer(Modifier.height(10.dp))
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (p.id == "custom") {
            PillField(st.aiBaseUrl, { v -> vm.update { it.copy(aiBaseUrl = v.trim()) } }, "Base URL, e.g. https://…/v1",
                Modifier.fillMaxWidth())
            PillField(st.aiModel, { v -> vm.update { it.copy(aiModel = v.trim()) } }, "Model", Modifier.fillMaxWidth())
        }
        PillField(st.summaryKey, { v ->
            vm.update { if (p.id == "groq") it.copy(groqKey = v.trim()) else it.copy(aiKeys = it.aiKeys + (p.id to v.trim())) }
        }, "${if (p.id == "custom") "API" else p.name} key", Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation())
    }
    Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        val message = result
        Hint(when {
            checking -> "Writing a test summary…"
            message == "" -> "It works. Summaries will be written by ${p.name}."
            message != null -> message
            else -> "Your key stays on this phone and is only sent to ${if (p.id == "custom") "that service" else p.name}."
        }, Modifier.weight(1f), color = if (message != null && message != "") t.error else t.muted)
        if (st.summaryKey.isNotBlank()) {
            Spacer(Modifier.width(12.dp))
            PillButton("Check", filled = false, busy = checking) {
                checking = true
                scope.launch {
                    result = vm.checkSummaries() ?: ""
                    checking = false
                }
            }
        }
    }
}

const val PRIVACY_URL = "https://mbv.vattitude.ca/privacy"
const val TERMS_URL = "https://mbv.vattitude.ca/terms"

/** Web pages open in a browser tab over the app. */
internal fun openPage(context: Context, url: String) = openPage(context, Uri.parse(url))
private fun openPage(context: Context, uri: Uri) = CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)

@Composable
private fun AccountGroup(vm: AppViewModel) {
    val email by vm.signedInEmail.collectAsState()
    val signIn by vm.signIn.collectAsState()
    val context = LocalContext.current
    val t = Mb.t
    var confirm by remember { mutableStateOf(false) }
    GlassGroup {
        val signedIn = email
        if (signedIn != null) {
            ListRow(signedIn) { Text("SYNCED", Modifier.padding(start = 12.dp), style = Type.tiny, color = t.muted) }
            Hairline()
            ListRow("Sign out", color = t.error, onClick = { vm.signOut() })
            Hairline()
            ListRow("Delete account", color = t.error, onClick = { confirm = true })
            if (confirm) DeleteAccountDialog(vm, signedIn) { confirm = false }
            return@GlassGroup
        }
        ListRow("Not signed in",
            detail = "Optional: sign in with the Google account you use on the web app to sync sources and settings")
        signIn.error?.let { Hint(it, Modifier.padding(bottom = 10.dp), color = t.error) }
        Row(
            Modifier.padding(bottom = 14.dp).height(44.dp).clip(CircleShape).background(t.ink)
                .clickable(enabled = !signIn.busy) { openPage(context, vm.googleSignInUrl()) }.padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (signIn.busy) CircularProgressIndicator(Modifier.size(16.dp), color = t.onInk, strokeWidth = 2.dp)
            else Box(Modifier.size(22.dp).clip(CircleShape).background(Color.White), contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_google), null, Modifier.size(14.dp), tint = Color.Unspecified)
            }
            Spacer(Modifier.width(10.dp))
            Text("Continue with Google", style = Type.value.copy(fontWeight = FontWeight.Medium), color = t.onInk)
        }
    }
}

/** A deliberate, two-step confirmation, worded like the web app's. */
@Composable
private fun DeleteAccountDialog(vm: AppViewModel, email: String, onDismiss: () -> Unit) {
    val state by vm.deleting.collectAsState()
    val busy = state?.busy == true
    var understood by remember { mutableStateOf(false) }
    val t = Mb.t
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        icon = { Icon(Icons.Outlined.DeleteForever, null, tint = t.error) },
        title = { Text("Delete your account?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This can't be undone. Your sign-in for $email, your own news links, saved settings and web " +
                    "briefings are removed for good, on every device.", style = Type.body)
                Hint("Briefings already on this phone stay here. You can sign up again later, but you'll start from scratch.")
                Row(Modifier.fillMaxWidth().clickable(enabled = !busy) { understood = !understood },
                    verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(understood, { understood = it }, enabled = !busy,
                        colors = CheckboxDefaults.colors(checkedColor = t.ink, checkmarkColor = t.onInk))
                    Text("I understand my account and its data will be permanently deleted.", style = Type.body)
                }
                if (busy) Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(16.dp), color = t.ink, strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Hint("Deleting your account. This can take up to a minute.")
                }
                state?.error?.let { Hint(it, color = t.error) }
            }
        },
        confirmButton = {
            Button(onClick = { vm.deleteAccount() }, enabled = understood && !busy,
                colors = ButtonDefaults.buttonColors(containerColor = t.error, contentColor = if (t.dark) Color.Black else Color.White)) {
                Text(if (busy) "Deleting…" else "Delete forever")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Keep my account", color = t.ink) } },
    )
}

@Composable
internal fun CitySearch(vm: AppViewModel, onPick: (Place) -> Unit) {
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<Place>>(emptyList()) }
    LaunchedEffect(query) {
        if (query.trim().length < 2) {
            results = emptyList()
            return@LaunchedEffect
        }
        delay(350)
        results = vm.places(query.trim())
    }
    PillField(query, { query = it }, "Search for a city", Modifier.fillMaxWidth(), icon = Icons.Outlined.Search)
    for (p in results.take(5)) {
        Text("${p.name}${if (p.region.isNotBlank()) ", ${p.region}" else ""}",
            Modifier.fillMaxWidth().clickable { onPick(p); query = ""; results = emptyList() }.padding(horizontal = 18.dp, vertical = 10.dp),
            style = Type.body, color = Mb.t.ink)
    }
}
