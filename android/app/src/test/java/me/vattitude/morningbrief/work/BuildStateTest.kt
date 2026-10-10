package me.vattitude.morningbrief.work

import me.vattitude.morningbrief.data.ADMIN_EMAILS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildStateTest {
    @Test
    fun clearErrorResetsErrorMessage() {
        BuildState.update(BuildState.Progress(running = false, error = "Something went wrong"))
        assertEquals("Something went wrong", BuildState.progress.value.error)

        BuildState.clearError()
        assertNull(BuildState.progress.value.error)
        assertFalse(BuildState.progress.value.running)
    }

    @Test
    fun adminEmailsContainsVatsakrish() {
        assertTrue(ADMIN_EMAILS.contains("vatsakrish@gmail.com"))
        assertFalse(ADMIN_EMAILS.contains("normaluser@example.com"))
    }
}
