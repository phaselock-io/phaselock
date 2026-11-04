// A patron's window: their profile, their notices, what they have out, and the catalog, where
// they place and cancel holds.  A hold the database has not decided yet shows a spinner.

package io.phaselock.examples.library.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.phaselock.client.generateUuid
import io.phaselock.examples.library.CancelHold
import io.phaselock.examples.library.HoldTarget
import io.phaselock.examples.library.PatronDismissNotice
import io.phaselock.examples.library.RenamePatron
import io.phaselock.examples.library.TryHold
import io.phaselock.examples.library.UserBookInfo
import io.phaselock.examples.library.UserEngine
import io.phaselock.examples.library.UserQueries
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// a date as a reader says it, such as "Oct 21"
private val DAY = DateTimeFormatter.ofPattern("MMM d").withZone(ZoneId.systemDefault())

/** what the patron's hold on a title, or the title's unrestricted copies, come to, in a few words */
@Composable
private fun availability(book: UserBookInfo): String {
    val hold = book.hold
    val expires = hold?.expires
    return when {
        hold?.pending == true -> stringResource(R.string.book_placing_hold)
        hold != null && expires != null -> stringResource(R.string.book_held_until, DAY.format(expires))
        hold != null -> stringResource(R.string.book_held)
        book.availableNormal > 0 -> stringResource(R.string.book_available, book.availableNormal)
        else -> stringResource(R.string.book_taken)
    }
}

@Composable
fun PatronWindow(room: String, window: Window<UserEngine>) {
    val eng = window.engine
    val queries = remember(eng) { UserQueries(eng) }
    val patron by remember(eng) { queries.myPatron() }.collectAsStateWithLifecycle(null)
    val books by remember(eng) { queries.allBooks() }.collectAsStateWithLifecycle(null)
    val notices by remember(eng) { queries.notices() }.collectAsStateWithLifecycle(emptyList())
    var renaming by remember { mutableStateOf(false) }

    fun hold(target: HoldTarget) =
        eng.sendMutation(TryHold(room, generateUuid(), window.user, target, false, Instant.now()))

    LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        // who the patron is, and the window's connection
        item {
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                val p = patron
                if (p == null || p.name.isEmpty()) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    PatronAvatar(p.name, p.color)
                    Gap()
                    Text(p.name, fontWeight = FontWeight.SemiBold)
                    EditButton(stringResource(R.string.patron_rename)) { renaming = true }
                    if (p.researcher) Muted(stringResource(R.string.researcher))
                }
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End) {
                    ConnectionSwitch(eng.status, window.transport, eng::reconnectNow)
                }
            }
        }

        // holds that closed or failed without the patron, each dismissed on its own
        items(notices, key = { "notice:${it.id}" }) { notice ->
            NoticeCard(notice.reason) { eng.sendMutation(PatronDismissNotice(room, notice.id, window.user)) }
        }

        // the books the patron has out, each with when it is due
        val checkouts = patron?.checkouts.orEmpty()
        if (checkouts.isNotEmpty()) {
            item { SectionTitle(stringResource(R.string.patron_checked_out)) }
            items(checkouts, key = { "checkout:${it.id}" }) { c ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Text(c.title, Modifier.weight(1f))
                    if (c.overdue) {
                        Text(stringResource(R.string.patron_overdue), color = Palette.alarm)
                    } else {
                        Muted(stringResource(R.string.patron_due, DAY.format(c.expires)))
                    }
                }
            }
        }

        // the catalog: each title, with a hold, or the hold's cancel
        item { SectionTitle(stringResource(R.string.section_catalog)) }
        val list = books
        if (list == null) {
            item { CircularProgressIndicator(Modifier.padding(16.dp)) }
        } else {
            items(list, key = { "book:${it.isbn}" }) { book ->
                BookRow(
                    book = book,
                    researcher = patron?.researcher == true,
                    onHold = ::hold,
                    onCancelHold = { id -> eng.sendMutation(CancelHold(room, id, window.user)) },
                )
                HorizontalDivider(color = Palette.border)
            }
        }
    }

    if (renaming) {
        val p = patron
        NameDialog(stringResource(R.string.patron_rename), p?.name.orEmpty(), { name ->
            eng.sendMutation(RenamePatron(room, window.user, name, Instant.now()))
        }) { renaming = false }
    }
}

/** One title of the catalog: its availability and its actions, a hold or the hold's cancel.  A
    researcher may also hold a free restricted copy. */
@Composable
private fun BookRow(
    book: UserBookInfo,
    researcher: Boolean,
    onHold: (HoldTarget) -> Unit,
    onCancelHold: (String) -> Unit,
) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(book.title)
            Muted(availability(book))
        }

        // a hold, pending or decided, may be canceled
        val hold = book.hold
        if (hold != null) {
            OutlinedButton(onClick = { onCancelHold(hold.id) }) {
                if (hold.pending == true) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Gap()
                }
                Text(stringResource(R.string.book_cancel_hold))
            }
        } else {
            Column(horizontalAlignment = Alignment.End) {
                FilledTonalButton(onClick = { onHold(HoldTarget.Edition(book.isbn)) }, enabled = book.availableNormal > 0) {
                    Text(stringResource(R.string.book_hold))
                }
                val restricted = book.availableRestricted.firstOrNull()
                if (researcher && restricted != null) {
                    OutlinedButton(onClick = { onHold(HoldTarget.Book(restricted)) }) { Text(stringResource(R.string.book_hold_restricted)) }
                }
            }
        }
    }
}
