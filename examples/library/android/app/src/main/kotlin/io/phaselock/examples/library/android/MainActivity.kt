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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.phaselock.examples.library.AdminQueries
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** how long a room lives from its creation, before the reaper erases it (rooms.ts) */
private val ROOM_LIFETIME: Duration = Duration.ofHours(1)

class MainActivity : ComponentActivity() {
    private val room: Room by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            LibraryTheme {
                Scaffold(containerColor = MaterialTheme.colorScheme.background) { padding ->
                    Box(Modifier.padding(padding)) { App(room) }
                }
            }
        }
    }
}

@Composable
private fun App(room: Room) {
    val state by room.state.collectAsStateWithLifecycle()
    when (val s = state) {
        Room.State.Choosing -> Choose(room, null)
        Room.State.Opening -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        is Room.State.Failed -> Choose(room, s.reason)
        is Room.State.Open -> Windows(room, s.windows)
    }
}

/** Which database and which room: a room's id joins it, as the web demo's invite does, and no id
    opens a new one. */
@Composable
private fun Choose(room: Room, error: String?) {
    var server by rememberSaveable { mutableStateOf(room.lastServer) }
    var id by rememberSaveable { mutableStateOf(room.lastRoom) }
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Text("PhaseLock Library Demo", fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        Muted(
            "A room is a private copy of the library for an hour.  Paste a room's id from the " +
                "web demo to join it, or leave it blank for a room of your own.",
        )
        OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(), label = { Text("Database") }, singleLine = true)
        OutlinedTextField(id, { id = it }, Modifier.fillMaxWidth(), label = { Text("Room") }, singleLine = true)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { room.open(server, id) }) { Text(if (id.isBlank()) "New room" else "Open room") }
            if (id.isNotBlank()) TextButton(onClick = { id = "" }) { Text("Clear") }
        }
        if (error != null) Text(error, color = Palette.alarm)
    }
}

@Composable
private fun Windows(room: Room, windows: Windows) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        RoomBanner(room, windows)
        PrimaryTabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.background) {
            Tab(tab == 0, { tab = 0 }, text = { Text("Front Desk") })
            Tab(tab == 1, { tab = 1 }, text = { Text("Alice") })
            Tab(tab == 2, { tab = 2 }, text = { Text("Bob") })
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
private fun RoomBanner(room: Room, windows: Windows) {
    val queries = remember(windows) { AdminQueries(windows.desk.engine) }
    val created by remember(windows) { queries.roomCreated() }.collectAsStateWithLifecycle(null)
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()

    // the countdown ticks on its own, since nothing in the room changes as the minutes pass
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = Instant.now()
        }
    }

    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Room ${windows.room.substringBefore('-')}", fontWeight = FontWeight.SemiBold)
            val c = created
            val left = c?.let { Duration.between(now, it.plus(ROOM_LIFETIME)).toMinutes().coerceAtLeast(0) }
            Muted(if (left == null) "syncing…" else "resets in $left min")
        }
        TextButton(onClick = {
            scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("room", windows.room))) }
        }) { Text("Copy id") }
        TextButton(onClick = { room.leave() }) { Text("Leave") }
    }
}
