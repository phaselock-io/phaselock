// The HTTP transport: logins and sessions, connections, and mutations posted outside them.  It
// keeps @phaselock/client's HTTPTransport behavior call for call, over URLSession: every body is
// read as it arrives through bytes(for:), so a reader that stops reading stops the download, and
// cancelling a call's task cancels its request.  It runs on Apple's platforms, whose URLSession
// this is written for.

#if canImport(Darwin)
import Foundation

// the most edits one tail request asks for
private let tailMax = 1000
// a snapshot page closes at this many operations or bytes, whichever comes first
private let pageOps = 1000
private let pageBytes = 256 * 1024
// a blob operation longer than this is corruption, since a key and a value are each at most 16 MiB
private let maxOperation = 32 * 1024 * 1024
// a blob header longer than this is corruption: at this length its slices name half a million
// slices or more, which is more than one client holds
private let maxHeader = 64 * 1024 * 1024
// a blob's set opcode, and the first byte of its end marker, which sits where an opcode would
private let setOp: UInt8 = 0x00
private let endOp: UInt8 = 0xff
// a send that fails for a reason that may not recur is tried again this many times, waiting this
// long before the first retry and twice as long before each one after, unless the database names
// its own wait, which is held to the longest
private let sendRetries = 3
private let sendRetryDelay = 100
private let maxRetryDelay = 30_000
// a session is refreshed once it has lived this share of its lifetime
private let refreshAfter = 0.5
// a read that waits longer than this fails: every read but the stream's, and the stream's until
// the database names its heartbeat interval, 15 seconds by default, so a stream silent this long
// is a dead link
private let readTimeout: TimeInterval = 20
// a stream silent for this many heartbeat intervals is a dead link: one heartbeat late by up to a
// whole interval, as under a congested or waking mobile radio, still arrives in time
private let heartbeatsOfSilence = 2

/** What a login presents: a password, or an account's identity alone, which only a database run
    with --dev-auth accepts. */
public enum Credentials: Sendable {
    case password(identity: String, password: String)
    case dev(identity: String)
}

/** A failure of the transport itself: a malformed answer, a body that ended early, a connection
    that has ended. */
public struct TransportError: Error, CustomStringConvertible {
    public let description: String

    public init(_ message: String) {
        description = message
    }
}

/* A response whose status answers no mutation: safe when the database refused the request before
   deciding any of it, retryAfter the wait it names in milliseconds, and max, for a 413, the most
   mutations the database takes in one request. */
private struct StatusError: Error, CustomStringConvertible {
    let status: Int
    let description: String
    var safe = false
    var retryAfter: Int? = nil
    var max: Int? = nil
}

// whether an error is a cancelled task or a cancelled request
private func isCancellation(_ e: any Error) -> Bool {
    e is CancellationError || (e as? URLError)?.code == .cancelled
}

