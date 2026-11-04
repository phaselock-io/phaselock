// The pieces every window is built from.

package io.phaselock.examples.library.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.phaselock.client.ConnectionStatus

/** a patron's marker: the first letter of their name, in their color */
@Composable
fun PatronAvatar(name: String, color: String, size: Int = 24) {
    Box(
        Modifier.size(size.dp).background(colorOf(color), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            name.take(1).uppercase(),
            color = Palette.onAccent,
            fontWeight = FontWeight.SemiBold,
            fontSize = (size * 0.55).sp,
        )
    }
}

/** a section's heading: small, muted capitals */
@Composable
fun SectionTitle(title: String, action: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title.uppercase(), color = Palette.muted, fontSize = 12.sp, letterSpacing = 1.sp, modifier = Modifier.weight(1f))
        action()
    }
}

// the color of each state of a connection
private fun stateColor(state: ConnectionStatus.State?): Color = when (state) {
    ConnectionStatus.State.LIVE -> Palette.accent
    ConnectionStatus.State.SYNCING -> Palette.amber
    ConnectionStatus.State.OFFLINE -> Palette.alarm
    ConnectionStatus.State.CONNECTING, null -> Palette.muted
}

/** the state of a window's connection, and the switch that takes it offline */
@Composable
fun ConnectionSwitch(state: ConnectionStatus.State?, online: Boolean, onOnline: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(8.dp).background(stateColor(state), CircleShape))
        Text((state ?: ConnectionStatus.State.CONNECTING).name.lowercase(), color = Palette.muted, fontSize = 13.sp)
        Switch(checked = online, onCheckedChange = onOnline)
    }
}

/** a notice the window's user dismisses */
@Composable
fun NoticeCard(text: String, onDismiss: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Palette.amber.copy(alpha = 0.12f)),
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, color = Palette.amber, modifier = Modifier.weight(1f))
            TextButton(onClick = onDismiss) { Text("Dismiss") }
        }
    }
}

/** a dialog asking for a name: one that changed and is not blank goes to onSave */
@Composable
fun NameDialog(title: String, value: String, onSave: (String) -> Unit, onClose: () -> Unit) {
    var draft by remember { mutableStateOf(value) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(title) },
        text = { OutlinedTextField(draft, { draft = it }, singleLine = true) },
        confirmButton = {
            TextButton(onClick = {
                val name = draft.trim()
                if (name.isNotEmpty() && name != value) onSave(name)
                onClose()
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } },
    )
}

/** a row's gap before what follows it at the right */
@Composable
fun Gap() = Spacer(Modifier.width(8.dp))

/** what a muted line of small text says */
@Composable
fun Muted(text: String) = Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
