// The front desk, a librarian's window: the shared notices, every patron, and the catalog, where
// each copy of an edition opens what can be done with it.

import LibraryModel
import PhaseLock
import SwiftUI

// what each state of a copy is called; a restricted copy that is free is available, and its
// restriction is said apart from its state
private func said(_ state: AdminBookInfoState) -> String {
    switch state {
    case .open, .restricted: "available"
    case .held: "on hold"
    case .out: "checked out"
    }
}

// a copy of an edition, as the sheet that acts on it holds it
private struct Selected: Identifiable {
    var id: String { book.id }
    let book: AdminBookInfo
    let title: String
}

struct DeskWindow: View {
    let room: String
    let window: Window<AdminEngine>
    @State private var allPatrons: LiveQuery<[Patron]?>
    @State private var editions: LiveQuery<[AdminEditionInfo]?>
    @State private var notices: LiveQuery<[Notice]>
    @State private var selected: Selected?
    @State private var renaming: Renaming?

    init(room: String, window: Window<AdminEngine>) {
        self.room = room
        self.window = window
        let queries = AdminQueries(window.engine)
        _allPatrons = State(initialValue: LiveQuery(queries.allPatrons()))
        _editions = State(initialValue: LiveQuery(queries.allEditions()))
        _notices = State(initialValue: LiveQuery(queries.notices(), initial: []))
    }

    private var engine: AdminEngine { window.engine }

    private func send(_ m: some AdminEngineMutation) {
        try? engine.sendMutation(m)
    }