private func text(_ b: [UInt8]) -> String {
    String(decoding: b, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

// a response header's integer, or nil when the header is absent, empty, or no integer
private func headerInt(_ r: HTTPURLResponse, _ name: String) -> Int? {
    r.value(forHTTPHeaderField: name).flatMap { Int($0) }
}

/** A response body read as it arrives, one byte of lookahead ahead of the reader.  Reading pulls
    from the network, and not reading leaves the rest unread, which is the backpressure a backfill
    needs; cancel ends the request. */
struct Body {
    /** a value that would run past the limit its read was given */
    struct PastLimit: Error {}

    private var it: URLSession.AsyncBytes.AsyncIterator
    private var peeked: UInt8?
    let task: URLSessionDataTask

    init(_ bytes: URLSession.AsyncBytes) {
        it = bytes.makeAsyncIterator()
        task = bytes.task
    }

    func cancel() {
        task.cancel()
    }

    /** the next byte without taking it, or nil at the body's end */
    mutating func peek() async throws -> UInt8? {
        if peeked == nil { peeked = try await it.next() }
        return peeked
    }

    mutating func byte() async throws -> UInt8 {
        if let b = peeked {
            peeked = nil
            return b
        }
        guard let b = try await it.next() else { throw TransportError("body ended early") }
        return b
    }

    /** the next n bytes, held only as they arrive, since n may come from the body itself */
    mutating func bytes(_ n: Int) async throws -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(min(n, 64 * 1024))
        for _ in 0..<n { out.append(try await byte()) }
        return out
    }

    mutating func skip(_ n: Int) async throws {
        for _ in 0..<n { _ = try await byte() }
    }

    /** a big-endian 32-bit unsigned integer */
    mutating func u32() async throws -> UInt32 {
        var v: UInt32 = 0
        for _ in 0..<4 { v = (v << 8) | UInt32(try await byte()) }
        return v
    }

    /** what is left of the body */
    mutating func all() async throws -> [UInt8] {
        var out: [UInt8] = []
        if let b = peeked {
            out.append(b)
            peeked = nil
        }
        while let b = try await it.next() { out.append(b) }
        return out
    }

    /* One msgpack value appended to out, whole and undecoded; false when the body ends cleanly
       before the value starts.  Headers alone are decoded, so a value of any size and depth reads
       in one pass.  A value that would take out past limit bytes fails before its payload is
       read. */
    mutating func value(into out: inout [UInt8], limit: Int = .max) async throws -> Bool {
        if try await peek() == nil { return false }
        var pending = 1
        while pending > 0 {
            pending -= 1
            let c = try await byte()
            out.append(c)
            func be(_ n: Int) async throws -> Int {
                var v = 0
                for _ in 0..<n {
                    let x = try await byte()
                    out.append(x)
                    v = (v << 8) | Int(x)
                }
                return v
            }
            var payload = 0
            var items = 0
            switch c {
            case 0x00...0x7f, 0xe0...0xff, 0xc0, 0xc2, 0xc3: break
            case 0x80...0x8f: items = 2 * Int(c & 0x0f)
            case 0x90...0x9f: items = Int(c & 0x0f)
            case 0xa0...0xbf: payload = Int(c & 0x1f)
            case 0xc4, 0xd9: payload = try await be(1)
            case 0xc5, 0xda: payload = try await be(2)
            case 0xc6, 0xdb: payload = try await be(4)
            case 0xc7: payload = try await be(1) + 1
            case 0xc8: payload = try await be(2) + 1
            case 0xc9: payload = try await be(4) + 1
            case 0xcc, 0xd0: payload = 1
            case 0xcd, 0xd1: payload = 2
            case 0xca, 0xce, 0xd2: payload = 4
            case 0xcb, 0xcf, 0xd3: payload = 8
            case 0xd4...0xd8: payload = 1 + (1 << Int(c - 0xd4))
            case 0xdc: items = try await be(2)
            case 0xdd: items = try await be(4)
            case 0xde: items = 2 * (try await be(2))
            case 0xdf: items = 2 * (try await be(4))
            default: throw TransportError("msgpack: invalid")
            }
            if payload > limit - out.count { throw PastLimit() }
            out.append(contentsOf: try await bytes(payload))
            pending += items
        }
        return true
    }
}

/* A query value as a form encodes it: every byte but the unreserved characters percent-encoded,
   so a `+` reaches the database as itself. */
private func formEncode(_ s: String) -> String {
    var out = ""
    for b in s.utf8 {
        switch b {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
            UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "_"),
            UInt8(ascii: "."), UInt8(ascii: "~"):
            out.append(Character(UnicodeScalar(b)))
        default:
            out += String(format: "%%%02X", b)
        }
    }
    return out
}

/** The Transport to a database over HTTP, at its base URL: its origin and the path its routes are
    under, such as `https://example.com/phaselock`.  It signs in and refreshes sessions, and
    refreshes a session it is handed once the session has lived half its lifetime.

    It runs over a URLSession of its own, or over the app's, which an app that opens several
    transports shares among them.  Every read waits at most 20 seconds, except the stream's, which
    waits twice the heartbeat interval the database last named; that is how a stream finds out its
    link is dead.  close invalidates a session the transport made itself, and leaves the app's to
    the app. */
public final class HTTPTransport: Transport, @unchecked Sendable {
    private let base: String
    let session: URLSession
    private let ownsSession: Bool
    // how long the stream's reads wait, in seconds
    private let streamTimeout = Locked<TimeInterval>(readTimeout)
    // each session's refresh in flight, which every caller that wants it refreshed meanwhile
    // shares
    private let refreshes = Locked<[ObjectIdentifier: Task<Void, any Error>]>([:])
    // the most mutations one request carries, with a session and without one: the database's
    // defaults, until a 413 names its own; shared with every connection
    private let limits = Locked((session: 128, anonymous: 8))

