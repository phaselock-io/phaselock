import Foundation
import Testing

@testable import PhaseLock

/* A native bundle of two Engines.  A Batcher's queries run as the skeleton's do: a new query
   waits for the Engine's next run, which a timer schedules, and each run answers every query that
   waited for it with the run's number and how many queries are open.  A Linked connects as it is
   created, and logs each reconnect and the end of its connection. */
private let engines = Array(
    """
    globalThis.__engines = {
      Batcher: {
        create: () => {
          const waiting = [];
          const open = new Set();
          let runs = 0;
          let scheduled = false;
          const run = () => {
            scheduled = false;
            runs += 1;
            for (const q of waiting.splice(0)) q.cb({ run: runs, open: open.size });
          };
          return {
            newQuery: () => ({
              subscribe(cb) {
                this.cb = cb;
                open.add(this);
                waiting.push(this);
                if (!scheduled) {
                  scheduled = true;
                  setTimeout(run, 0);
                }
              },
              close() {
                open.delete(this);
              },
            }),
            reconnectNow() {},
          };
        },
      },
      Linked: {
        create: (transport) => {
          const hooks = {
            onOpen() {},
            onView() {},
            onEdits() {},
            onLive() {},
            onVouch() {},
            onEnd(_code, reason) {
              console.log(`ended ${reason}`);
            },
          };
          transport.connect(0, null, [], new AbortController().signal, hooks, null);
          return { reconnectNow: () => console.log('reconnect') };
        },
      },
    };
    """.utf8
)

// a Batcher's answer
private struct Run: Sendable, Equatable {
    let run: Int
    let open: Int
}

// a transport whose connections count their aborts, each ending as an aborted connection does
private final class Lines: Transport, @unchecked Sendable {
    let aborts = Locked(0)

    struct Line: Connection {
        let lines: Lines
        let hooks: any ConnectionHooks

        func backfill(_ b: Backfill) async throws -> BackfillOutcome { throw HostError("no backfills") }
        func sendMutations(_ mutations: [Mutation]) async throws -> [MutationResult] { throw HostError("no sends") }
        func abort() {
            lines.aborts.with { $0 += 1 }
            hooks.onEnd(code: 0, reason: "aborted", fatal: nil)
        }
    }

    func connect(since: Int, view: String?, wants: [String], session: Session?, hooks: any ConnectionHooks) -> any Connection {
        Line(lines: self, hooks: hooks)
    }

    func post(_ mutations: [Mutation], session: Session?) async throws -> [MutationResult] {
        throw HostError("no posts")
    }
}

// a Batcher's query, ejectable or not, decoded
private func runs(_ host: EngineHost, _ engine: HostedEngine) -> QueryResults<Run> {
    QueryResults({ ejectable in
        host.results(engine.id, ejectable: ejectable) { q in ["statusQuery", q, engine.id] }
    }) { bytes in
        let m = try decodeAny(bytes) as? [String: Any?] ?? [:]
        return Run(run: m["run"] as? Int ?? -1, open: m["open"] as? Int ?? -1)
    }
}

