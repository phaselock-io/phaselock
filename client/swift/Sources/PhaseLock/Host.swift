// The native host: QuickJS running a model's native bundle, on a thread of its own, and the
// Engines the bundle builds.  Every call into the native library happens on that thread, and
// every call answers with the events the JS side raised (see ../../native/src/api.rs); the host
// acts on them here, starting the transport's work in tasks of its own and handing their results
// back to the engine thread.  The connections' hooks queue, and each drain of the queue is one
// call, so the frames that arrive together commit together.

import CPhaseLock
import Foundation
#if canImport(os)
import os
#endif

/** The native library: three functions, every argument and answer msgpack. */
enum Native {
    static func open(_ bundle: [UInt8], _ name: [UInt8], _ limits: [UInt8]) -> [UInt8] {
        bundle.withUnsafeBufferPointer { b in
            name.withUnsafeBufferPointer { n in
                limits.withUnsafeBufferPointer { l in
                    take(pl_open(b.baseAddress, b.count, n.baseAddress, n.count, l.baseAddress, l.count))
                }
            }
        }
    }

    static func call(_ host: Int64, _ request: [UInt8]) -> [UInt8] {
        request.withUnsafeBufferPointer { r in take(pl_call(host, r.baseAddress, r.count)) }
    }

    static func close(_ host: Int64) {
        pl_close(host)
    }

    // an answer's bytes, copied out of the buffer the library hands back and frees
    private static func take(_ b: PlBytes) -> [UInt8] {
        defer { pl_free(b) }
        return Array(UnsafeBufferPointer(start: b.ptr, count: b.len))
    }
}

#if canImport(os)
private let logger = Logger(subsystem: "io.phaselock", category: "engine")
#endif

/** Where a host's messages go unless its open names a log: the unified logging system on Apple's
    platforms, and stderr elsewhere. */
public let defaultLog: @Sendable (String) -> Void = { message in
    #if canImport(os)
    logger.log("\(message)")
    #else
    FileHandle.standardError.write(Data("phaselock: \(message)\n".utf8))
    #endif
}

/** The native host failed a call: the bundle would not load, or JS threw where nothing could
    catch it. */
public struct HostError: Error, CustomStringConvertible {
    public let description: String

    init(_ message: String) {
        description = message
    }
}

/** How an Engine ended: why, and whether the database refused its session, which only signing in
    again mends. */
public struct EngineEnded: Sendable, Equatable {
    public let reason: String
    public let auth: Bool
}

/** A declared query failed to run or to convert its result. */
public struct QueryError: Error, CustomStringConvertible {
    public let description: String
}

/** How far the model's JS may run, which is the app's own code over its own data, so the limits are
    generous.  Each call into the runtime takes at most callTimeout of the engine thread's CPU time,
    so time the app spends suspended does not count: JS still running then is interrupted where no
    JS can catch it, which ends the host and every Engine it runs, each with a reason naming the
    limit and the backtrace of the JS that ran away.  The runtime's heap holds at most memory bytes,
    past which an allocation throws in JS, which ends the Engine that does not catch it. */
public struct EngineLimits: Sendable {
    public var callTimeout: Duration
    public var memory: Int

    public init(callTimeout: Duration = .seconds(60), memory: Int = 1 << 30) {
        self.callTimeout = callTimeout
        self.memory = memory
    }
}

/* The engine thread's stack, and the part of it JS may take, counted down from each call into the
   runtime.  The 2 MiB between them hold the frames beneath the JS (the thread's own, the
   library's, and the native host's, well under 256 KiB) and the natives JS calls, so a recursion
   that runs deep throws a stack overflow in JS before it reaches the end of the thread's stack. */
private let engineStack = 8 << 20
private let jsStack = 6 << 20

/** One thread and its work: closures run in the order they were posted, and one timer, which the
    host sets after every call.  Shutting down runs the work already posted and then stops; a
    closure posted after that is dropped. */
final class EngineThread: @unchecked Sendable {
    private let cond = NSCondition()
    private var jobs: [() -> Void] = []
    private var head = 0
    // the timer's deadline in uptime nanoseconds, and what it runs
    private var timer: (at: UInt64, fn: () -> Void)?
    private var stopping = false
    private var thread: Thread?

    init(name: String, stackSize: Int) {
        let t = Thread { self.run() }
        t.name = name
        t.stackSize = stackSize
        thread = t
        t.start()
    }

    var isCurrent: Bool { Thread.current === thread }

    /** queues fn, answering false when the thread has shut down */
    @discardableResult
    func post(_ fn: @escaping () -> Void) -> Bool {
        cond.lock()
        defer { cond.unlock() }
        if stopping { return false }
        jobs.append(fn)
        cond.signal()
        return true
    }

