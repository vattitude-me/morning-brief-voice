package me.vattitude.morningbrief.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.json.JSONArray
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class WriterTest {
    private fun stories(n: Int) = (0 until n).map { i ->
        val item = Item("Story number $i about something new", "https://circuit.example/$i", 1, "Circuit", "tech",
            summary = "Something happened in story $i. It mattered to many people.")
        Story(item)
    }

    private val when_ = ZonedDateTime.of(2026, 9, 30, 7, 0, 0, 0, ZoneId.of("America/Toronto"))

    @Test fun templateConnectorIsStable() {
        val story = stories(3)[2]
        assertEquals(templateCopy(story).spoken, templateCopy(story).spoken)
    }

    @Test fun spokenCopyIsCleanUnlessTheListenerWantsSources() {
        val list = stories(2)
        val copies = list.associate { it.id to templateCopy(it) }
        val clean = compose(mapOf("tech" to list), copies, when_, null, null, false)
        val credited = compose(mapOf("tech" to list), copies, when_, null, null, true)
        assertTrue(clean.stories.values.none { "Circuit" in it.spoken })
        assertTrue(credited.stories.values.all { it.spoken.endsWith(".") && "Circuit" in it.spoken })
        assertFalse("Circuit" in copies.getValue(list[0].id).spoken)
    }

    @Test fun introAndSectionLeads() {
        val list = stories(3)
        val copies = list.associate { it.id to templateCopy(it) }
        val script = compose(linkedMapOf("top" to list.take(1), "tech" to list.subList(1, 2), "sports" to list.drop(2)),
            copies, when_, null, "Ana", false)
        assertEquals("Good morning, Ana! It's Wednesday, September 30. Here's your briefing.", script.intro)
        assertEquals(mapOf(
            "top" to "First, the top stories.",
            "tech" to "Next, the latest in tech.",
            "sports" to "And finally, sports.",
        ), script.sectionLeads)
        assertEquals(mapOf("tech" to "The latest in tech."), sectionLeads(listOf("tech")))
    }

    @Test fun spokenCopyComesBackAsBeatsOnePerLine() {
        val beats = JSONArray(listOf("The plant will close in March.", "  About 400 people  work there. ", ""))
        assertEquals("The plant will close in March.\nAbout 400 people work there.", spokenBeats(beats))
        assertEquals("One line.", spokenBeats("One line."))
        assertEquals("", spokenBeats(null))
        assertTrue(stories(3).all { "\n" in templateCopy(it).spoken })
    }
}