// waits, on the main actor, until ok holds
@MainActor
private func until(_ what: String, _ ok: () -> Bool) async throws {
    for _ in 0..<500 {
        if ok() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("never: \(what)")
}

// a query source whose queries each answer one result and then wait, counting the queries that
// started and the ones that stopped
private final class Holding: QuerySource, @unchecked Sendable {
    let started = Locked(0)
    let stopped = Locked(0)
    let answer: [UInt8]

    init(_ answer: [UInt8]) {
        self.answer = answer
    }

    func query(_ call: [UInt8], ejectable: Bool) -> AsyncThrowingStream<[UInt8], any Error> {
        started.with { $0 += 1 }
        return AsyncThrowingStream { c in
            c.yield(answer)
            c.onTermination = { _ in self.stopped.with { $0 += 1 } }
        }
    }
}

@MainActor @Suite struct LiveQueryTests {
    // a LiveQuery runs its query once it is read, and stops it once it is let go of
    @Test(.timeLimit(.minutes(1)))
    func aLiveQueryRunsFromItsFirstReadUntilItIsLetGo() async throws {
        let source = Holding([7])
        var q: LiveQuery<[UInt8]>? = LiveQuery(QueryResults(source, call: { [] }) { $0 }, initial: [])
        #expect(source.started.get() == 0)
        #expect(q!.value == [])
        try await until("the result arrives") { q!.isLoaded }
        #expect(q!.value == [7])
        #expect(source.started.get() == 1)
        q = nil
        try await until("the query stops") { source.stopped.get() == 1 }
    }

    // a LiveQuery made and never read, as SwiftUI makes and drops a view's @State values, runs
    // nothing
    @Test func aLiveQueryNeverReadRunsNothing() async throws {
        let source = Holding([7])
        for _ in 0..<3 { _ = LiveQuery(QueryResults(source, call: { [] }) { $0 }, initial: []) }
        try await Task.sleep(for: .milliseconds(50))
        #expect(source.started.get() == 0)
    }

    // a query whose result may be nil is nil until it loads, with no optional inside an optional,
    // and a query whose result may not is too
    @Test func aLiveQueryOfAnOptionalIsOneOptional() async throws {
        let source = Holding([7])
        let maybe = LiveQuery(QueryResults(source, call: { [] }) { $0.first == 7 ? nil : 1 } as QueryResults<Int?>)
        #expect(type(of: maybe.value) == Int?.self)
        try await until("the nil result arrives") { maybe.isLoaded }
        #expect(maybe.value == nil)
        let some = LiveQuery(QueryResults(source, call: { [] }) { Int($0[0]) })
        #expect(type(of: some.value) == Int?.self)
        try await until("the result arrives") { some.isLoaded }
        #expect(some.value == 7)
    }

    /* The host's LiveQueries are ejected in the background, keeping their results, and when the
       app returns they are registered again in one request, which the Engine answers in one
       run.  A query that is not a LiveQuery's runs throughout. */
    @Test(.timeLimit(.minutes(1)))
    func liveQueriesLeaveInTheBackgroundAndReturnTogether() async throws {
        let host = try await EngineHost.open(bundle: engines, bundleName: "engines.js", transport: Nowhere(), followsApp: false)
        let engine = try await host.createEngine("Batcher", session: nil)
        let live = (0..<3).map { _ in LiveQuery(runs(host, engine)) }
        for q in live { _ = q.value }
        try await until("every LiveQuery loads") { live.allSatisfy(\.isLoaded) }

        // in the background, a query that is not ejectable finds itself the only one open
        host.enterBackground()
        var other = runs(host, engine).makeAsyncIterator()
        #expect(try await other.next() == Run(run: (live.map { $0.value!.run }.max() ?? 0) + 1, open: 1))
        let before = live.map(\.value)

        // back in the foreground, the three return in one run, with the other open beside them
        host.enterForeground()
        try await until("every LiveQuery hears again") { zip(live, before).allSatisfy { $0.value != $1 } }
        let after = Set(live.map { $0.value!.run })
        #expect(after.count == 1, "\(live.map(\.value))")
        #expect(live.allSatisfy { $0.value!.open == 4 }, "\(live.map(\.value))")
        _ = other
        await host.closeAndJoin()
    }

    // returning to the foreground reconnects every Engine, and a network change ends each
    // Engine's connection and reconnects it
    @Test(.timeLimit(.minutes(1)))
    func theForegroundAndANetworkChangeReconnect() async throws {
        let logs = Locked<[String]>([])
        let lines = Lines()
        let host = try await EngineHost.open(bundle: engines, bundleName: "engines.js", transport: lines, followsApp: false) { line in
            logs.with { $0.append(line) }
        }
        var held: [HostedEngine] = []
        for _ in 0..<2 { held.append(try await host.createEngine("Linked", session: nil)) }

        host.enterForeground()
        try await until("both reconnect") { logs.get().filter { $0 == "reconnect" }.count == 2 }

        host.networkChanged()
        try await until("both reconnect again") { logs.get().filter { $0 == "reconnect" }.count == 4 }
        try await until("both connections end") { logs.get().filter { $0 == "ended aborted" }.count == 2 }
        #expect(lines.aborts.get() == 2)
        _ = held
        await host.closeAndJoin()
    }
}