    /** a transport over a session of its own */
    public convenience init(url: URL) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = readTimeout
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        self.init(url: url, session: URLSession(configuration: config), owns: true)
    }

    /** a transport over the app's session, which close leaves running */
    public convenience init(url: URL, session: URLSession) {
        self.init(url: url, session: session, owns: false)
    }

    private init(url: URL, session: URLSession, owns: Bool) {
        var b = url.absoluteString
        while b.hasSuffix("/") { b.removeLast() }
        base = b
        self.session = session
        ownsSession = owns
    }

    public func connect(
        since: Int,
        view: String?,
        wants: [String],
        session: Session?,
        hooks: any ConnectionHooks
    ) -> any Connection {
        HTTPConnection(transport: self, session: session, since: since, view: view, wants: wants, hooks: hooks)
    }

    /** Mutations outside any connection, as the session or as anonymous, answered with their
        outcomes in order, in as many requests as the database's limit calls for, one after
        another.  A request of numbered mutations that fails for a reason that may not recur is
        tried again a few times under the same ids, which the database's dedup makes safe; a
        request with an unnumbered mutation is tried again only when the database refused it before
        deciding any of it.  A refused session ends, and the post throws an AuthError. */
    public func post(_ mutations: [Mutation], session: Session?) async throws -> [MutationResult] {
        if let session { try await fresh(session) }
        let headers = authorization(session)
        return try await inRequests(mutations, anonymous: session == nil) { request in
            let numbered = request.allSatisfy { $0.series != nil && $0.n != nil }
            var attempt = 0
            while true {
                do {
                    return try await self.postMutations(headers, request)
                } catch {
                    if isCancellation(error) { throw error }
                    if attempt == sendRetries || !retryable(error, numbered) { throw refusal(error, session) }
                    try await Task.sleep(for: .milliseconds(retryDelay(error, attempt)))
                    attempt += 1
                }
            }
        }
    }

    /** Signs in, answering a new session.  A login the database refuses, for any reason, throws an
        AuthError naming the response's status. */
    public func login(_ credentials: Credentials) async throws -> Session {
        let body: [String: Any?] =
            switch credentials {
            case .password(let identity, let password):
                ["kind": "password", "identity": identity, "password": password]
            case .dev(let identity): ["kind": "dev", "identity": identity]
            }
        do {
            return try Session(token: try await authToken(body, nil).token)
        } catch let e as StatusError {
            throw AuthError(status: e.status, e.description)
        }
    }

    /** Re-issues the session's token in place, then calls its onRefresh.  Refreshes of one session
        while one is in flight share it.  A session the database refuses is ended, and the refresh
        throws an AuthError. */
    public func refresh(_ session: Session) async throws {
        let id = ObjectIdentifier(session)
        let task = refreshes.with { r in
            if let t = r[id] { return t }
            let t = Task {
                defer { _ = self.refreshes.with { $0.removeValue(forKey: id) } }
                try await self.reissue(session)
            }
            r[id] = t
            return t
        }
        try await task.value
    }

    private func reissue(_ session: Session) async throws {
        if session.ended { throw AuthError(status: 401, "the session has ended") }
        let reply: (token: String, exp: Int)
        do {
            reply = try await authToken(["kind": "refresh"], session.token)
        } catch {
            throw refusal(error, session)
        }
        try session.refreshed(reply.token)
        session.onRefresh?(session)
    }

    /* The session ready to present: refreshed first once it has lived refreshAfter of its
       lifetime.  A refresh that fails for any reason but a refusal leaves a token that has not
       expired to be presented as it is, since it is still good. */
    func fresh(_ session: Session) async throws {
        if session.ended { throw AuthError(status: 401, "the session has ended") }
        let c = try claims(session.token)
        let now = Date().timeIntervalSince1970
        if now < Double(c.iat) + Double(c.exp - c.iat) * refreshAfter { return }
        do {
            try await refresh(session)
        } catch {
            if error is AuthError || now >= Double(c.exp) { throw error }
        }
    }

    // one POST to /auth/token, answered with the token it signs and its expiry; any status but 200
    // throws
    private func authToken(_ body: [String: Any?], _ token: String?) async throws -> (token: String, exp: Int) {
        var req = URLRequest(url: try url("/auth/token"))
        req.httpMethod = "POST"
        req.setValue("application/msgpack", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = Data(try encodeAny(body))
        let (bytes, resp) = try await fetch(req)
        if resp.statusCode != 200 {
            throw StatusError(status: resp.statusCode, description: "auth: \(resp.statusCode) \(text(bytes))")
        }
        guard let reply = try decodeAny(bytes) as? [String: Any?],
            let t = reply["token"] as? String,
            let exp = reply["exp"] as? Int
        else { throw TransportError("auth: malformed reply") }
        return (t, exp)
    }

    func authorization(_ session: Session?) -> [String: String] {
        session.map { ["Authorization": "Bearer \($0.token)"] } ?? [:]
    }

    private func url(_ path: String, _ query: [(String, String)] = []) throws -> URL {
        var s = base + path
        if !query.isEmpty { s += "?" + query.map { "\(formEncode($0.0))=\(formEncode($0.1))" }.joined(separator: "&") }
        guard let u = URL(string: s) else { throw TransportError("not a URL: \(s)") }
        return u
    }

    func request(_ path: String, _ headers: [String: String], _ query: [(String, String)] = []) throws -> URLRequest {
        var req = URLRequest(url: try url(path, query))
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        return req
    }

    var streamReadTimeout: TimeInterval { streamTimeout.get() }

    // the heartbeat interval a stream's response named, in milliseconds, which the streams opened
    // after it read under
    func heartbeat(_ interval: Int) {
        if interval > 0 { streamTimeout.set(Double(interval * heartbeatsOfSilence) / 1000) }
    }

    /** a request's response and its body, to read as it arrives */
    func open(_ req: URLRequest) async throws -> (Body, HTTPURLResponse) {
        let (bytes, resp) = try await session.bytes(for: req)
        guard let http = resp as? HTTPURLResponse else {
            bytes.task.cancel()
            throw TransportError("not an HTTP response")
        }
        return (Body(bytes), http)
    }

    /** a request's whole response */
    func fetch(_ req: URLRequest) async throws -> ([UInt8], HTTPURLResponse) {
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw TransportError("not an HTTP response") }
        return ([UInt8](data), http)
    }

    /* Mutations in requests of at most the sender's limit each, one after another so that a
       series' mutations reach the database in order, answered with their outcomes in order.  A
       413 names the limit the database held the request to, which the mutations not yet answered
       are split again under; the database refuses such a request before checking any of it. */
    func inRequests(
        _ mutations: [Mutation],
        anonymous: Bool,
        _ send: ([Mutation]) async throws -> [MutationResult]
    ) async throws -> [MutationResult] {
        var results: [MutationResult] = []
        results.reserveCapacity(mutations.count)
        while results.count < mutations.count {
            let limit = limits.with { anonymous ? $0.anonymous : $0.session }
            let request = Array(mutations[results.count..<min(mutations.count, results.count + limit)])
            do {
                results.append(contentsOf: try await send(request))
            } catch let e as StatusError where e.status == 413 && e.max != nil {
                // a limit that would not split the request is the database's mistake, and stands
                let max = e.max!
                if max >= request.count { throw e }
                limits.with {
                    if anonymous { $0.anonymous = max } else { $0.session = max }
                }
            }
        }
        return results
    }

    /* One POST of mutations, answered with their outcomes in order.  Any status but 200 throws,
       since such a response answers no mutation; a 413 names the database's limit. */
    func postMutations(_ headers: [String: String], _ mutations: [Mutation]) async throws -> [MutationResult] {
        var w = MsgWriter()
        for m in mutations {
            w.array(4)
            if let series = m.series, let n = m.n {
                w.str(series)
                w.int(n)
            } else {
                w.nil_()
                w.nil_()
            }
            w.bin(try uuidBytes(m.id))
            w.raw(m.data)
        }
        var req = try request("/mutations", headers)
        req.httpMethod = "POST"
        req.setValue("application/msgpack", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(w.bytes)
        let (bytes, resp) = try await fetch(req)
        if resp.statusCode != 200 {
            let message = "mutations: \(resp.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: resp.statusCode))"
            var e = StatusError(status: resp.statusCode, description: message)
            if resp.statusCode == 413, let max = headerInt(resp, "PhaseLock-Max-Mutations"), max > 0 { e.max = max }
            e.safe = resp.value(forHTTPHeaderField: "PhaseLock-Safe-To-Retry") == "true"
            e.retryAfter = headerInt(resp, "Retry-After").map { $0 * 1000 }
            throw e
        }
        var r = MsgReader(bytes)
        var results: [MutationResult] = []
        for _ in 0..<(try r.arrayHeader()) { results.append(try mutationResult(&r)) }
        return results
    }

    /** ends the refreshes in flight, and invalidates the session when the transport made it */
    public func close() {
        for t in refreshes.with({ Array($0.values) }) { t.cancel() }
        if ownsSession { session.invalidateAndCancel() }
    }
}

