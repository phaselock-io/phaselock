// The app: choosing a room, then the room's three windows, one tab each, as the web demo shows
// them side by side.  Every window is signed in as its own user; the desk is a librarian's.

package io.phaselock.examples.library.android

import android.content.ClipData
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import io.phaselock.examples.library.AdminQueries
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch

/** how long a room lives from its creation, before the reaper erases it (rooms.ts) */
private val ROOM_LIFETIME: Duration = Duration.ofHours(1)

// the time, every half minute
private val clock = flow {
    while (true) {
        emit(Instant.now())
        delay(30_000)
    }
}

class MainActivity : ComponentActivity() {
    private val room: RoomViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // a fresh launch with the extra `room` opens that room at once, on the last server
        val launchRoom = intent.getStringExtra("room")
        if (savedInstanceState == null && launchRoom != null) {
            lifecycleScope.launch { room.open(room.last.filterNotNull().first().server, launchRoom) }
        }

        setContent {
            LibraryTheme {
                Scaffold(containerColor = MaterialTheme.colorScheme.background) { padding ->
                    Box(Modifier.padding(padding).consumeWindowInsets(padding)) { App(room) }
                }
            }
        }
    }
}

@Composable
private fun App(room: RoomViewModel) {
    val state by room.state.collectAsStateWithLifecycle()
    when (val s = state) {
        RoomViewModel.State.Choosing -> Choose(room, null)
        RoomViewModel.State.Opening -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        is RoomViewModel.State.Failed -> Choose(room, s.reason)
        is RoomViewModel.State.Open -> Windows(room, s.windows)
    }
}

/** Which database and which room: a room's id joins it, as the web demo's invite does, and no id
    opens a new one.  The fields start from the server and room the app was last in, once those
    have loaded. */
@Composable
private fun Choose(room: RoomViewModel, error: String?) {
    val last = room.last.collectAsStateWithLifecycle().value ?: return
    var server by rememberSaveable { mutableStateOf(last.server) }
    var id by rememberSaveable { mutableStateOf(last.room) }
    Column(
        Modifier.fillMaxSize().imePadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Text(stringResource(R.string.choose_title), fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        Muted(stringResource(R.string.choose_about))
        OutlinedTextField(
            server, { server = it }, Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.choose_database)) }, singleLine = true,
        )
        OutlinedTextField(
            id, { id = it }, Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.choose_room)) }, singleLine = true,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { room.open(server, id) }) {
                Text(stringResource(if (id.isBlank()) R.string.choose_new else R.string.choose_open))
            }
            if (id.isNotBlank()) TextButton(onClick = { id = "" }) { Text(stringResource(R.string.choose_clear)) }
        }
        if (error != null) Text(error, color = Palette.alarm)
    }
}

@Composable
private fun Windows(room: RoomViewModel, windows: Windows) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        RoomBanner(room, windows)
        PrimaryTabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.background) {
            Tab(tab == 0, { tab = 0 }, text = { Text(stringResource(R.string.tab_desk)) })
            Tab(tab == 1, { tab = 1 }, text = { Text(stringResource(R.string.tab_alice)) })
            Tab(tab == 2, { tab = 2 }, text = { Text(stringResource(R.string.tab_bob)) })
        }
        when (tab) {
            0 -> DeskWindow(windows.room, windows.desk)
            1 -> PatronWindow(windows.room, windows.alice)
            else -> PatronWindow(windows.room, windows.bob)
        }
    }
}

/** the room's id, which a web window joins it by, and how long until the room resets */
@Composable
private fun RoomBanner(room: RoomViewModel, windows: Windows) {
    val queries = remember(windows) { AdminQueries(windows.desk.engine) }
    val created by remember(windows) { queries.roomCreated() }.collectAsStateWithLifecycle(null)
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val clipLabel = stringResource(R.string.banner_clip_label)

    // the countdown ticks on its own, since nothing in the room changes as the minutes pass, and
    // only while the app is on screen
    val now by clock.collectAsStateWithLifecycle(Instant.now())

    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.banner_room, windows.room.substringBefore('-')), fontWeight = FontWeight.SemiBold)
            val c = created
            val left = c?.let { Duration.between(now, it.plus(ROOM_LIFETIME)).toMinutes().coerceAtLeast(0) }
            Muted(if (left == null) stringResource(R.string.banner_syncing) else stringResource(R.string.banner_resets, left))
        }
        TextButton(onClick = {
            scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(clipLabel, windows.room))) }
        }) { Text(stringResource(R.string.banner_copy)) }
        TextButton(onClick = { room.leave() }) { Text(stringResource(R.string.banner_leave)) }
    }
}
