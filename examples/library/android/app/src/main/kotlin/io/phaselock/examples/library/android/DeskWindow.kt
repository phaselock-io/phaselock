// The front desk, a librarian's window: the shared notices, every patron, and the catalog, where
// each copy of an edition opens what can be done with it.

package io.phaselock.examples.library.android

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.phaselock.client.generateUuid
import io.phaselock.examples.library.AddBook
import io.phaselock.examples.library.AddEdition
import io.phaselock.examples.library.AdminBookInfo
import io.phaselock.examples.library.AdminBookInfoState
import io.phaselock.examples.library.AdminEngine
import io.phaselock.examples.library.AdminEngineMutation
import io.phaselock.examples.library.AdminQueries
import io.phaselock.examples.library.AssignPatron
import io.phaselock.examples.library.DismissNotice
import io.phaselock.examples.library.EndCheckout
import io.phaselock.examples.library.LibraryCancelHold
import io.phaselock.examples.library.Patron
import io.phaselock.examples.library.RenamePatron
import io.phaselock.examples.library.TryCheckout
import io.phaselock.examples.library.UpdateBookRestricted
import io.phaselock.examples.library.UpdateEditionTitle
import java.time.Instant

// what each state of a copy is called; a restricted copy that is free is available, and its
// restriction is said apart from its state
@StringRes
private fun said(state: AdminBookInfoState): Int = when (state) {
    AdminBookInfoState.OPEN, AdminBookInfoState.RESTRICTED -> R.string.copy_available
    AdminBookInfoState.HELD -> R.string.copy_on_hold
    AdminBookInfoState.OUT -> R.string.copy_checked_out
}

// a copy of an edition, as the dialog that acts on it holds it
private class Selected(val book: AdminBookInfo, val title: String)

// a name or a title being renamed
private class Renaming(val label: String, val value: String, val save: (String) -> Unit)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DeskWindow(room: String, window: Window<AdminEngine>) {
    val eng = window.engine
    val queries = remember(eng) { AdminQueries(eng) }
    val allPatrons by remember(eng) { queries.allPatrons() }.collectAsStateWithLifecycle(null)
    val editions by remember(eng) { queries.allEditions() }.collectAsStateWithLifecycle(null)
    val notices by remember(eng) { queries.notices() }.collectAsStateWithLifecycle(emptyList())
    var selected by remember { mutableStateOf<Selected?>(null) }
    var renaming by remember { mutableStateOf<Renaming?>(null) }
    val send = { m: AdminEngineMutation -> eng.sendMutation(m) }

    // the patrons by name, and by id for the copies they hold, again only when the patrons change
    val patrons = remember(allPatrons) { allPatrons?.sortedBy { it.name } }
    val byId = remember(patrons) { patrons.orEmpty().associateBy { it.id } }

    LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        item {
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.desk_title), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                ConnectionSwitch(eng.status, window.transport, eng::reconnectNow)
            }
        }

        // checkouts that failed after the desk moved on
        items(notices, key = { "notice:${it.id}" }) { notice ->
            NoticeCard(stringResource(R.string.desk_checkout_failed, notice.reason)) { send(DismissNotice(room, notice.id)) }
        }

        // each patron, renamed or made a researcher here
        item { SectionTitle(stringResource(R.string.desk_patrons)) }
        if (patrons == null) {
            item { CircularProgressIndicator(Modifier.padding(16.dp)) }
        } else {
            items(patrons, key = { "patron:${it.id}" }) { patron ->
                val rename = stringResource(R.string.desk_rename_patron)
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    PatronAvatar(patron.name, patron.color)
                    Gap()
                    Text(patron.name)
                    EditButton(rename) {
                        renaming = Renaming(rename, patron.name) { name ->
                            send(RenamePatron(room, patron.id, name, Instant.now()))
                        }
                    }
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                        Muted(stringResource(R.string.researcher))
                        Gap()
                        Switch(checked = patron.researcher, onCheckedChange = { researcher ->
                            send(AssignPatron(room, patron.id, researcher, Instant.now()))
                        })
                    }
                }
            }
        }

        // the catalog: each edition, and a chip for each of its copies
        item {
            val label = stringResource(R.string.desk_new_edition)
            SectionTitle(stringResource(R.string.section_catalog)) {
                TextButton(onClick = {
                    renaming = Renaming(label, "") { title ->
                        send(AddEdition(room, generateUuid(), title, Instant.now()))
                    }
                }) { Text(stringResource(R.string.desk_add_edition)) }
            }
        }
        val list = editions
        if (list == null) {
            item { CircularProgressIndicator(Modifier.padding(16.dp)) }
        } else {
            items(list, key = { "edition:${it.isbn}" }) { edition ->
                val rename = stringResource(R.string.desk_rename_edition)
                Column(Modifier.padding(vertical = 6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(edition.title, fontWeight = FontWeight.SemiBold)
                        EditButton(rename) {
                            renaming = Renaming(rename, edition.title) { title ->
                                send(UpdateEditionTitle(room, edition.isbn, title, Instant.now()))
                            }
                        }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (book in edition.books) {
                            CopyChip(book, book.patronId?.let(byId::get)) { selected = Selected(book, edition.title) }
                        }
                        TextButton(onClick = {
                            send(AddBook(room, generateUuid(), edition.isbn, false, Instant.now()))
                        }) { Text(stringResource(R.string.desk_add_copy)) }
                    }
                }
                HorizontalDivider(color = Palette.border)
            }
        }
    }

    selected?.let { s ->
        CopyActions(s, patrons.orEmpty(), room, send) { selected = null }
    }
    renaming?.let { r ->
        NameDialog(r.label, r.value, r.save) { renaming = null }
    }
}