    /** sets the one timer to run fn after ms milliseconds, or clears it for nil */
    func schedule(afterMillis ms: Int?, _ fn: @escaping () -> Void) {
        cond.lock()
        defer { cond.unlock() }
        timer = ms.map { (DispatchTime.now().uptimeNanoseconds + UInt64(max($0, 0)) * 1_000_000, fn) }
        cond.signal()
    }

    func shutDown() {
        cond.lock()
        stopping = true
        timer = nil
        cond.signal()
        cond.unlock()
    }

    /* The thread's loop.  A closure it runs is let go of before the lock is taken again, and the
       queue holds none that ran, since letting go of a closure may free a host, whose deinit
       posts. */
    private func run() {
        cond.lock()
        while true {
            // the next closure, taken out of the queue and run without the lock
            if head < jobs.count {
                var fn: (() -> Void)? = jobs[head]
                jobs[head] = {}
                head += 1
                if head == jobs.count {
                    jobs.removeAll(keepingCapacity: true)
                    head = 0
                }
                cond.unlock()
                fn?()
                fn = nil
                cond.lock()
                continue
            }
            if stopping { break }

            // otherwise the timer when it is due, and a wait until it is or until work arrives
            if let at = timer?.at {
                let now = DispatchTime.now().uptimeNanoseconds
                if now >= at {
                    var fn = timer?.fn
                    timer = nil
                    cond.unlock()
                    fn?()
                    fn = nil
                    cond.lock()
                    continue
                }
                _ = cond.wait(until: Date(timeIntervalSinceNow: Double(at - now) / 1e9))
            } else {
                cond.wait()
            }
        }
        cond.unlock()
        thread = nil
    }
}

/** The native host of a model's Engines: the bundle, loaded once into one QuickJS runtime on one
    thread, and the transport every Engine it builds syncs through.  Open one with open, and close
    it to end every Engine; a call on a host that is closed or closing fails with a HostError.  A
    host that nothing holds any more, its Engines included, closes as close closes it.
    The host also ends on its own when a call into its runtime runs past the call limit
    (EngineLimits): every Engine's onEnded hears why, and the host closes as close closes it. */
public final class EngineHost: @unchecked Sendable {
    private let transport: any Transport
    private let log: @Sendable (String) -> Void
    private let thread = EngineThread(name: "phaselock-engine", stackSize: engineStack)
    // whether close has begun, and its completion once the native host is freed
    private let closing = Locked(false)
    let freed = Deferred<Void>()
    // why the host ended on its own, once a call into it ran past its limit
    private let endedWhy = Locked<String?>(nil)
    // the transport's work for the Engines, which runs off the engine thread, by id
    private let work = Locked<(next: Int, tasks: [Int: Task<Void, Never>])>((1, [:]))
    // every connection's hooks in arrival order, each a hook of a connHooks request, queued from
    // the transport's threads for the next drain
    private let queued = Locked<[[Any?]]>([])
    // the query starts queued for the engine thread, which takes every one queued by then in one
    // queries request
    private let starting = Locked<[QueryStart]>([])
    // what the host follows of its app, once it has opened, until it closes
    private let follower = Locked<AppFollower?>(nil)

    // everything below is the engine thread's alone
    private var handle: Int64 = 0
    private var nextId = 1
    private var sessions: [Int: Session] = [:]
    // each Engine's own transport, for an Engine built with one
    private var transports: [Int: any Transport] = [:]
    private var connections: [Int: any Connection] = [:]
    // each backfill's work, by backfill
    private var backfills: [Int: Int] = [:]
    private var pushes: [Int: Deferred<Void>] = [:]
    private var queries: [Int: (Result<[UInt8], any Error>) -> Void] = [:]
    // each ejectable query's request by its id, which starts it again after an ejection
    private var ejectables: [Int: (Int) -> [Any?]] = [:]
    // whether the ejectable queries are ejected, while the app is in the background
    private var ejected = false
    private var engines: Set<Int> = []
    private var onlines: [Int: Deferred<MutationResult>] = [:]
    private var ended: [Int: @Sendable (EngineEnded) -> Void] = [:]
    // each Engine that has ended, and how, for an onEnded that comes after
    private var endings: [Int: EngineEnded] = [:]

    private init(transport: any Transport, log: @escaping @Sendable (String) -> Void) {
        self.transport = transport
        self.log = log
    }