// one outcome of /mutations, `[kind, value]`
private func mutationResult(_ r: inout MsgReader) throws -> MutationResult {
    let n = try r.arrayHeader()
    let kind = try r.str()
    let result: MutationResult
    switch kind {
    case "ok": result = .ok(position: try r.int())
    case "reject": result = .reject(reason: try r.str())
    case "conflict":
        var current: [String: Int] = [:]
        for _ in 0..<(try r.mapHeader()) { current[try r.str()] = try r.int() }
        result = .conflict(current: current)
    default: throw TransportError("unknown mutation outcome \(kind)")
    }
    for _ in 0..<max(n - 2, 0) { try r.skip() }
    return result
}

// the error a failed auth or mutation request throws: a 401 is the database refusing the session,
// which ends it; any other failure is itself
private func refusal(_ e: any Error, _ session: Session?) -> any Error {
    guard let s = e as? StatusError, s.status == 401 else { return e }
    session?.end()
    return AuthError(status: 401, s.description)
}

/* Whether a failed send may go again.  A 429, and a 503 the database marks safe to retry, refused
   the request before any of it was decided, so it may go again whatever it holds; any other
   failure but a 4xx may have applied some of it, so it goes again only when every mutation is
   numbered, since the database's dedup answers a resent one it applied. */
private func retryable(_ e: any Error, _ numbered: Bool) -> Bool {
    guard let s = e as? StatusError else { return numbered }
    if s.status == 429 || s.safe { return true }
    return numbered && (s.status < 400 || s.status >= 500)
}

// how long to wait before a send's next attempt, in milliseconds: the wait the database names, or
// the backoff's
private func retryDelay(_ e: any Error, _ attempt: Int) -> Int {
    if let named = (e as? StatusError)?.retryAfter, named >= 0 { return min(named, maxRetryDelay) }
    return sendRetryDelay << attempt
}

/* One connection over HTTP: the live stream, the backfills and mutation sends that ride on it, and
   the session they all present.  Before it opens the stream and before each send it readies the
   session, which refreshes it when due; a 401 from any of them is the database refusing the
   session, which ends the connection fatally. */
private final class HTTPConnection: Connection, @unchecked Sendable {
    private struct State {
        var ended = false
        var stopped = false
        // the stream's request, whose body reads outlive its task's cancellation, so stopping the
        // connection cancels the request itself
        var stream: URLSessionDataTask?
        // every task of the connection, by id; stopping it cancels them all
        var tasks: [Int: Task<Void, Never>] = [:]
        var nextTask = 0
        // the send queue: one call in flight at a time, and the calls behind it in order
        var sends: [([Mutation], Deferred<[MutationResult]>)] = []
        var sending = false
    }