/** One copy: its state, a note when it is restricted, and the avatar of the patron who holds it
    or has it out.  A copy whose hold or checkout the database has not decided shows a spinner. */
@Composable
private fun CopyChip(book: AdminBookInfo, patron: Patron?, onClick: () -> Unit) {
    AssistChip(
        onClick = onClick,
        label = {
            val state = stringResource(said(book.state))
            Text(if (book.restricted) "$state · ${stringResource(R.string.copy_restricted)}" else state)
        },
        leadingIcon = if (book.pending == true) {
            { CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp) }
        } else {
            null
        },
        trailingIcon = patron?.let { { PatronAvatar(it.name, it.color, size = 18) } },
    )
}

/** Everything that can be done with one copy, by its state: checking it out to a patron, checking
    a held copy out to its holder or releasing the hold, checking it back in, and restricting it. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CopyActions(
    selected: Selected,
    patrons: List<Patron>,
    room: String,
    send: (AdminEngineMutation) -> Unit,
    onClose: () -> Unit,
) {
    val book = selected.book
    val holder = patrons.firstOrNull { it.id == book.patronId }

    // each action closes the dialog once it is sent
    fun act(m: AdminEngineMutation) {
        send(m)
        onClose()
    }

    fun checkOut(patron: String) = act(TryCheckout(room, generateUuid(), patron, book.id, Instant.now()))

    AlertDialog(
        onDismissRequest = onClose,
        title = {
            val restricted = stringResource(R.string.copy_restricted).takeIf { book.restricted }
            Text(listOfNotNull(selected.title, stringResource(said(book.state)), restricted).joinToString(" · "))
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                when {
                    // an available copy goes to whichever patron may have it
                    book.state == AdminBookInfoState.OPEN || book.state == AdminBookInfoState.RESTRICTED -> {
                        Muted(stringResource(R.string.copy_check_out_to))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (p in patrons) {
                                OutlinedButton(onClick = { checkOut(p.id) }, enabled = !book.restricted || p.researcher) {
                                    PatronAvatar(p.name, p.color, size = 18)
                                    Gap()
                                    Text(p.name)
                                }
                            }
                        }
                    }

                    // a held copy goes to its holder, or its hold is released
                    book.state == AdminBookInfoState.HELD && holder != null -> {
                        Muted(stringResource(R.string.copy_on_hold_for, holder.name))
                        Button(onClick = { checkOut(holder.id) }) {
                            Text(stringResource(R.string.copy_check_out_to_holder, holder.name))
                        }
                        OutlinedButton(onClick = { act(LibraryCancelHold(room, book.holdId!!, holder.id)) }) {
                            Text(stringResource(R.string.copy_release_hold))
                        }
                    }

                    // a copy that is out comes back
                    book.state == AdminBookInfoState.OUT && holder != null -> {
                        Muted(stringResource(R.string.copy_checked_out_by, holder.name))
                        Button(onClick = { act(EndCheckout(room, book.checkoutId!!, holder.id, Instant.now())) }) {
                            Text(stringResource(R.string.copy_check_in))
                        }
                    }
                }

                // any copy may be restricted to researchers, or released to everyone
                HorizontalDivider(color = Palette.border)
                OutlinedButton(onClick = { act(UpdateBookRestricted(room, book.id, !book.restricted, Instant.now())) }) {
                    Text(stringResource(if (book.restricted) R.string.copy_open else R.string.copy_restrict))
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.copy_close)) } },
    )
}