    /** Loads the model's native bundle, named bundleName in its errors, into a host of its own,
        whose Engines sync through transport unless given one of their own.  The bundle loads on
        the engine thread; a bundle that will not load fails with a HostError.  JS that passes a
        limit throws: past the call timeout, the host ends, and with it every Engine; past the
        memory limit, the allocation throws in JS, and an Engine that does not catch it ends with
        the error as its reason.
        A host that follows its app hears what enterBackground, enterForeground, and
        networkChanged say from the platform: on iOS, the app going to the background and
        returning, and on Apple's platforms, the network path changing.  A host that does not
        follow its app hears them only from the app's own calls. */
    public static func open(
        bundle: [UInt8],
        bundleName: String,
        transport: any Transport,
        limits: EngineLimits = EngineLimits(),
        followsApp: Bool = true,
        log: @escaping @Sendable (String) -> Void = defaultLog
    ) async throws -> EngineHost {
        let host = EngineHost(transport: transport, log: log)
        var w = MsgWriter()
        w.array(3)
        w.int(jsStack)
        w.int(limits.memory)
        w.int(Int(limits.callTimeout / .milliseconds(1)))
        let limitsBytes = w.bytes
        do {
            try await host.run {
                var r = MsgReader(Native.open(bundle, Array(bundleName.utf8), limitsBytes))
                _ = try r.arrayHeader()
                if try r.str() == "error" { throw HostError(try r.str()) }
                host.handle = Int64(try r.int())
            }
        } catch {
            // a host that failed to open still holds its thread
            host.close()
            throw error
        }
        if followsApp { host.follower.set(await AppFollower.start(host)) }
        return host
    }

    private func closedError() -> HostError {
        HostError(endedWhy.get().map { "the engine host has ended: \($0)" } ?? "the engine host is closed")
    }