    private let transport: HTTPTransport
    private let session: Session?
    private let hooks: any ConnectionHooks
    private let state = Locked(State())
    // the log's epoch once the stream opens, or a failure when the connection ends before that
    private let epoch = Deferred<String>()

    init(transport: HTTPTransport, session: Session?, since: Int, view: String?, wants: [String], hooks: any ConnectionHooks) {
        self.transport = transport
        self.session = session
        self.hooks = hooks
        launch { await self.run(since, view, wants) }
    }

    private var ended: Bool { state.get().ended }

    // starts work that stopping the connection cancels
    private func launch(_ fn: @escaping @Sendable () async -> Void) {
        state.with { s in
            let id = s.nextTask
            s.nextTask += 1
            let t = Task {
                await fn()
                _ = self.state.with { $0.tasks.removeValue(forKey: id) }
            }
            if s.stopped { t.cancel() } else { s.tasks[id] = t }
        }
    }

    // runs fn as the connection's work, which stopping the connection cancels, as is cancelling
    // the caller
    private func within<T: Sendable>(_ fn: @escaping @Sendable () async throws -> T) async throws -> T {
        let result = Deferred<T>()
        launch {
            do {
                result.complete(try await fn())
            } catch {
                result.fail(error)
            }
        }
        return try await withTaskCancellationHandler {
            try await result.value()
        } onCancel: {
            result.fail(CancellationError())
        }
    }

    private func ready() async throws {
        if let session { try await transport.fresh(session) }
    }

    private func headers(_ extra: [String: String] = [:]) -> [String: String] {
        extra.merging(transport.authorization(session)) { _, b in b }
    }

    // the one onEnd: server end frames pass their code through; transport-level ends carry the
    // HTTP status, and local ends (abort, closed body) carry 0
    private func end(_ code: Int, _ reason: String, _ fatal: AuthError? = nil) {
        let was = state.with {
            let was = $0.ended
            $0.ended = true
            return was
        }
        if was { return }
        epoch.fail(TransportError("connection ended before its stream opened: \(reason)"))
        hooks.onEnd(code: code, reason: reason, fatal: fatal)
    }

    // the database refused the session: it ends for good, and so does this connection, fatally
    private func refuse(_ message: String) -> AuthError {
        session?.end()
        let err = AuthError(status: 401, message)
        end(401, message, err)
        stop()
        return err
    }

    func abort() {
        end(0, "aborted")
        stop()
    }

    // every request of the connection cancelled, the stream's reads included
    private func stop() {
        let (stream, tasks) = state.with { s in
            s.stopped = true
            return (s.stream, Array(s.tasks.values))
        }
        stream?.cancel()
        for t in tasks { t.cancel() }
    }

    private func run(_ since: Int, _ view: String?, _ wants: [String]) async {
        do {
            try await ready()
            var q = [("since", String(since))]
            if let view { q.append(("view", view)) }
            for w in wants { q.append(("want", w)) }
            var req = try transport.request("/stream", headers(), q)
            req.timeoutInterval = transport.streamReadTimeout
            var (body, resp) = try await transport.open(req)
            let stopped = state.with { s in
                s.stream = body.task
                return s.stopped
            }
            if stopped {
                body.cancel()
                return
            }
            defer { body.cancel() }
            if resp.statusCode == 401 {
                _ = refuse(text(try await body.all()))
                return
            }
            if resp.statusCode != 200 {
                end(resp.statusCode, text(try await body.all()))
                return
            }
            guard let e = resp.value(forHTTPHeaderField: "PhaseLock-Epoch"), !e.isEmpty else {
                end(resp.statusCode, "stream: no epoch")
                return
            }
            guard let head = headerInt(resp, "PhaseLock-Position") else {
                end(resp.statusCode, "stream: no position")
                return
            }
            if let interval = headerInt(resp, "PhaseLock-Heartbeat") { transport.heartbeat(interval) }
            hooks.onOpen(epoch: e, head: head)
            epoch.complete(e)
            var buf: [UInt8] = []
            while true {
                // a frame read as the connection ended is never delivered
                buf.removeAll(keepingCapacity: true)
                if try await !body.value(into: &buf) || ended { break }
                switch try parseFrame(buf) {
                case .edits(let edits): hooks.onEdits(edits)
                case .live(let position): hooks.onLive(position: position)
                case .vouch(let position): hooks.onVouch(position: position)
                case .view(let token, let position, let selectors):
                    hooks.onView(token: token, position: position, selectors: selectors)
                case .end(let code, let reason):
                    end(code, reason)
                    return
                }
            }
            end(0, "stream closed")
        } catch {
            if isCancellation(error) {
                end(0, "aborted")
            } else {
                let auth = error as? AuthError
                end(auth?.status ?? 0, "\(error)", auth)
            }
        }
    }

    func backfill(_ b: Backfill) async throws -> BackfillOutcome {
        if ended { throw TransportError("snapshot \(b.selector): the connection has ended") }
        return try await within { try await self.runBackfill(b) }
    }

