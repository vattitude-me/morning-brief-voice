package me.vattitude.morningbrief.data

import me.vattitude.morningbrief.pipeline.PACK_VOICES
import me.vattitude.morningbrief.pipeline.SECTIONS
import me.vattitude.morningbrief.pipeline.packVoice
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsTest {
    @Test
    fun allFourNarratorVoicesAreAvailable() {
        assertEquals(4, PACK_VOICES.size)
        val ids = PACK_VOICES.map { it.id }
        assertTrue(ids.containsAll(listOf("her_reference", "him_reference", "jerry_reference", "c3po_reference")))

        assertEquals("Alice", packVoice("her_reference").name)
        assertEquals("Mike", packVoice("him_reference").name)
        assertEquals("Jerry", packVoice("jerry_reference").name)
        assertEquals("C-3PO", packVoice("c3po_reference").name)
    }

    @Test
    fun effectiveSectionOrderPreservesOrderAndAppendsMissing() {
        val custom = listOf("sports", "tech")
        val ordered = effectiveSectionOrder(custom)
        assertEquals(SECTIONS.size, ordered.size)
        assertEquals("sports", ordered[0])
        assertEquals("tech", ordered[1])
        assertTrue(ordered.containsAll(SECTIONS.keys))
    }

    @Test
    fun sharedJsonSyncsVoiceAndSectionOrderAndSettings() {
        val s = Settings(
            voice = "c3po_reference",
            sectionOrder = listOf("science", "sports", "top"),
            speed = 1.15f,
            daily = true,
            colorPhotos = true,
        )
        val json = s.sharedJson()
        assertEquals("c3po_reference", json.getString("voice"))
        val arr = json.getJSONArray("section_order")
        assertEquals(3, arr.length())
        assertEquals("science", arr.getString(0))
        assertEquals("sports", arr.getString(1))
        assertEquals("top", arr.getString(2))
        assertEquals(1.15, json.getDouble("speed"), 0.01)
        assertTrue(json.getBoolean("color_photos"))
    }

    @Test
    fun withSharedReadsRemoteVoiceAndSectionOrder() {
        val remote = JSONObject()
            .put("voice", "jerry_reference")
            .put("section_order", JSONArray(listOf("ai", "tech", "sports")))
            .put("speed", 1.2)
            .put("color_photos", false)

        val s = Settings().withShared(remote)
        assertEquals("jerry_reference", s.voice)
        assertEquals(listOf("ai", "tech", "sports"), s.sectionOrder)
        assertEquals(listOf("ai", "tech", "sports", "top", "politics", "entertainment", "science"), s.orderedSections)
        assertEquals(1.2f, s.speed, 0.01f)
        assertEquals(false, s.colorPhotos)
    }
}