    // runs fn on the engine thread and answers what it returns
    private func run<T: Sendable>(_ fn: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<T, any Error>) in
            let posted = thread.post { c.resume(with: Result { try fn() }) }
            if !posted { c.resume(throwing: closedError()) }
        }
    }

    // runs fn on the engine thread and answers what it returns, failing on a host that is closed
    // or closing
    private func onThread<T: Sendable>(_ fn: @escaping () throws -> T) async throws -> T {
        if closing.get() { throw closedError() }
        return try await run {
            if self.handle == 0 { throw self.closedError() }
            return try fn()
        }
    }

    // runs fn on the engine thread, reporting what it throws; a host that has shut its thread down
    // has nothing left for fn to act on, so fn is dropped
    @discardableResult
    private func post(_ fn: @escaping () throws -> Void) -> Bool {
        thread.post {
            do {
                try fn()
            } catch {
                self.log("\(error)")
            }
        }
    }

    // posts a caller's request, failing on a host that is closed or closing
    private func request(_ fn: @escaping () throws -> Void) throws {
        if closing.get() { throw closedError() }
        post(fn)
    }

    private func id() -> Int {
        defer { nextId += 1 }
        return nextId
    }

    // starts work off the engine thread, which close cancels
    @discardableResult
    private func launch(_ fn: @escaping @Sendable () async -> Void) -> Int {
        work.with { w in
            let id = w.next
            w.next += 1
            w.tasks[id] = Task {
                await fn()
                self.work.with { _ = $0.tasks.removeValue(forKey: id) }
            }
            return id
        }
    }

    private func cancelWork(_ id: Int) {
        work.with { $0.tasks[id] }?.cancel()
    }

    /* One request to the native host, [op, ...args]: the next timer is scheduled, and then the
       events it answers with are acted on.  Acting on one may make a call of its own, whose timer
       is newer and takes the place of this one's. */
    private func call(_ op: String, _ args: Any?...) throws {
        try request(op, args)
    }

    private func request(_ op: String, _ args: [Any?]) throws {
        if handle == 0 { return }
        var w = MsgWriter()
        w.array(args.count + 1)
        w.str(op)
        for a in args { try w.any(a) }
        var r = MsgReader(Native.call(handle, w.bytes))
        _ = try r.arrayHeader()
        switch try r.str() {
        case "error": throw HostError(try r.str())
        case "ended": throw end(try r.str())
        default: break
        }
        let delay: Int?
        if try r.isNil() {
            try r.nil_()
            delay = nil
        } else {
            delay = try r.int()
        }
        thread.schedule(afterMillis: delay) { [weak self] in
            guard let self else { return }
            do {
                try self.call("pump")
            } catch {
                self.log("\(error)")
            }
        }
        var events: [Any?] = []
        for _ in 0..<(try r.arrayHeader()) { events.append(try r.any()) }

        // every event is acted on even when one fails, since each settles something of its own,
        // and the first failure is the call's; a host that has shut down acts on nothing more
        var failure: (any Error)?
        for e in events {
            if handle == 0 { break }
            do {
                guard let e = e as? [Any?] else { throw HostError("an event is not an array") }
                try event(e)
            } catch {
                if failure == nil { failure = error } else { log("\(error)") }
            }
        }
        if let failure { throw failure }
    }

    // one event from the JS side
    private func event(_ e: [Any?]) throws {
        let op = e.first as? String ?? ""
        switch op {
        case "log":
            log(try str(e, 1))
        case "connect":
            try connect(try int(e, 1), try int(e, 2), try int(e, 3), at(e, 4) as? String, at(e, 5) as? [Any?] ?? [], at(e, 6) as? Int)
        case "abortConnection":
            connections[try int(e, 1)]?.abort()
        case "backfill":
            try backfill(try int(e, 1), try int(e, 2), try str(e, 3), try int(e, 4), at(e, 5) as? [String: Any?])
        case "abortBackfill":
            if let w = backfills[try int(e, 1)] { cancelWork(w) }
        case "pushSettled":
            let d = pushes.removeValue(forKey: try int(e, 1))
            if let error = at(e, 2) as? String { d?.fail(HostError(error)) } else { d?.complete() }
        case "send":
            try send(try int(e, 1), try int(e, 2), at(e, 3) as? [Any?] ?? [])
        case "queryResult":
            guard let b = at(e, 2) as? [UInt8] else { throw HostError("queryResult: no bytes") }
            queries[try int(e, 1)]?(.success(b))
        case "queryFailed":
            queries[try int(e, 1)]?(.failure(QueryError(description: try str(e, 2))))
        case "onlineSettled":
            let d = onlines.removeValue(forKey: try int(e, 1))
            if let error = at(e, 3) as? String {
                d?.fail(HostError(error))
            } else {
                d?.complete(try mutationResult(at(e, 2) as? [String: Any?] ?? [:]))
            }
        case "ended":
            let engine = try int(e, 1)
            let end = EngineEnded(reason: try str(e, 2), auth: at(e, 3) as? Bool ?? false)
            endings[engine] = end
            ended[engine]?(end)
        default:
            log("unknown event \(op)")
        }
    }

    // an event's argument i, nil past its end
    private func at(_ e: [Any?], _ i: Int) -> Any? {
        i < e.count ? e[i] : nil
    }

    private func int(_ e: [Any?], _ i: Int) throws -> Int {
        guard i < e.count, let v = e[i] as? Int else { throw HostError("\(e.first as? String ?? "event"): argument \(i) is no integer") }
        return v
    }

    private func str(_ e: [Any?], _ i: Int) throws -> String {
        guard i < e.count, let v = e[i] as? String else { throw HostError("\(e.first as? String ?? "event"): argument \(i) is no string") }
        return v
    }

    private func mutationResult(_ m: [String: Any?]) throws -> MutationResult {
        switch m["kind"] as? String {
        case "ok": return .ok(position: m["position"] as? Int ?? 0)
        case "reject": return .reject(reason: m["reason"] as? String ?? "")
        default:
            let current = (m["current"] as? [String: Any?] ?? [:]).compactMapValues { $0 as? Int }
            return .conflict(current: current)
        }
    }

    /** One connection's hooks, each queued for the next drain under the connection's id. */
    private struct Hooks: ConnectionHooks {
        weak var host: EngineHost?
        let id: Int

        func onOpen(epoch: String, head: Int) { host?.hook(["connOpen", id, epoch, head]) }

        func onView(token: String, position: Int, selectors: [String]) {
            host?.hook(["connView", id, token, position, selectors])
        }

        func onEdits(_ edits: [UInt8]) { host?.hook(["connEdits", id, edits]) }

        func onLive(position: Int) { host?.hook(["connLive", id, position]) }

        func onVouch(position: Int) { host?.hook(["connVouch", id, position]) }

        func onEnd(code: Int, reason: String, fatal: AuthError?) {
            host?.hook(["connEnd", id, code, reason, fatal?.description])
        }
    }

    // a connection the Engine asked for, whose hooks hand everything back to the engine thread
    private func connect(_ engine: Int, _ id: Int, _ since: Int, _ view: String?, _ wants: [Any?], _ session: Int?) throws {
        let s = session.flatMap { sessions[$0] }
        let t = transports[engine] ?? transport
        let hooks = Hooks(host: self, id: id)
        connections[id] = t.connect(since: since, view: view, wants: wants.compactMap { $0 as? String }, session: s, hooks: hooks)
    }

    // a hook for the next drain, which the first hook into an empty queue posts
    private func hook(_ request: [Any?]) {
        let first = queued.with {
            $0.append(request)
            return $0.count == 1
        }
        if first { post { try self.drainHooks() } }
    }

    /* Every hook queued so far, in one call, so the Engine commits the frames among them in one
       transaction; hooks that arrive during the call queue for the next drain. */
    private func drainHooks() throws {
        let hooks = queued.with {
            let h = $0
            $0.removeAll()
            return h
        }

        // a connection whose end is among them leaves the table before the Engine hears of it
        for h in hooks where h[0] as? String == "connEnd" {
            if let c = h[1] as? Int { connections.removeValue(forKey: c) }
        }
        try call("connHooks", hooks)
    }

    // a backfill call on a connection, settled however it ends; a push waits for the Engine's
    // commit
    private func backfill(_ conn: Int, _ id: Int, _ selector: String, _ until: Int, _ resume: [String: Any?]?) throws {
        guard let c = connections[conn] else {
            try call("backfillSettled", id, nil, "the connection has ended")
            return
        }
        let r = resume.map {
            Resume(
                position: $0["position"] as? Int ?? 0,
                visible: $0["visible"] as? Int ?? 0,
                skipBytes: $0["skipBytes"] as? Int ?? 0,
                checksum: $0["checksum"] as? String ?? "",
                fromPosition: $0["fromPosition"] as? Int ?? 0,
                snapshotDone: $0["snapshotDone"] as? Bool ?? false,
                tailDone: $0["tailDone"] as? Bool ?? false
            )
        }
        let b = Backfill(selector: selector, until: until, resume: r) { [weak self] item in
            guard let self else { throw CancellationError() }
            try await self.push(id, item)
        }
        backfills[id] = launch {
            let outcome: Result<BackfillOutcome, any Error>
            do {
                outcome = .success(try await c.backfill(b))
            } catch {
                outcome = .failure(Task.isCancelled ? HostError("backfill \(selector): aborted") : error)
            }
            self.post {
                self.backfills.removeValue(forKey: id)
                switch outcome {
                case .success(let o): try self.call("backfillSettled", id, o.rawValue, nil)
                case .failure(let e): try self.call("backfillSettled", id, nil, "\(e)")
                }
            }
        }
    }

    // one delivery, returning once the Engine has committed it
    private func push(_ backfill: Int, _ item: BackfillItem) async throws {
        let done = Deferred<Void>()
        let posted = post {
            let p = self.id()
            self.pushes[p] = done
            do {
                switch item {
                case .length(let n): try self.call("push", backfill, p, "length", n)
                case .header(let position, let seqs, let visible):
                    try self.call("push", backfill, p, "header", position, try encodeAny(seqs), visible)
                case .page(let page, let skip, let checksum):
                    try self.call("push", backfill, p, "page", page, skip, checksum)
                case .pagesDone: try self.call("push", backfill, p, "pagesDone")
                case .edits(let edits, let scanned): try self.call("push", backfill, p, "edits", edits, scanned)
                case .editsDone: try self.call("push", backfill, p, "editsDone")
                }
            } catch {
                self.pushes.removeValue(forKey: p)
                done.fail(error)
                throw error
            }
        }
        if !posted { throw closedError() }
        try await done.value()
    }

    // a send on a connection, settled however it ends
    private func send(_ conn: Int, _ id: Int, _ wire: [Any?]) throws {
        guard let c = connections[conn] else {
            try call("sendSettled", id, nil, "the connection has ended")
            return
        }
        let mutations = try wire.map { item in
            guard let m = item as? [Any?], m.count == 4, let mid = m[2] as? String, let data = m[3] as? [UInt8] else {
                throw HostError("send: a malformed mutation")
            }
            return Mutation(id: mid, series: m[0] as? String, n: m[1] as? Int, data: data)
        }
        launch {
            let outcome: Result<[MutationResult], any Error>
            do {
                outcome = .success(try await c.sendMutations(mutations))
            } catch {
                outcome = .failure(error)
            }
            self.post {
                switch outcome {
                case .success(let results):
                    var w = MsgWriter()
                    w.array(results.count)
                    for res in results {
                        w.array(2)
                        switch res {
                        case .ok(let position):
                            w.str("ok")
                            w.int(position)
                        case .reject(let reason):
                            w.str("reject")
                            w.str(reason)
                        case .conflict(let current):
                            w.str("conflict")
                            try w.any(current)
                        }
                    }
                    try self.call("sendSettled", id, w.bytes, nil)
                case .failure(let e):
                    try self.call("sendSettled", id, nil, "\(e)")
                }
            }
        }
    }

    /** Builds the bundle's Engine called name, syncing as the session or as anonymous, over an
        LMDB store in the directory store, or in memory without one, and through a transport of its
        own when given one.  The Engine boots on the engine thread, loading its store, before this
        returns.  A directory holds one Engine's store, and only while that Engine runs: a new
        Engine may open it only once the last one's close has completed, which closeAndJoin
        awaits. */
    public func createEngine(
        _ name: String,
        session: Session?,
        store: URL? = nil,
        transport: (any Transport)? = nil
    ) async throws -> HostedEngine {
        let id = try await onThread {
            if let store { try FileManager.default.createDirectory(at: store, withIntermediateDirectories: true) }
            let id = self.id()
            self.engines.insert(id)
            if let transport { self.transports[id] = transport }
            let s = session.map { s in
                let sid = self.id()
                self.sessions[sid] = s
                return sid
            }
            try self.call("createEngine", id, name, s, store?.path)
            return id
        }
        return HostedEngine(host: self, id: id)
    }

    func sendMutation(_ engine: Int, _ mutation: [UInt8]) throws {
        try request { try self.call("sendMutation", engine, mutation) }
    }

    func sendOnlineMutation(_ engine: Int, _ mutation: [UInt8]) async throws -> MutationResult {
        let done = Deferred<MutationResult>()
        try await onThread {
            let c = self.id()
            self.onlines[c] = done
            do {
                try self.call("sendOnlineMutation", engine, c, mutation)
            } catch {
                self.onlines.removeValue(forKey: c)
                throw error
            }
        }
        return try await done.value()
    }

    func reconnectNow(_ engine: Int) throws {
        try request { try self.call("reconnectNow", engine) }
    }

    func onEnded(_ engine: Int, _ fn: @escaping @Sendable (EngineEnded) -> Void) throws {
        do {
            try request {
                // an end that has already come is heard at once, the host's before the Engine's
                if let why = self.endedWhy.get() {
                    fn(EngineEnded(reason: why, auth: false))
                } else if let end = self.endings[engine] {
                    fn(end)
                } else {
                    self.ended[engine] = fn
                }
            }
        } catch {
            // a host that has ended tells a late listener why at once
            guard let why = endedWhy.get() else { throw error }
            fn(EngineEnded(reason: why, auth: false))
        }
    }

    // ends an Engine, completing done once its store is closed, by this or by the host's close
    func closeEngine(_ engine: Int, _ done: Deferred<Void>) {
        let posted = post {
            defer { done.complete() }
            self.engines.remove(engine)
            self.ended.removeValue(forKey: engine)
            self.endings.removeValue(forKey: engine)
            try self.call("closeEngine", engine)
            self.transports.removeValue(forKey: engine)
        }
        if !posted {
            Task {
                _ = try? await self.freed.value()
                done.complete()
            }
        }
    }

    /* A query's results as they come, each its msgpack; the query runs while the stream is
       iterated.  The stream keeps only the newest result: one that arrives while the iterating
       task is busy replaces the one still waiting, so a task that falls behind skips ahead.  An
       ejectable query is ejected while the app is in the background and keeps its stream, which
       resumes when the query is registered again. */
    func results(_ engine: Int, ejectable: Bool, _ start: @escaping (Int) -> [Any?]) -> AsyncThrowingStream<[UInt8], any Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { cont in
            let qid = Locked(0)
            let begin = {
                let q = self.id()
                qid.set(q)
                self.queries[q] = { r in
                    switch r {
                    case .success(let b): cont.yield(b)
                    case .failure(let e): cont.finish(throwing: e)
                    }
                }
                if ejectable { self.ejectables[q] = start }
                return (q, ejectable && self.ejected ? nil : start(q))
            }
            if !queue(QueryStart(begin: begin, fail: { cont.finish(throwing: $0) })) {
                cont.finish(throwing: closedError())
                return
            }
            cont.onTermination = { _ in
                self.post {
                    let q = qid.get()
                    self.ejectables.removeValue(forKey: q)
                    if q == 0 || self.queries.removeValue(forKey: q) == nil { return }
                    try self.call("closeQuery", q)
                }
            }
        }
    }

    /* A query's start, queued for the engine thread: begin registers the query there, answering
       its id and its request, or nil for a query that waits while the queries are ejected, and
       fail fails a query that never starts. */
    private struct QueryStart {
        let begin: () -> (Int, [Any?]?)
        let fail: (any Error) -> Void
    }

    // queues a query's start, answering false on a host that is closed or closing
    private func queue(_ start: QueryStart) -> Bool {
        if closing.get() { return false }
        let first = starting.with {
            $0.append(start)
            return $0.count == 1
        }

        // the first start queued posts the request for every start queued before it runs
        if first && !post({ try self.startQueued() }) {
            for s in starting.with({ q in defer { q = [] }; return q }) { s.fail(closedError()) }
        }
        return true
    }

    // starts every query queued, in one request, so the Engine's next run answers them together
    private func startQueued() throws {
        let starts = starting.with { q in
            defer { q = [] }
            return q
        }
        if handle == 0 {
            for s in starts { s.fail(closedError()) }
            return
        }

        // each query registered, and the requests of those that start now
        var ids: [Int] = []
        var requests: [Any?] = []
        for s in starts {
            let (q, request) = s.begin()
            ids.append(q)
            if let request { requests.append(request) }
        }
        if requests.isEmpty { return }

        // a request that fails whole fails every query it started
        do {
            try request("queries", [requests])
        } catch {
            for q in ids {
                ejectables.removeValue(forKey: q)
                queries.removeValue(forKey: q)?(.failure(error))
            }
            throw error
        }
    }

    /** Ejects every ejectable query, a LiveQuery's, which keeps its last result, as an app going to
        the background does.  A host that follows its app, as open's followsApp has it, is told
        this by the app. */
    public func enterBackground() {
        post {
            if self.ejected { return }
            self.ejected = true
            let closes: [Any?] = self.ejectables.keys.sorted().map { ["closeQuery", $0] }
            if !closes.isEmpty { try self.request("queries", [closes]) }
        }
    }

    /** Registers the ejected queries again, all in one request, so the Engine answers them
        together, and connects every Engine now rather than when its backoff timer fires, as an
        app returning to the foreground does. */
    public func enterForeground() {
        post {
            if self.ejected {
                self.ejected = false
                let starts: [Any?] = self.ejectables.sorted { $0.key < $1.key }.map { $0.value($0.key) }
                if !starts.isEmpty { try self.request("queries", [starts]) }
            }
            for e in self.engines.sorted() { try self.call("reconnectNow", e) }
        }
    }

    /** Ends every Engine's connection and connects again at once, as a change of the network the
        device is on calls for, since a connection over the last network may never hear that it
        has gone. */
    public func networkChanged() {
        post {
            for c in self.connections.values { c.abort() }
            for e in self.engines.sorted() { try self.call("reconnectNow", e) }
        }
    }

    /** Ends every Engine and frees the native host, closing every store, once the work already
        queued for the engine thread has run.  It returns at once; closeAndJoin waits. */
    public func close() {
        let was = closing.with {
            let was = $0
            $0 = true
            return was
        }
        if was { return }
        follower.with { f in
            f?.stop()
            f = nil
        }
        cancelAllWork()
        if !thread.post({ self.shutDown() }) { freed.complete() }
    }

    private func cancelAllWork() {
        for t in work.with({ Array($0.tasks.values) }) { t.cancel() }
    }

    /* The host's end, once a call into it ran past its limit, which the native host answered by
       aborting every store transaction; it runs no JS again.  Every Engine's onEnded hears why,
       the host closes as close closes it, and the call fails with why. */
    private func end(_ why: String) -> HostError {
        endedWhy.set(why)
        closing.set(true)
        cancelAllWork()

        // each Engine's end
        let ends = Array(ended.values)
        ended.removeAll()
        for fn in ends { fn(EngineEnded(reason: why, auth: false)) }

        // the close, at once
        shutDown()
        return HostError(why)
    }

    // the host's close on the engine thread, which both close and the host's end run, so a second
    // run is harmless
    private func shutDown() {
        // an @online mutation still waiting has no answer coming, and nor has a push
        for d in onlines.values { d.fail(closedError()) }
        onlines.removeAll()
        for d in pushes.values { d.fail(closedError()) }
        pushes.removeAll()

        // the runtime, and every store with it
        if handle != 0 { Native.close(handle) }
        handle = 0

        // the tables, whose connections hold hooks back to the host
        connections.removeAll()
        queries.removeAll()
        ejectables.removeAll()
        engines.removeAll()
        sessions.removeAll()
        transports.removeAll()
        thread.shutDown()
        freed.complete()
    }

    /** closes the host, waiting until the native host is freed and every store closed */
    public func closeAndJoin() async {
        close()
        _ = try? await freed.value()
    }

    /* A host that nothing holds has no work queued, since every job holds the host, so what is
       left is the runtime and the thread: the runtime is freed on the thread, which then stops.
       A host that closed already has neither. */
    deinit {
        let handle = handle
        let thread = thread
        let freed = freed
        if handle == 0 { return }
        thread.post {
            Native.close(handle)
            thread.shutDown()
            freed.complete()
        }
    }
}