    private func runBackfill(_ b: Backfill) async throws -> BackfillOutcome {
        let r = b.resume
        return try await withThrowingTaskGroup(of: Void.self) { group in
            // the snapshot half, unless a previous attempt finished it; when one half fails the
            // other is pointless, which the group sees to
            var position: Int
            if let r, r.snapshotDone {
                position = r.position
            } else {
                let (cut, blob) = try await openSnapshot(b)
                switch blob {
                case .stale: return .stale
                case .complete: break
                case .reading(let reading): group.addTask { try await self.blobPages(b, reading) }
                }
                position = cut
            }

            // the tail half, unless a previous attempt finished it
            let from = max(r?.fromPosition ?? position, position)
            if !(r?.tailDone ?? false) { group.addTask { try await self.tail(b, from) } }
            try await group.waitForAll()
            return .done
        }
    }

    /** What opening a snapshot's blob found: cut from another log, or a resumed download whose cut
        moved; a resumed blob that was already complete; or a body opened past its header, with
        the offset there, and the operation count and content hash of every operation before it. */
    private enum Blob: @unchecked Sendable {
        case stale
        case complete
        case reading(Reading)
    }

    private final class Reading: @unchecked Sendable {
        var body: Body
        var offset: Int
        var count: Int
        var fnv: Fnv64

        init(body: Body, offset: Int, count: Int, fnv: Fnv64) {
            self.body = body
            self.offset = offset
            self.count = count
            self.fnv = fnv
        }
    }

