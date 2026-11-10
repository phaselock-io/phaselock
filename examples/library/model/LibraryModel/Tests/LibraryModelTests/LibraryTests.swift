// The library model end to end on Apple's platforms, whose HTTP transport this is: Engines in the
// native host syncing with the database, run from its release binary.

#if canImport(Darwin)
import Darwin
import Foundation
import Testing

@testable import LibraryModel
@testable import PhaseLock

// the repository, from this file
private let repo = (0..<7).reduce(URL(fileURLWithPath: #filePath)) { u, _ in u.deletingLastPathComponent() }
private let model = repo.appendingPathComponent("examples/library/model")

// a loopback port no one listens on, as the kernel picks one
private func freePort() -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    withUnsafeMutablePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            _ = bind(fd, $0, len)
            _ = getsockname(fd, $0, &len)
        }
    }
    return Int(UInt16(bigEndian: addr.sin_port))
}

// whether something takes connections on a loopback port
private func listening(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    addr.sin_port = UInt16(port).bigEndian
    return withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
        }
    }
}

/** The database, run from its release binary with the model's bundle, in a data directory of its
    own, on a free loopback port. */
private final class Database {
    let port = freePort()
    let data = FileManager.default.temporaryDirectory.appendingPathComponent("phaselockdb-\(UUID().uuidString)")
    let process = Process()
    var url: URL { URL(string: "http://127.0.0.1:\(port)/phaselock")! }

    init() throws {
        let bin = repo.appendingPathComponent("db/target/release/phaselockdb")
        guard FileManager.default.isExecutableFile(atPath: bin.path) else {
            throw TransportError("build the database first: make -C db")
        }
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        process.executableURL = bin
        process.arguments = [
            "--bundle", model.appendingPathComponent("bundle.js").path,
            "--data", data.path,
            "--listen", "127.0.0.1:\(port)",
        ]
        FileManager.default.createFile(atPath: data.appendingPathComponent("log").path, contents: nil)
        let handle = try FileHandle(forWritingTo: data.appendingPathComponent("log"))
        process.standardOutput = handle
        process.standardError = handle
        try process.run()

        // up once its port takes a connection
        let deadline = Date().addingTimeInterval(10)
        while !listening(port) {
            if !process.isRunning {
                let text = (try? String(contentsOf: data.appendingPathComponent("log"), encoding: .utf8)) ?? ""
                throw TransportError("the database exited: \(text)")
            }
            if Date() > deadline { throw TransportError("the database never listened") }
            usleep(20_000)
        }
    }

    func close() {
        process.terminate()
        process.waitUntilExit()
        try? FileManager.default.removeItem(at: data)
    }
}

// the first of a sequence's elements that passes a test
private func first<S: AsyncSequence>(_ s: S, where test: (S.Element) -> Bool = { _ in true }) async throws -> S.Element {
    for try await e in s where test(e) { return e }
    throw TransportError("the sequence ended")
}

/** Engines over the database: a patron's predicted hold, an @online mutation, a librarian's
    checkout reaching the patron, and a store opened again once its host has closed. */
@Suite(.serialized) struct LibraryTests {
    private func openHost(_ transport: HTTPTransport) async throws -> EngineHost {
        let bundle = try [UInt8](Data(contentsOf: model.appendingPathComponent("native.dev.bundle.js")))
        return try await EngineHost.open(bundle: bundle, bundleName: "native.dev.bundle.js", transport: transport)
    }

    // a room the database seeded
    private func room(_ transport: HTTPTransport) async throws -> String {
        let room = generateUuid()
        let created = try await postLibraryMutation(transport, CreateRoom(room: room))
        guard case .ok = created else { throw TransportError("\(created)") }
        return room
    }

    private func signIn(_ transport: HTTPTransport, _ room: String, _ login: String) async throws -> Session {
        try await transport.login(.password(identity: "\(room):\(login)", password: "password"))
    }