/** What runs a model's declared queries: a call as msgpack under its queries' wire type, and each
    result as msgpack under the query's result type.  An ejectable query is a LiveQuery's, which
    its host ejects while the app is in the background.  Generated query types take one. */
public protocol QuerySource: Sendable {
    func query(_ call: [UInt8], ejectable: Bool) -> AsyncThrowingStream<[UInt8], any Error>
}

/** A query's results, each decoded into the model's types as the iterating task takes it.  The
    query runs while the results are iterated, and stops when the iteration ends: each iteration
    runs it afresh, so iterating the same results again, as a view that reappears does, starts the
    query again.  Making results runs nothing. */
public struct QueryResults<Element: Sendable>: AsyncSequence, Sendable {
    // a query of the call, ejectable or not
    private let start: @Sendable (Bool) -> AsyncThrowingStream<[UInt8], any Error>
    private let decode: @Sendable ([UInt8]) throws -> Element

    public init(
        _ source: any QuerySource,
        call: () throws -> [UInt8],
        decode: @escaping @Sendable ([UInt8]) throws -> Element
    ) {
        // the call's bytes once, and a query of them for each iteration
        switch Result(catching: call) {
        case .success(let bytes): start = { source.query(bytes, ejectable: $0) }
        case .failure(let error): start = { _ in AsyncThrowingStream { $0.finish(throwing: error) } }
        }
        self.decode = decode
    }

