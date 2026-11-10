// A room of the demo on this device: the database it is in, and the three windows signed in to it,
// each its own Engine over its own way to the database, all run by one native host off the main
// thread.  Each Engine keeps its store on disk, so a room opened again starts from what it held,
// offline as well as on.

import Foundation
import LibraryModel
import Observation
import PhaseLock
import Security

/** A window's own way to the database, with a switch that takes it offline as a dropped network
    would: the live connection ends, every attempt after it fails at once, and the Engine queues
    its mutations and retries until the switch is on again. */
final class SwitchedTransport: Transport, @unchecked Sendable {
    private let http: HTTPTransport
    private let lock = NSLock()
    private var online = true
    // the connection the switch ends; an Engine has one at a time
    private var current: (any Connection)?

    init(_ http: HTTPTransport) {
        self.http = http
    }

    var isOnline: Bool { lock.withLock { online } }

    func setOnline(_ on: Bool) {
        let ending = lock.withLock {
            online = on
            return on ? nil : current
        }
        ending?.abort()
    }

    func connect(since: Int, view: String?, wants: [String], session: Session?, hooks: any ConnectionHooks) -> any Connection {
        // offline, the attempt ends as soon as it starts
        if !isOnline {
            hooks.onEnd(code: 0, reason: "offline", fatal: nil)
            return Offline()
        }

        // online, the connection lasts until the Engine ends it or the switch goes off
        let c = http.connect(since: since, view: view, wants: wants, session: session, hooks: hooks)
        lock.withLock { current = c }
        return c
    }

    func post(_ mutations: [Mutation], session: Session?) async throws -> [MutationResult] {
        if !isOnline { throw TransportError("offline") }
        return try await http.post(mutations, session: session)
    }

    private struct Offline: Connection {
        func backfill(_ b: Backfill) async throws -> BackfillOutcome { throw TransportError("offline") }
        func sendMutations(_ mutations: [Mutation]) async throws -> [MutationResult] { throw TransportError("offline") }
        func abort() {}
    }
}

/** one window: its Engine, its switch, and the id of the user it is signed in as */
struct Window<E: Sendable>: Sendable {
    let engine: E
    let transport: SwitchedTransport
    let user: String
}

/** the three windows the demo shows, each signed in as its own user, as three phones would be */
struct Windows: Sendable {
    let id = UUID()
    let room: String
    let desk: Window<AdminEngine>
    let alice: Window<UserEngine>
    let bob: Window<UserEngine>
}

// the session tokens the app keeps between runs, in the Keychain, one for each room and login
private enum Tokens {
    private static let service = "io.phaselock.examples.library"

