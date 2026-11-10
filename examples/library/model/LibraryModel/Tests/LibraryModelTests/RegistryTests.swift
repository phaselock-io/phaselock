import Foundation
import Testing

@testable import LibraryModel
@testable import PhaseLock

// msgpack written by hand, for values no encoder of the model writes
private func msg(_ fn: (inout MsgWriter) throws -> Void) rethrows -> [UInt8] {
    var w = MsgWriter()
    try fn(&w)
    return w.bytes
}

private func expectMismatch(_ message: String, _ fn: () throws -> Any?) {
    do {
        _ = try fn()
        Issue.record("expected the mismatch \(message)")
    } catch let e as ConvertError {
        #expect(e.description == message)
    } catch {
        Issue.record("expected a ConvertError, got \(error)")
    }
}

/** The library model's registry: each value decodes to what was encoded, through every union
    solution the model's types use. */
@Suite struct LibraryRegistryTests {
    private let at = Date(timeIntervalSince1970: 1_700_000_000.123)

    private func roundTrip<T: Equatable>(_ type: String, _ value: T) throws {
        #expect(try registry.decode(type, try registry.encode(type, value), as: T.self) == value)
    }

    @Test func structsWithOptionalFieldsPresentAndLeftOut() throws {
        try roundTrip("Book", Book(id: "b1", isbn: "978-0", restricted: true, timestamp: at))
        try roundTrip("Book", Book(id: "b1", isbn: "978-0", restricted: false, timestamp: at, status: .checkout(.init(checkout: "c1"))))
    }

    @Test func unionsByWhichFieldTheyHave() throws {
        try roundTrip("Book", Book(id: "b1", isbn: "978-0", restricted: false, timestamp: at, status: .hold(.init(hold: "h1"))))
        try roundTrip("PatronHold", PatronHold(id: "h1", target: .edition(.init(edition: "978-0")), expires: at, pending: true))
        try roundTrip("PatronHold", PatronHold(id: "h1", target: .book(.init(book: "b1"))))
    }

    @Test func unionsByALiteralField() throws {
        let hold = TryHold(room: "r", id: "h1", patron: "p1", target: .book(.init(book: "b1")), open: false, timestamp: at)
        #expect(try registry.decode("UserMutations", try registry.encode("UserMutations", hold), as: TryHold.self) == hold)
        let change = ChangePassword(room: "r", check: .password(.init(password: "old")), new: "new")
        #expect(try registry.decode("UserMutations", try registry.encode("UserMutations", change), as: ChangePassword.self) == change)
        let totp = ChangePassword(room: "r", check: .totp(.init(code: "123456")), new: "new")
        #expect(try registry.decode("LibraryDBMutation", try registry.encode("LibraryDBMutation", totp), as: ChangePassword.self) == totp)
    }

    @Test func unionsOfAStructOrNull() throws {
        try roundTrip("UserBookInfo", UserBookInfo(isbn: "978-0", title: "T", availableNormal: 2, availableRestricted: ["b1", "b2"], hold: nil, checkout: nil))
        try roundTrip(
            "UserBookInfo",
            UserBookInfo(isbn: "978-0", title: "T", availableNormal: 0, availableRestricted: [], hold: UserHoldInfo(id: "h1", target: .edition(.init(edition: "978-0")), restricted: false), checkout: nil)
        )
    }

    @Test func anEnumByItsWireLiteral() throws {
        let books = [
            AdminBookInfo(id: "b1", restricted: false, state: .open),
            AdminBookInfo(id: "b2", restricted: true, state: .out, pending: true, patronId: "p1", checkoutId: "c1"),
        ]
        try roundTrip(
            "AdminQueries.allEditions#result",
            [AdminEditionInfo(isbn: "978-0", title: "T", books: books), AdminEditionInfo(isbn: "978-1", title: "U", books: [])]
        )
    }

    @Test func nestedArraysOfStructs() throws {
        let patron = UserPatronInfo(
            name: "Alice",
            color: "red",
            researcher: false,
            holds: [PatronHold(id: "h1", target: .book(.init(book: "b1"))), PatronHold(id: "h2", target: .edition(.init(edition: "978-0")), expires: at)],
            checkouts: [UserCheckoutInfo(id: "c1", book: "b3", title: "T", expires: at, overdue: true)]
        )
        try roundTrip("UserQueries.myPatron#result", patron)
        let out = Checkout(id: "c1", book: "b2", expires: at, overdue: false)
        try roundTrip("UserQueries.allBooks#result", [UserBookInfo(isbn: "978-0", title: "T", availableNormal: 1, availableRestricted: ["b1"], hold: nil, checkout: out)])
    }

    @Test func aUnionOfTuplesByLengthAndAnItemsLiteral() throws {
        let call = try registry.decode("UserQuery", try registry.encode("UserQuery", ["UserQueries.allBooks"] as [Any?])) as? [Any?]
        #expect(call?.first as? String == "UserQueries.allBooks")
        expectMismatch("$: no member of UserQuery fits") { try registry.decode("UserQuery", msg { $0.array(0) }) }
        expectMismatch("$: no member of UserQuery fits") {
            try registry.decode("UserQuery", try msg { try $0.any(["AdminQueries.notices"]) })
        }
    }

    @Test func aKeyTheSchemaDoesNotNameIsSkipped() throws {
        let bytes = try msg { w in
            w.map(3)
            w.str("extra")
            try w.any(["deep": [1, ["x": 2.5]], "bin": [UInt8]([1, 2])])
            w.str("isbn")
            w.str("978-0")
            w.str("title")
            w.str("T")
        }
        #expect(try registry.decode("Edition", bytes, as: Edition.self) == Edition(isbn: "978-0", title: "T"))
    }

    @Test func aLiteralFieldIsChecked() throws {
        let bytes = try msg { try $0.any(["type": "cancel-hold", "room": "r", "id": "h1", "patron": "p1"]) }
        expectMismatch("$.type: expected try-hold") { try registry.decode("TryHold", bytes) }
    }

    @Test func aMismatchDeepInsideNamesItsPath() throws {
        let hold: [String: Any?] = ["id": "h1", "target": ["book": "b1"]]
        let bad: [String: Any?] = ["id": "h2", "target": ["copy": "b1"]]
        let bytes = try msg {
            try $0.any(["name": "Alice", "color": "red", "researcher": false, "holds": [hold, bad], "checkouts": [] as [Any?]])
        }
        expectMismatch("$.holds[1].target: no member of the union fits") { try registry.decode("UserPatronInfo", bytes) }
    }

    @Test func anEnumWritesTheMemberItHolds() throws {
        // the enum's value and the member it holds write the same bytes
        let target = HoldTarget.edition(.init(edition: "978-0"))
        #expect(try registry.encode("PatronHold", PatronHold(id: "h", target: target)) == (try msg { try $0.any(["id": "h", "target": ["edition": "978-0"]]) }))
    }
}