    init(
        _ start: @escaping @Sendable (Bool) -> AsyncThrowingStream<[UInt8], any Error>,
        decode: @escaping @Sendable ([UInt8]) throws -> Element
    ) {
        self.start = start
        self.decode = decode
    }

    /** each result made into another value, as a view that shows one part of a result wants */
    public func map<T: Sendable>(_ transform: @escaping @Sendable (Element) -> T) -> QueryResults<T> {
        let decode = decode
        return QueryResults<T>(start) { transform(try decode($0)) }
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        var inner: AsyncThrowingStream<[UInt8], any Error>.AsyncIterator
        let decode: @Sendable ([UInt8]) throws -> Element

        public mutating func next() async throws -> Element? {
            guard let b = try await inner.next() else { return nil }
            return try decode(b)
        }
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(inner: start(false).makeAsyncIterator(), decode: decode)
    }

    // one run of the query, started now rather than when it is iterated, which iterates once
    func started(ejectable: Bool) -> QueryResults<Element> {
        let stream = start(ejectable)
        return QueryResults({ _ in stream }, decode: decode)
    }
}

/** One Engine the host runs: its mutations and declared queries as msgpack under the model's
    types, which generated code converts.  Closing it ends it and closes its store, and so does
    letting go of it: an Engine that nothing holds any more closes as close closes it. */
