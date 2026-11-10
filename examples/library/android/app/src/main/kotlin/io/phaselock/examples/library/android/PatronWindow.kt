// A patron's window: their profile, their notices, and the catalog, which shows what they have out
// and where they place and cancel holds.  A hold the database has not decided yet shows a spinner.

package io.phaselock.examples.library.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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

/** what the patron's checkout or hold of a title, or the copies they may hold, come to, in a few
    words; restricted copies count only for a researcher, who alone may hold them */
@Composable
private fun availability(book: UserBookInfo, researcher: Boolean): String {
    val hold = book.hold
    val expires = hold?.expires
    val normal = book.availableNormal
    val restricted = if (researcher) book.availableRestricted.size else 0
    return when {
        book.checkout != null -> stringResource(R.string.book_checked_out)
        hold?.pending == true -> stringResource(R.string.book_placing_hold)
        hold != null && expires != null -> stringResource(R.string.book_held_until, DAY.format(expires))
        hold != null -> stringResource(R.string.book_held)
        normal > 0 && restricted > 0 -> stringResource(R.string.book_available_restricted, normal, restricted)
        normal > 0 -> stringResource(R.string.book_available, normal)
        restricted > 0 -> stringResource(R.string.book_restricted, restricted)
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

        // the catalog: each title, with a hold, the hold's cancel, or when the patron's copy is due
        item { SectionTitle(stringResource(R.string.section_catalog)) }
        val list = books
        if (list == null) {
            item { CircularProgressIndicator(Modifier.padding(16.dp)) }
        } else {
            itemsIndexed(list, key = { _, book -> "book:${book.isbn}" }) { i, book ->
                SectionRow(i, list.size) {
                    BookRow(
                        book = book,
                        researcher = patron?.researcher == true,
                        onHold = ::hold,
                        onCancelHold = { id -> eng.sendMutation(CancelHold(room, id, window.user)) },
                    )
                }
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

/** One title of the catalog: what of it the patron may hold or has, and one control, which keeps
    the row one height whatever it shows.  A book the patron has out shows when it is due, a hold
    shows its cancel, and otherwise the Hold button offers what is free. */
@Composable
private fun BookRow(
    book: UserBookInfo,
    researcher: Boolean,
    onHold: (HoldTarget) -> Unit,
    onCancelHold: (String) -> Unit,
) {
    val hold = book.hold
    val checkout = book.checkout
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        // each line keeps to one line, so the row keeps one height
        Column(Modifier.weight(1f)) {
            Text(book.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Muted(availability(book, researcher), maxLines = 1)
        }

        when {
            // a checkout shows when it is due, in red once it is overdue
            checkout != null -> Text(
                stringResource(R.string.book_due, DAY.format(checkout.expires)),
                color = if (checkout.overdue) Palette.alarm else Palette.muted,
                fontSize = 13.sp,
            )

            // a hold, pending or decided, may be canceled
            hold != null -> QuietButton(onClick = { onCancelHold(hold.id) }) {
                if (hold.pending == true) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Gap()
                }
                Text(stringResource(R.string.book_cancel_hold))
            }

            else -> HoldButton(
                isbn = book.isbn,
                ordinary = book.availableNormal > 0,
                restricted = if (researcher) book.availableRestricted.firstOrNull() else null,
                onHold = onHold,
            )
        }
    }
}

/** The Hold button: it holds an ordinary copy if one is free, or else the free restricted copy
    offered, and it is disabled when neither is.  When both are free, a narrow arrow joined to its
    right edge opens a menu of the two. */
@Composable
private fun HoldButton(isbn: String, ordinary: Boolean, restricted: String?, onHold: (HoldTarget) -> Unit) {
    val holdOrdinary = { onHold(HoldTarget.Edition(isbn)) }
    val holdRestricted = restricted?.let { { onHold(HoldTarget.Book(it)) } }
    val hold = if (ordinary) holdOrdinary else holdRestricted
    val choice = ordinary && holdRestricted != null
    var choosing by remember { mutableStateOf(false) }
    Row {
        QuietButton(
            onClick = { hold?.invoke() },
            enabled = hold != null,
            shape = if (choice) RoundedCornerShape(topStart = 4.dp, bottomStart = 4.dp) else RoundedCornerShape(4.dp),
        ) {
            Text(stringResource(R.string.book_hold))
        }

        // if both kinds of copy are free, the arrow offers the choice
        if (choice) {
            Box {
                QuietButton(
                    onClick = { choosing = true },
                    modifier = Modifier.offset(x = (-1).dp).width(28.dp),
                    shape = RoundedCornerShape(topEnd = 4.dp, bottomEnd = 4.dp),
                    contentPadding = PaddingValues(0.dp),
                ) {
                    Icon(Icons.Default.ArrowDropDown, contentDescription = stringResource(R.string.book_hold_choose))
                }
                DropdownMenu(expanded = choosing, onDismissRequest = { choosing = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.book_hold_ordinary)) }, onClick = {
                        choosing = false
                        holdOrdinary()
                    })
                    DropdownMenuItem(text = { Text(stringResource(R.string.book_hold_restricted)) }, onClick = {
                        choosing = false
                        holdRestricted?.invoke()
                    })
                }
            }
        }
    }
}