    var body: some View {
        // the patrons by name, and by id for the copies they hold
        let patrons = allPatrons.value?.sorted { $0.name < $1.name }
        let byId = Dictionary((patrons ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        List {
            HStack {
                Text("Front Desk").font(.headline)
                Spacer()
                ConnectionSwitch(status: engine.status, transport: window.transport) { try? engine.reconnectNow() }
            }

            // checkouts that failed after the desk moved on
            ForEach(notices.value, id: \.id) { notice in
                NoticeCard(text: "Checkout failed: \(notice.reason)") { send(DismissNotice(room: room, id: notice.id)) }
            }

            // each patron, renamed or made a researcher here
            Section {
                if let patrons {
                    ForEach(patrons, id: \.id) { patron in
                        HStack {
                            PatronAvatar(name: patron.name, color: patron.color)
                            Text(patron.name)
                            EditButton(description: "Rename patron") {
                                renaming = Renaming(label: "Rename patron", value: patron.name) { name in
                                    send(RenamePatron(room: room, id: patron.id, name: name, timestamp: Date()))
                                }
                            }
                            Spacer()
                            Muted("researcher")
                            Toggle(
                                "Researcher",
                                isOn: Binding(
                                    get: { patron.researcher },
                                    set: { send(AssignPatron(room: room, id: patron.id, researcher: $0, timestamp: Date())) }
                                )
                            )
                            .labelsHidden()
                        }
                        .listRowBackground(Palette.panel)
                    }
                } else {
                    ProgressView()
                }
            } header: {
                SectionTitle("Patrons")
            }

            // the catalog: each edition, and a chip for each of its copies
            Section {
                if let editions = editions.value {
                    ForEach(editions, id: \.isbn) { edition in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(edition.title).font(.headline)
                                EditButton(description: "Rename edition") {
                                    renaming = Renaming(label: "Rename edition", value: edition.title) { title in
                                        send(UpdateEditionTitle(room: room, isbn: edition.isbn, title: title, timestamp: Date()))
                                    }
                                }
                            }
                            FlowLayout {
                                ForEach(edition.books, id: \.id) { book in
                                    CopyChip(book: book, patron: book.patronId.flatMap { byId[$0] }) {
                                        selected = Selected(book: book, title: edition.title)
                                    }
                                }
                                Button("+ copy") {
                                    send(AddBook(room: room, id: generateUuid(), isbn: edition.isbn, restricted: false, timestamp: Date()))
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                        .padding(.vertical, 4)
                        .listRowBackground(Palette.panel)
                    }
                } else {
                    ProgressView()
                }
            } header: {
                SectionTitle(title: "Catalog") {
                    Button("+ edition") {
                        renaming = Renaming(label: "New edition", value: "") { title in
                            send(AddEdition(room: room, isbn: generateUuid(), title: title, timestamp: Date()))
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .nameDialog($renaming)
        .sheet(item: $selected) { s in
            CopyActions(selected: s, patrons: patrons ?? [], room: room, send: { try? engine.sendMutation($0) }) { selected = nil }
                .presentationDetents([.medium])
        }
    }
}

/** One copy: its state, a note when it is restricted, and the avatar of the patron who holds it or
    has it out.  A copy whose hold or checkout the database has not decided shows a spinner. */
private struct CopyChip: View {
    let book: AdminBookInfo
    let patron: Patron?
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 6) {
                if book.pending == true { ProgressView().controlSize(.mini) }
                Text(book.restricted ? "\(said(book.state)) · restricted" : said(book.state)).font(.footnote)
                if let patron { PatronAvatar(name: patron.name, color: patron.color, size: 18) }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .overlay(Capsule().stroke(Palette.border))
        }
        .buttonStyle(.plain)
    }
}

/** Everything that can be done with one copy, by its state: checking it out to a patron, checking a
    held copy out to its holder or releasing the hold, checking it back in, and restricting it. */
private struct CopyActions: View {
    let selected: Selected
    let patrons: [Patron]
    let room: String
    let send: (any AdminEngineMutation) -> Void
    let onClose: () -> Void

    // each action closes the sheet once it is sent
    private func act(_ m: some AdminEngineMutation) {
        send(m)
        onClose()
    }

    private func checkOut(_ patron: String) {
        act(TryCheckout(room: room, id: generateUuid(), patron: patron, book: selected.book.id, timestamp: Date()))
    }

    var body: some View {
        let book = selected.book
        let holder = patrons.first { $0.id == book.patronId }
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                switch book.state {
                // an available copy goes to whichever patron may have it
                case .open, .restricted:
                    Muted("Check out to")
                    FlowLayout(spacing: 8) {
                        ForEach(patrons, id: \.id) { p in
                            Button {
                                checkOut(p.id)
                            } label: {
                                HStack(spacing: 6) {
                                    PatronAvatar(name: p.name, color: p.color, size: 18)
                                    Text(p.name)
                                }
                            }
                            .buttonStyle(.bordered)
                            .disabled(book.restricted && !p.researcher)
                        }
                    }

                // a held copy goes to its holder, or its hold is released
                case .held:
                    if let holder, let holdId = book.holdId {
                        Muted("On hold for \(holder.name)")
                        Button("Check out to \(holder.name)") { checkOut(holder.id) }.buttonStyle(.borderedProminent)
                        Button("Release hold") { act(LibraryCancelHold(room: room, id: holdId, patron: holder.id)) }
                            .buttonStyle(.bordered)
                    }

                // a copy that is out comes back
                case .out:
                    if let holder, let checkoutId = book.checkoutId {
                        Muted("Checked out by \(holder.name)")
                        Button("Check in") {
                            act(EndCheckout(room: room, checkout: checkoutId, patron: holder.id, timestamp: Date()))
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }

                // any copy may be restricted to researchers, or released to everyone
                Divider()
                Button(book.restricted ? "Open to everyone" : "Restrict to researchers") {
                    act(UpdateBookRestricted(room: room, id: book.id, restricted: !book.restricted, timestamp: Date()))
                }
                .buttonStyle(.bordered)
                Spacer()
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .navigationTitle([selected.title, said(book.state), book.restricted ? "restricted" : nil].compactMap { $0 }.joined(separator: " · "))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Close", action: onClose) }
        }
    }
}