public final class HostedEngine: QuerySource, @unchecked Sendable {
    private let host: EngineHost
    let id: Int
    // whether close has begun, and its completion once the store is closed
    private let closing = Locked(false)
    let closed = Deferred<Void>()

    init(host: EngineHost, id: Int) {
        self.host = host
        self.id = id
    }

    deinit {
        close()
    }

    /** a mutation for the outbox, as msgpack under the Engine's mutations union */
    public func sendMutation(_ mutation: [UInt8]) throws {
        try host.sendMutation(id, mutation)
    }

    /** an @online mutation, as msgpack under the mutations union, answered with its outcome */
    public func sendOnlineMutation(_ mutation: [UInt8]) async throws -> MutationResult {
        try await host.sendOnlineMutation(id, mutation)
    }

    /** each result of a declared query, its call as msgpack under the queries' wire type */
    public func query(_ call: [UInt8], ejectable: Bool) -> AsyncThrowingStream<[UInt8], any Error> {
        let id = id
        return host.results(id, ejectable: ejectable) { q in ["query", q, id, call] }
    }

    /** the Engine's status, each time it changes */
    public var status: QueryResults<EngineStatus> {
        // the results hold the Engine, as a declared query's do, so it runs while they are iterated
        QueryResults({ [self] ejectable in
            let id = id
            return host.results(id, ejectable: ejectable) { q in ["statusQuery", q, id] }
        }) { try engineStatus(try decodeAny($0)) }
    }

    /** connect now rather than when the backoff timer fires */
    public func reconnectNow() throws {
        try host.reconnectNow(id)
    }

    /** Calls fn, on the engine thread, if the Engine ends with an error, or when its host ends
        because a call into the runtime ran past the call limit (EngineLimits), which ends every
        Engine of the host with a reason naming the limit.  An Engine that has already ended calls
        fn with how it ended as soon as fn is given, on the caller's thread once the host has
        ended. */
    public func onEnded(_ fn: @escaping @Sendable (EngineEnded) -> Void) throws {
        try host.onEnded(id, fn)
    }

    /** ends the Engine and closes its store after the work already queued for it, returning at
        once */
    public func close() {
        let was = closing.with {
            let was = $0
            $0 = true
            return was
        }
        if !was { host.closeEngine(id, closed) }
    }

    /** closes the Engine, waiting until its store is closed */
    public func closeAndJoin() async {
        close()
        _ = try? await closed.value()
    }
}
