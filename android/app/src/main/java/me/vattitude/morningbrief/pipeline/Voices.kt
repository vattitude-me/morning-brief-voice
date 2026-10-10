package me.vattitude.morningbrief.pipeline

/**
 * A voice the shared pack records every morning (app/storypack.py). A listener picks one and
 * hears that recording — the clips are shared, so this is a choice of who reads the news,
 * not a per-listener recording. Named [PackVoice] because the on-device [Narrator] and the
 * phone/Kokoro [Voice] this app grew up with are different, older things.
 */
data class PackVoice(
    val id: String,
    val name: String,
    val gender: String,
    val style: String = "",
    val description: String = "",
)

val PACK_VOICES = listOf(
    PackVoice("her_reference", "Alice", "female", "Warm Broadcast", "Warm British newsreader"),
    PackVoice("him_reference", "Mike", "male", "Crisp Morning News", "Calm American newsreader"),
    PackVoice("jerry_reference", "Jerry", "male", "Observational Wit", "Observational comedy style"),
    PackVoice("c3po_reference", "C-3PO", "male", "Polite & Precise", "Polite protocol droid"),
)

/** The voice a listener picked, falling back to the first for anything older or unknown. */
fun packVoice(id: String?): PackVoice = PACK_VOICES.firstOrNull { it.id == id } ?: PACK_VOICES.first()

/** Which voice's clips to play: the chosen one, or whichever is actually published. */
internal fun pickPackVoice(published: List<String>, chosen: String?): String? {
    val real = published.filter { it.isNotBlank() }
    if (real.isEmpty()) return null
    if (chosen != null && real.contains(chosen)) return chosen
    return real.groupingBy { it }.eachCount().maxByOrNull { it.value }?.key
}