    /* The snapshot's first response, and the blob a pointer leads to, opened: its length pushed,
       and for a fresh download its header checked and pushed.  Answers the snapshot's cut position
       and what the blob holds. */
    private func openSnapshot(_ b: Backfill) async throws -> (Int, Blob) {
        let r = b.resume
        let skip = r?.skipBytes ?? 0
        let range = skip > 0 ? ["Range": "bytes=\(skip)-"] : [:]
        var (first, resp) = try await transport.open(try transport.request("/snapshot/\(b.selector)", headers(range)))
        let okStatus = { (c: Int) in c == 200 || c == 206 || c == 416 }
        var keep = false
        defer { if !keep { first.cancel() } }
        if resp.statusCode == 401 { throw refuse(text(try await first.all())) }
        if !okStatus(resp.statusCode) { throw TransportError("snapshot \(b.selector): \(resp.statusCode)") }

        // the origin's response carries the position and the epoch; a blob store owes only the
        // bytes
        guard let position = headerInt(resp, "PhaseLock-Position") else {
            throw TransportError("snapshot \(b.selector): no position")
        }
        guard let e = resp.value(forHTTPHeaderField: "PhaseLock-Epoch"), !e.isEmpty else {
            throw TransportError("snapshot \(b.selector): no epoch")
        }

        // a cut from another log is stale, and so is a resumed download whose cut moved; the
        // connection learns its log's epoch when the stream opens, so this waits for that
        if e != (try await epoch.value()) { return (position, .stale) }
        if skip > 0 && position != r!.position { return (position, .stale) }

        // the blob, inline or where a pointer leads
        if resp.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/plain") == true {
            let target = text(try await first.all())
            guard let u = URL(string: target) else { throw TransportError("snapshot \(b.selector): bad pointer") }
            var req = URLRequest(url: u)
            for (k, v) in range { req.setValue(v, forHTTPHeaderField: k) }
            let (blob, blobResp) = try await transport.open(req)
            if blobResp.statusCode == 404 || blobResp.statusCode == 410 {
                blob.cancel()
                return (position, .stale)
            }
            if !okStatus(blobResp.statusCode) {
                blob.cancel()
                throw TransportError("snapshot \(b.selector): \(blobResp.statusCode)")
            }
            first.cancel()
            first = blob
            resp = blobResp
        }
        let opened = try await blobOpen(b, first, resp, position, e, skip)
        if case .reading = opened { keep = true }
        return (position, opened)
    }

    /* Open a blob's body: push its length, and for a fresh download check and push its header.
       Answers where its operations start, complete for a resumed blob that was already complete,
       or stale for a fresh blob cut from a log other than the one the origin named. */
    private func blobOpen(
        _ b: Backfill,
        _ body: Body,
        _ resp: HTTPURLResponse,
        _ position: Int,
        _ epoch: String,
        _ skip: Int
    ) async throws -> Blob {
        var body = body
        if resp.statusCode == 416 {
            // skip is the end: every page was delivered already
            body.cancel()
            try await b.push(.pagesDone)
            return .complete
        }

        // the blob's whole length, for the Engine's progress, when the response states one
        if let length = blobLength(resp) { try await b.push(.length(length)) }

        var offset = resp.statusCode == 206 ? skip : 0
        // a server that ignored the Range sent the whole blob; skip what we already have
        if resp.statusCode == 200 && skip > 0 {
            try await body.skip(skip)
            offset = skip
        }

        // if the download is fresh, check and push its header
        if skip == 0 {
            let magic = try await body.bytes(4)
            if magic != Array("PLSN".utf8) { throw TransportError("snapshot \(b.selector): bad magic") }
            let version = try await body.byte()
            if version != 1 { throw TransportError("snapshot \(b.selector): version \(version)") }
            let hlen = Int(try await body.u32())
            if hlen > maxHeader { throw TransportError("snapshot \(b.selector): header too long") }
            let hdr = try await body.bytes(hlen)
            let crc = try await body.u32()
            if crc != crc32c(hdr) { throw TransportError("snapshot \(b.selector): header crc") }
            offset += 9 + hlen + 4
            guard let header = try decodeAny(hdr) as? [String: Any?] else {
                throw TransportError("snapshot \(b.selector): bad header")
            }
            // a pointer that led to another log's blob
            if header["epoch"] as? String != epoch { return .stale }
            if header["position"] as? Int != position {
                throw TransportError("snapshot \(b.selector): position mismatch")
            }
            guard let visible = header["visible"] as? Int else {
                throw TransportError("snapshot \(b.selector): header without visible")
            }
            let slices = (header["slices"] as? [String: Any?] ?? [:]).compactMapValues { $0 as? Int }
            try await b.push(.header(position: position, seqs: slices, visible: visible))
            return .reading(Reading(body: body, offset: offset, count: 0, fnv: Fnv64()))
        }

        // otherwise it resumes, so the count and the hash continue from its last parked page
        let parts = b.resume!.checksum.split(separator: ":")
        guard parts.count == 2, let count = Int(parts[0]), String(count) == parts[0],
            let fnv = Fnv64(state: String(parts[1]))
        else { throw TransportError("snapshot \(b.selector): bad resume checksum") }
        return .reading(Reading(body: body, offset: offset, count: count, fnv: fnv))
    }

    // a blob response's whole length: a full response's Content-Length, or a range response's
    // Content-Range total; nil when it states neither, or is encoded
    private func blobLength(_ resp: HTTPURLResponse) -> Int? {
        if let encoding = resp.value(forHTTPHeaderField: "Content-Encoding"), encoding != "identity" { return nil }
        if resp.statusCode == 206 {
            return resp.value(forHTTPHeaderField: "Content-Range")?.split(separator: "/").last.flatMap { Int($0) }
        }
        return headerInt(resp, "Content-Length")
    }

    /* A blob's set operations, as pages of whole ones, and its footer.  A page is the operations'
       bytes as the blob holds them; its skip is the offset after its last one, which a resume
       starts from, and its checksum the count and the hash through it, which a resume
       continues. */
    private func blobPages(_ b: Backfill, _ reading: Reading) async throws {
        defer { reading.body.cancel() }
        var page: [UInt8] = []
        var ops = 0
        var op: [UInt8] = []
        while true {
            guard let next = try await reading.body.peek() else { throw TransportError("body ended early") }

            // the end marker, then the footer: the operation count, the content hash, and its crc
            if next == endOp {
                let marker = try await reading.body.u32()
                let footer = try await reading.body.bytes(16)
                if marker != 0xffff_ffff { throw TransportError("snapshot \(b.selector): corrupt operation") }
                let be = { (from: Int) in footer[from..<from + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) } }
                if be(12) != crc32c(footer[0..<12]) { throw TransportError("snapshot \(b.selector): footer crc") }
                if Int(be(0)) != reading.count { throw TransportError("snapshot \(b.selector): operation count") }
                if Array(footer[4..<12]) != reading.fnv.digest {
                    throw TransportError("snapshot \(b.selector): content hash")
                }
                break
            }

            // one set operation, whole: its opcode, key, and value
            if next != setOp { throw TransportError("snapshot \(b.selector): corrupt operation") }
            op.removeAll(keepingCapacity: true)
            do {
                for _ in 0..<3 {
                    if try await !reading.body.value(into: &op, limit: maxOperation) { throw TransportError("body ended early") }
                }
            } catch is Body.PastLimit {
                throw TransportError("snapshot \(b.selector): corrupt operation")
            }
            reading.fnv.update(op)
            page.append(contentsOf: op)
            reading.count += 1
            reading.offset += op.count
            ops += 1
            if ops >= pageOps || page.count >= pageBytes {
                try await b.push(.page(page, skip: reading.offset, checksum: "\(reading.count):\(reading.fnv.state)"))
                page.removeAll(keepingCapacity: true)
                ops = 0
            }
        }
        if ops > 0 { try await b.push(.page(page, skip: reading.offset, checksum: "\(reading.count):\(reading.fnv.state)")) }
        try await b.push(.pagesDone)
    }

    private func tail(_ b: Backfill, _ from: Int) async throws {
        var after = from
        while true {
            let q = [("after", String(after)), ("before", String(b.until)), ("max", String(tailMax))]
            let (bytes, resp) = try await transport.fetch(try transport.request("/edits/\(b.selector)", headers(), q))
            if resp.statusCode == 401 { throw refuse(text(bytes)) }
            if resp.statusCode != 200 { throw TransportError("edits \(b.selector): \(resp.statusCode)") }

            // the page's edits, each raw, and the position its scan reached
            let scanned = headerInt(resp, "PhaseLock-Scanned")
            var edits: [[UInt8]] = []
            var last = after
            var r = MsgReader(bytes)
            while !r.done {
                guard case .edits(let frame) = try parseFrame(try r.raw()) else {
                    throw TransportError("edits \(b.selector): a frame that is not edits")
                }
                var er = MsgReader(frame)
                for _ in 0..<(try er.arrayHeader()) {
                    let raw = try er.raw()
                    var pr = MsgReader(raw)
                    _ = try pr.arrayHeader()
                    _ = try pr.arrayHeader()
                    last = try pr.int()
                    edits.append(raw)
                }
            }
            if !edits.isEmpty {
                var w = MsgWriter()
                w.array(edits.count)
                for e in edits { w.raw(e) }
                try await b.push(.edits(w.bytes, scanned: scanned ?? last))
            }

            // the scan is done once it reaches until, or when it reports no progress; a page's edit
            // count says nothing, since a page never splits the edits of one position
            guard let reached = scanned, reached < b.until, reached > after else {
                try await b.push(.editsDone)
                return
            }
            after = reached
        }
    }

    func sendMutations(_ mutations: [Mutation]) async throws -> [MutationResult] {
        let result = Deferred<[MutationResult]>()
        let start = state.with { s -> Bool? in
            if s.ended { return nil }
            s.sends.append((mutations, result))
            if s.sending { return false }
            s.sending = true
            return true
        }
        guard let start else { throw TransportError("mutations: the connection has ended") }
        if start { launch { await self.pump() } }
        return try await result.value()
    }

    // the send queue, one call at a time; a failure that stands fails every call queued at that
    // moment without sending it, and ends the connection
    private func pump() async {
        while true {
            let next = state.with { s -> ([Mutation], Deferred<[MutationResult]>)? in
                if s.sends.isEmpty {
                    s.sending = false
                    return nil
                }
                return s.sends.removeFirst()
            }
            guard let (mutations, result) = next else { return }
            do {
                result.complete(try await post(mutations))
            } catch {
                let behind = state.with { s in
                    let b = s.sends
                    s.sends.removeAll()
                    s.sending = false
                    return b
                }
                if isCancellation(error) {
                    let ended = TransportError("mutations: the connection has ended")
                    result.fail(ended)
                    for (_, d) in behind { d.fail(ended) }
                    return
                }
                result.fail(error)
                for (_, d) in behind { d.fail(error) }
                failed(error)
                return
            }
        }
    }

    /* One call, as the requests the database's limit calls for, each with its retries.  A retry
       repeats the request under the same ids, which the database's dedup makes safe.  A 4xx answer
       but a 429 is the client's own doing and stands at once; so does any failure once the
       connection has ended, since the next connection resends. */
    private func post(_ mutations: [Mutation]) async throws -> [MutationResult] {
        try await ready()
        let headers = headers()
        return try await transport.inRequests(mutations, anonymous: session == nil) { request in
            var attempt = 0
            while true {
                do {
                    return try await self.transport.postMutations(headers, request)
                } catch {
                    if isCancellation(error) { throw error }
                    if attempt == sendRetries || !retryable(error, true) || self.ended { throw error }
                    try await Task.sleep(for: .milliseconds(retryDelay(error, attempt)))
                    if self.ended { throw error }
                    attempt += 1
                }
            }
        }
    }

    // a send that failed ends the connection: the one onEnd carries the response's status, or 0
    // when no response arrived, and the stream stops; a refused session ends it fatally
    private func failed(_ e: any Error) {
        if e is AuthError || (e as? StatusError)?.status == 401 {
            _ = refuse("\(e)")
            return
        }
        end((e as? StatusError)?.status ?? 0, "\(e)")
        stop()
    }
}

