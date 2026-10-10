package me.vattitude.morningbrief.work

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex

/** What the build is doing right now, for the Today screen. Builds run in the app's process, so a flow is enough. */
object BuildState {
    data class Progress(val running: Boolean = false, val step: String = "", val fraction: Float = 0f, val error: String? = null)

    private val _progress = MutableStateFlow(Progress())
    val progress: StateFlow<Progress> = _progress

    /** One build at a time, whether scheduled or started by hand. */
    val lock = Mutex()

    fun update(p: Progress) {
        _progress.value = p
    }

    fun clearError() {
        if (_progress.value.error != null) {
            _progress.value = _progress.value.copy(error = null)
        }
    }
}