    private func stores() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("stores-\(UUID().uuidString)")
    }

    @Test(.timeLimit(.minutes(1)))
    func aPatronsEngineSyncsTheCatalogAndPredictsAHold() async throws {
        let db = try Database()
        defer { db.close() }
        let transport = HTTPTransport(url: db.url)
        defer { transport.close() }
        let host = try await openHost(transport)
        let dir = stores()
        defer { try? FileManager.default.removeItem(at: dir) }

        let room = try await room(transport)
        let session = try await signIn(transport, room, "alice")
        let alice = try await UserEngine.open(host: host, session: session, store: dir.appendingPathComponent("alice"))
        let ended = Locked<EngineEnded?>(nil)
        try alice.onEnded { e in ended.set(e) }
        let queries = UserQueries(alice)

        // live, with the seeded catalog: four editions
        _ = try await first(alice.status) { $0.connection.state == .live }
        let books = try await first(queries.allBooks()) { $0.count == 4 }
        #expect(
            books.map(\.title).sorted()
                == ["A Tale of Two Cities", "Great Expectations", "One Hundred Years of Solitude", "War and Peace"]
        )

        // a hold on an edition shows pending at once, then decided
        let patron = String(session.user.split(separator: ".").last ?? "")
        let isbn = "978-0-14-143956-3"
        try alice.sendMutation(
            TryHold(room: room, id: generateUuid(), patron: patron, target: .edition(.init(edition: isbn)), open: false, timestamp: Date())
        )
        let pending = try await first(queries.myPatron()) { !$0.holds.isEmpty }
        #expect(pending.holds[0].pending == true)
        let decided = try await first(queries.myPatron()) { !$0.holds.isEmpty && $0.holds[0].pending == nil }
        #expect(decided.holds[0].target == .edition(.init(edition: isbn)))
        _ = try await first(alice.status) { $0.outbox.unacknowledged == 0 }

        // an @online mutation answers with the database's outcome
        let changed = try await alice.sendOnlineMutation(
            ChangePassword(room: room, check: .password(.init(password: "password")), new: "another password")
        )
        #expect(changed == .ok(position: { if case .ok(let p) = changed { p } else { -1 } }()))
        #expect(ended.get() == nil)
        await host.closeAndJoin()
    }

    @Test(.timeLimit(.minutes(1)))
    func aLibrariansCheckoutReachesThePatron() async throws {
        let db = try Database()
        defer { db.close() }
        let transport = HTTPTransport(url: db.url)
        defer { transport.close() }
        let host = try await openHost(transport)
        let dir = stores()
        defer { try? FileManager.default.removeItem(at: dir) }

        let room = try await room(transport)
        let bob = try await UserEngine.open(host: host, session: try await signIn(transport, room, "bob"), store: dir.appendingPathComponent("bob"))
        let admin = try await AdminEngine.open(host: host, session: try await signIn(transport, room, "admin"))
        let adminQueries = AdminQueries(admin)

        // the librarian sees both patrons, and checks out an unrestricted copy to Bob
        let patrons = try await first(adminQueries.allPatrons()) { $0.count == 2 }
        let bobId = try #require(patrons.first { $0.name == "Bob" }).id
        let editions = try await first(adminQueries.allEditions()) { !$0.isEmpty }
        let copy = try #require(editions.first { $0.title == "War and Peace" }?.books.first { $0.state == .open })
        try admin.sendMutation(TryCheckout(room: room, id: generateUuid(), patron: bobId, book: copy.id, timestamp: Date()))

        // the copy is out for the librarian at once, predicted, and Bob's profile shows it once it
        // is decided
        let out = try await first(adminQueries.allEditions()) { eds in
            eds.flatMap(\.books).first { $0.id == copy.id }?.state == .out
        }
        #expect(out.flatMap(\.books).first { $0.id == copy.id }?.patronId == bobId)
        let checkouts = try await first(UserQueries(bob).myPatron()) { !$0.checkouts.isEmpty }.checkouts
        #expect(checkouts[0].title == "War and Peace")
        await host.closeAndJoin()
    }

    @Test(.timeLimit(.minutes(1)))
    func aStoreOpensAgainInAnotherHostOnceItsHostHasClosed() async throws {
        let db = try Database()
        defer { db.close() }
        let transport = HTTPTransport(url: db.url)
        defer { transport.close() }
        let host = try await openHost(transport)
        let dir = stores()
        defer { try? FileManager.default.removeItem(at: dir) }

        let room = try await room(transport)
        let session = try await signIn(transport, room, "alice")
        let store = dir.appendingPathComponent("alice")

        // the catalog, synced into the store
        let firstEngine = try await UserEngine.open(host: host, session: session, store: store)
        _ = try await first(UserQueries(firstEngine).allBooks()) { $0.count == 4 }
        await host.closeAndJoin()

        // a closed host fails what it is asked
        await #expect(throws: HostError.self) { _ = try await UserEngine.open(host: host, session: session) }
        #expect(throws: HostError.self) {
            try firstEngine.sendMutation(CancelHold(room: room, id: generateUuid(), patron: "p"))
        }

        // another host opens the same directory, since the first host's close has completed
        let next = try await openHost(transport)
        let again = try await UserEngine.open(host: next, session: session, store: store)
        _ = try await first(UserQueries(again).allBooks()) { $0.count == 4 }
        await next.closeAndJoin()
    }
}
#endif
