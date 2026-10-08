package me.vattitude.morningbrief.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SourcesTest {
    @Test fun theSectionsAreTheSevenPackSections() {
        assertEquals(
            listOf("top", "ai", "tech", "politics", "entertainment", "science", "sports"),
            SECTIONS.keys.toList(),
        )
        assertTrue(SECTIONS.values.all { it.isCategory })
    }

    @Test fun localNewsUsesCityOutletsAndGoogleForAnywhere() {
        val toronto = localSources("Mississauga, Ontario")
        assertTrue(toronto.size > 1)
        assertTrue(toronto.all { it.section == "local" && it.builtin })
        assertTrue(toronto.last().url.contains("/geo/Mississauga?"))
        val elsewhere = localSources("Red Deer")
        assertEquals(1, elsewhere.size)
        assertTrue(elsewhere[0].url.contains("/geo/Red%20Deer?"))
        assertTrue(localSources(" ").isEmpty())
    }

    @Test fun followIsANewsSearch() {
        val url = followUrl("Connor McDavid")
        assertTrue(url.startsWith("https://news.google.com/rss/search?q=Connor+McDavid"))
        assertTrue(isFollowUrl(url))
        assertTrue(!isFollowUrl("https://www.cbc.ca/sports"))
    }

    @Test fun sectionLeadsNameTheTopic() {
        assertTrue(sectionLeads(listOf("top"), "Toronto").getValue("top").contains("top stories"))
        assertTrue(sectionLeads(listOf("top", "sports"), "Toronto").getValue("sports").contains("sports"))
    }

    @Test fun googleNewsCreditsTheOutlet() {
        val rss = """<rss><channel><title>Google News</title><item>
            <title>McDavid scores twice in win - Sportsnet</title>
            <link>https://news.google.com/rss/articles/CBMiabc?oc=5</link>
            <description>&lt;a href="x"&gt;McDavid scores twice in win&lt;/a&gt;</description>
            <source url="https://www.sportsnet.ca">Sportsnet</source>
            </item></channel></rss>"""
        val (_, items) = parseFeed(rss, Source(1, "Connor McDavid", followUrl("Connor McDavid"), "follow"))
        assertEquals("McDavid scores twice in win", items[0].title)
        assertEquals("Sportsnet", items[0].sourceName)
        assertEquals("", items[0].summary)
    }

    @Test fun freshInstallStartsWithEverySectionOn() {
        assertTrue(DEFAULT_STORIES.values.all { it == DEFAULT_PER_SECTION })
        assertTrue(DEFAULT_STORIES.keys.containsAll(SECTIONS.keys))
        assertEquals(SECTIONS.size * DEFAULT_PER_SECTION, DEFAULT_STORIES.values.sum())
    }

    @Test fun quickMixStaysWithinTheLimits() {
        val fitted = fitBudget(QUICK_MIX)
        for ((k, v) in QUICK_MIX) assertEquals(v, fitted[k])
        assertEquals(0, picksCount(fitted))
    }

    @Test fun aSectionIsCappedAtTheMaximum() {
        val fitted = fitBudget(SECTIONS.keys.associateWith { 9 })
        assertTrue(fitted.filterKeys { it in SECTIONS }.values.all { it <= MAX_PER_SECTION })
    }

    @Test fun countsFromTheOldSectionsAreIgnored() {
        // Sections that no longer exist (canada, world...) contribute nothing now.
        val fitted = fitBudget(mapOf("canada" to 6, "world" to 3, "follow" to 3, "custom" to 4))
        assertEquals(0, fitted.filterKeys { it in SECTIONS }.values.sum())
        assertTrue(fitted.filterKeys { it !in PICKS }.values.all { it <= MAX_PER_SECTION })
        assertEquals(mapOf("follow" to 1, "custom" to 2), withPicks(emptyMap(), 3))
    }

    @Test fun briefMinutesFollowsTheStoryCount() {
        assertEquals(13, briefMinutes(35))
        assertEquals(2, briefMinutes(4))
    }
}