    static func get(_ room: String, _ login: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "\(room):\(login)",
            kSecReturnData as String: true,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ room: String, _ login: String, _ token: String) {
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "\(room):\(login)",
        ]
        let data = Data(token.utf8)
        if SecItemUpdate(item as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecItemNotFound {
            var add = item
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}

/** The room the app is in, and getting into one. */
@MainActor @Observable
final class Room {
    enum State {
        case choosing
        case opening
        case open(Windows)
        case failed(String)
    }

    /** the hosted demo's database, which the web demo at demo.phaselock.io uses */
    static let defaultServer = "https://demo.phaselock.io/phaselock"

    private(set) var state: State = .choosing

    /** the server and room the app was last in */
    private(set) var lastServer = UserDefaults.standard.string(forKey: "server") ?? Room.defaultServer
    private(set) var lastRoom = UserDefaults.standard.string(forKey: "room") ?? ""

    // the one URLSession of every room the app opens, whose connections outlast a room's
    @ObservationIgnored private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.urlCache = nil
        return URLSession(configuration: config)
    }()
    @ObservationIgnored private var host: EngineHost?
    @ObservationIgnored private var http: HTTPTransport?
    // the last room's host, whose close the next room awaits, since it opens the same stores
    @ObservationIgnored private var left: EngineHost?

    /** Opens a room on the server, a new one when room is blank.  For a room that exists,
        CreateRoom writes nothing.  The app is in one room at a time, so an open while a room opens
        or is open does nothing. */
    func open(server: String, room: String) {
        switch state {
        case .opening, .open: return
        default: break
        }
        state = .opening
        Task {
            // the last room's stores are closed before any of them opens again
            await left?.closeAndJoin()

            do {
                let id = room.trimmingCharacters(in: .whitespaces)
                state = .open(try await windows(server.trimmingCharacters(in: .whitespaces), id.isEmpty ? generateUuid() : id))
            } catch {
                close()
                state = .failed("\(error)")
            }
        }
    }

    /** leaves the room, ending its Engines; their stores stay for the next time */
    func leave() {
        close()
        state = .choosing
    }

    private func windows(_ server: String, _ room: String) async throws -> Windows {
        UserDefaults.standard.set(server, forKey: "server")
        UserDefaults.standard.set(room, forKey: "room")
        lastServer = server
        lastRoom = room
        guard let url = URL(string: server) else { throw TransportError("not a URL: \(server)") }
        let http = HTTPTransport(url: url, session: session)
        self.http = http

        // the room exists before anyone signs in to it; offline, a room opened before still opens
        do {
            let created = try await postLibraryMutation(http, CreateRoom(room: room))
            guard case .ok = created else { throw TransportError("the room was not created: \(created)") }
        } catch {
            if Tokens.get(room, "admin") == nil { throw error }
        }

        // the host, with the model's native bundle
        guard let url = Bundle.main.url(forResource: "native.bundle", withExtension: "js") else {
            throw TransportError("the app has no native bundle")
        }
        let bundle = try [UInt8](Data(contentsOf: url))
        let host = try await EngineHost.open(bundle: bundle, bundleName: "native.bundle.js", transport: http)
        self.host = host

        // each window signs itself in, as the web demo's do, over a store of its own
        let stores = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("stores/\(room)")
        func window<E>(_ login: String, _ open: (Session, URL, SwitchedTransport) async throws -> E) async throws -> Window<E> {
            let session = try await signIn(http, room, login)
            let way = SwitchedTransport(http)
            let engine = try await open(session, stores.appendingPathComponent(login), way)
            return Window(engine: engine, transport: way, user: userOf(session))
        }
        let windows = Windows(
            room: room,
            desk: try await window("admin") { try await AdminEngine.open(host: host, session: $0, store: $1, transport: $2) },
            alice: try await window("alice") { try await UserEngine.open(host: host, session: $0, store: $1, transport: $2) },
            bob: try await window("bob") { try await UserEngine.open(host: host, session: $0, store: $1, transport: $2) }
        )

        /* A window whose Engine ends takes the room with it, and the app goes back to choosing.  A
           room an hour old is erased, which refuses its tokens; any other end names its own
           reason.  The ends are heard on the engine thread and acted on here. */
        let ended: @Sendable (EngineEnded) -> Void = { e in
            let reason = e.auth ? "The room has reset." : "The room closed: \(e.reason)"
            Task { @MainActor in self.end(windows, reason) }
        }
        try windows.desk.engine.onEnded(ended)
        try windows.alice.engine.onEnded(ended)
        try windows.bob.engine.onEnded(ended)
        return windows
    }

    // leaves a room whose Engine ended; the first of its windows to end leaves it, and the others
    // find it already left
    private func end(_ windows: Windows, _ reason: String) {
        guard case .open(let w) = state, w.id == windows.id else { return }
        close()
        state = .failed(reason)
    }

    /* Signs a login in with the demo's shared password (see the seed in the model's bundle), and
       keeps the token, so the room opens again offline with the session it had. */
    private func signIn(_ http: HTTPTransport, _ room: String, _ login: String) async throws -> Session {
        let session: Session
        do {
            session = try await http.login(.password(identity: "\(room):\(login)", password: "password"))
        } catch let e as AuthError {
            throw e
        } catch {
            guard let token = Tokens.get(room, login) else { throw error }
            session = try Session.restore(token)
        }
        Tokens.set(room, login, session.token)
        session.onRefresh = { s in Tokens.set(room, login, s.token) }
        return session
    }

    // the user id's own half, the patron's id for a patron
    private func userOf(_ session: Session) -> String {
        String(session.user.split(separator: ".").last ?? "")
    }

    private func close() {
        if case .open(let w) = state {
            w.desk.engine.close()
            w.alice.engine.close()
            w.bob.engine.close()
        }
        host?.close()
        http?.close()
        left = host
        host = nil
        http = nil
    }
}
