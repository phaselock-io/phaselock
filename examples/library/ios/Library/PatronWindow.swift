// A patron's window: their profile, their notices, and the catalog, which shows what they have out
// and where they place and cancel holds.  A hold the database has not decided yet shows a spinner.

import LibraryModel
import PhaseLock
import SwiftUI

/** what the patron's checkout or hold of a title, or the copies they may hold, come to, in a few
    words; restricted copies count only for a researcher, who alone may hold them */
private func availability(_ book: UserBookInfo, researcher: Bool) -> String {
    if book.checkout != nil { return "checked out" }
    if let hold = book.hold {
        if hold.pending == true { return "Placing a hold…" }
        if let expires = hold.expires { return "On hold until \(day(expires))" }
        return "On hold"
    }

    // the free copies
    let restricted = researcher ? book.availableRestricted.count : 0
    var free: [String] = []
    if book.availableNormal > 0 { free.append("\(book.availableNormal) available") }
    if restricted > 0 { free.append("\(restricted) restricted") }
    return free.isEmpty ? "every copy is taken" : free.joined(separator: " · ")
}

struct PatronWindow: View {
    let room: String
    let window: Window<UserEngine>
    @State private var patron: LiveQuery<UserPatronInfo?>
    @State private var books: LiveQuery<[UserBookInfo]?>
    @State private var notices: LiveQuery<[Notice]>
    @State private var renaming: Renaming?

    init(room: String, window: Window<UserEngine>) {
        self.room = room
        self.window = window
        let queries = UserQueries(window.engine)
        _patron = State(initialValue: LiveQuery(queries.myPatron()))
        _books = State(initialValue: LiveQuery(queries.allBooks()))
        _notices = State(initialValue: LiveQuery(queries.notices(), initial: []))
    }

    private var engine: UserEngine { window.engine }

    private func send(_ m: some UserEngineMutation) {
        try? engine.sendMutation(m)
    }

    private func hold(_ target: HoldTarget) {
        send(TryHold(room: room, id: generateUuid(), patron: window.user, target: target, open: false, timestamp: Date()))
    }

    var body: some View {
        List {
            // who the patron is, and the window's connection
            HStack {
                if let p = patron.value, !p.name.isEmpty {
                    PatronAvatar(name: p.name, color: p.color)
                    Text(p.name).font(.headline)
                    EditButton(description: "Rename yourself") {
                        renaming = Renaming(label: "Rename yourself", value: p.name) { name in
                            send(RenamePatron(room: room, id: window.user, name: name, timestamp: Date()))
                        }
                    }
                    if p.researcher { Muted("researcher") }
                } else {
                    ProgressView()
                }
                Spacer()
                ConnectionSwitch(status: engine.status, transport: window.transport) { try? engine.reconnectNow() }
            }

            // holds that closed or failed without the patron, each dismissed on its own
            ForEach(notices.value, id: \.id) { notice in
                NoticeCard(text: notice.reason) { send(PatronDismissNotice(room: room, id: notice.id, patron: window.user)) }
            }

            // the catalog: each title, with a hold, the hold's cancel, or when the patron's copy is due
            Section {
                if let books = books.value {
                    ForEach(books, id: \.isbn) { book in
                        BookRow(book: book, researcher: patron.value?.researcher == true, onHold: hold) { id in
                            send(CancelHold(room: room, id: id, patron: window.user))
                        }
                    }
                } else {
                    ProgressView()
                }
            } header: {
                SectionTitle("Catalog")
            }
        }
        .scrollContentBackground(.hidden)
        .nameDialog($renaming)
    }
}

/** One title of the catalog: what of it the patron may hold or has, and one control, which keeps
    the row one height whatever it shows.  A book the patron has out shows when it is due, a hold
    shows its cancel, and otherwise the Hold button offers what is free. */
private struct BookRow: View {
    let book: UserBookInfo
    let researcher: Bool
    let onHold: (HoldTarget) -> Void
    let onCancelHold: (String) -> Void

    var body: some View {
        HStack {
            // each line keeps to one line, so the row keeps one height
            VStack(alignment: .leading, spacing: 2) {
                Text(book.title)
                Muted(availability(book, researcher: researcher))
            }
            .lineLimit(1)
            Spacer()

            if let checkout = book.checkout {
                // a checkout shows when it is due, in red once it is overdue
                Text("due \(day(checkout.expires))")
                    .font(.footnote)
                    .foregroundStyle(checkout.overdue ? Palette.alarm : Palette.muted)
            } else if let hold = book.hold {
                // a hold, pending or decided, may be canceled
                Button {
                    onCancelHold(hold.id)
                } label: {
                    HStack(spacing: 6) {
                        if hold.pending == true { ProgressView().controlSize(.small) }
                        Text("Cancel hold")
                    }
                }
                .buttonStyle(.quiet)
                .fixedSize()
            } else {
                HoldButton(
                    isbn: book.isbn,
                    ordinary: book.availableNormal > 0,
                    restricted: researcher ? book.availableRestricted.first : nil,
                    onHold: onHold
                )
            }
        }
        .listRowBackground(Palette.panel)
    }
}

/** The Hold button: it holds an ordinary copy if one is free, or else the free restricted copy
    offered, and it is disabled when neither is.  When both are free, a chevron joined to its right
    edge opens a menu of the two. */
private struct HoldButton: View {
    let isbn: String
    let ordinary: Bool
    let restricted: String?
    let onHold: (HoldTarget) -> Void

    // what the button holds: an ordinary copy if one is free, or else the restricted one
    private var target: HoldTarget? {
        if ordinary { return .edition(.init(edition: isbn)) }
        return restricted.map { .book(.init(book: $0)) }
    }

    var body: some View {
        HStack(spacing: -1) {
            Button("Hold") { target.map(onHold) }
                .buttonStyle(QuietButtonStyle(joined: ordinary && restricted != nil ? .trailing : nil))
                .disabled(target == nil)

            // if both kinds of copy are free, the chevron offers the choice
            if ordinary, let restricted {
                Menu {
                    Button("Hold an ordinary copy") { onHold(.edition(.init(edition: isbn))) }
                    Button("Hold a restricted copy") { onHold(.book(.init(book: restricted))) }
                } label: {
                    Text(Image(systemName: "chevron.down")) // a Text, to keep the text's height
                }
                .menuStyle(.button)
                .buttonStyle(QuietButtonStyle(joined: .leading))
                .accessibilityLabel("Choose a copy to hold")
            }
        }
        .fixedSize()
    }
}