/** One frame of /stream or /edits.  Frame elements appended by later protocol versions are
    skipped; an edits frame carries its raw edits undecoded. */
enum Frame {
    case edits([UInt8])
    case live(Int)
    case vouch(Int)
    case view(token: String, position: Int, selectors: [String])
    case end(code: Int, reason: String)
}

func parseFrame(_ bytes: [UInt8]) throws -> Frame {
    var r = MsgReader(bytes)
    let n = try r.arrayHeader()
    if n < 1 { throw TransportError("empty frame") }
    let tag = try r.str()
    let frame: Frame
    let used: Int
    switch tag {
    case "edits": (frame, used) = (.edits(try r.raw()), 2)
    case "live": (frame, used) = (.live(try r.int()), 2)
    case "vouch": (frame, used) = (.vouch(try r.int()), 2)
    case "view":
        let token = try r.str()
        let position = try r.int()
        var selectors: [String] = []
        for _ in 0..<(try r.arrayHeader()) { selectors.append(try r.str()) }
        (frame, used) = (.view(token: token, position: position, selectors: selectors), 4)
    case "end":
        let code = try r.int()
        (frame, used) = (.end(code: code, reason: try r.str()), 3)
    default: throw TransportError("unknown frame \(tag)")
    }
    if n < used { throw TransportError("short \(tag) frame") }
    for _ in 0..<(n - used) { try r.skip() }
    return frame
}
#endif
