import Foundation
import Testing

@testable import PhaseLock

// a native bundle of one Engine, which runs forever when asked to reconnect
private let spinner = Array(
    """
    globalThis.__engines = {
      Spinner: { create: () => ({ reconnectNow() { for (;;) {} } }) },
    };
    """.utf8
)

/* A native bundle of two Engines: an Ender, which ends as it is created, and a Faulty, which
   when asked to reconnect raises an event that is too short, then one that fails, then its end. */
private let faults = Array(
    """
    globalThis.__engines = {
      Ender: { create: (_transport, o) => { o.onError(new Error('gone')); return {}; } },
      Faulty: {
        create: (_transport, o) => ({
          reconnectNow() {
            __pl.emit(['connect', 1, 2, 0]);
            __pl.emit(['queryResult', 1]);
            o.onError(new Error('gone'));
          },
        }),
      },
    };
    """.utf8
)

// a transport no Engine connects through
struct Nowhere: Transport {
    struct Refused: Connection {
        func backfill(_ b: Backfill) async throws -> BackfillOutcome { throw HostError("nowhere") }
        func sendMutations(_ mutations: [Mutation]) async throws -> [MutationResult] { throw HostError("nowhere") }
        func abort() {}
    }

    func connect(since: Int, view: String?, wants: [String], session: Session?, hooks: any ConnectionHooks) -> any Connection {
        Refused()
    }

    func post(_ mutations: [Mutation], session: Session?) async throws -> [MutationResult] {
        throw HostError("nowhere")
    }
}

@Suite struct HostTests {
    @Test(.timeLimit(.minutes(1)))
    func aCallPastItsLimitEndsEveryEngineAndTheHost() async throws {
        let host = try await EngineHost.open(
            bundle: spinner,
            bundleName: "spinner.js",
            transport: Nowhere(),
            limits: EngineLimits(callTimeout: .milliseconds(200))
        )
        var engines: [HostedEngine] = []
        for _ in 0..<2 { engines.append(try await host.createEngine("Spinner", session: nil)) }
        let ends = Locked<[EngineEnded]>([])
        let heard = Deferred<Void>()
        for e in engines {
            try e.onEnded { end in
                let n = ends.with {
                    $0.append(end)
                    return $0.count
                }
                if n == 2 { heard.complete() }
            }
        }

        // one Engine's call runs away, and every Engine hears why, with the JS's backtrace
        try engines[0].reconnectNow()
        try await heard.value()
        for e in ends.get() {
            #expect(e.reason.hasPrefix("the call ran past its limit of 200ms: InternalError: interrupted\n"), "\(e.reason)")
            #expect(e.reason.contains("at reconnectNow"), "\(e.reason)")
            #expect(!e.auth)
        }
        #expect(ends.get().count == 2)

        // a listener given after the end hears it at once
        let late = Locked<EngineEnded?>(nil)
        try engines[1].onEnded { late.set($0) }
        #expect(late.get()?.reason.hasPrefix("the call ran past its limit of 200ms") == true, "\(String(describing: late.get()))")

        // the host has closed itself: its Engines' closes complete, and a call fails with why
        for e in engines { await e.closeAndJoin() }
        await host.closeAndJoin()
        do {
            _ = try await host.createEngine("Spinner", session: nil)
            Issue.record("a closed host created an engine")
        } catch let e as HostError {
            #expect(e.description.hasPrefix("the engine host has ended: the call ran past its limit"), "\(e)")
        }
    }

    // an Engine that ends before anyone listens is heard by the first listener
    @Test func anEndBeforeOnEndedIsHeard() async throws {
        let host = try await EngineHost.open(bundle: faults, bundleName: "faults.js", transport: Nowhere())
        let e = try await host.createEngine("Ender", session: nil)
        let ends = Locked<[EngineEnded]>([])
        try e.onEnded { end in ends.with { $0.append(end) } }

        // a round trip through the engine thread, after which the listener has been called
        _ = try await host.createEngine("Ender", session: nil)
        #expect(ends.get().count == 1)
        #expect(ends.get().first?.reason.hasPrefix("Error: gone") == true, "\(ends.get())")
        await host.closeAndJoin()
    }

    // a call's events are each acted on, past one too short to read and one that fails
    @Test func everyEventOfACallIsActedOn() async throws {
        let logs = Locked<[String]>([])
        let host = try await EngineHost.open(bundle: faults, bundleName: "faults.js", transport: Nowhere()) { line in
            logs.with { $0.append(line) }
        }
        let e = try await host.createEngine("Faulty", session: nil)
        let ends = Locked<[EngineEnded]>([])
        try e.onEnded { end in ends.with { $0.append(end) } }
        try e.reconnectNow()

        // a round trip through the engine thread, after which the reconnect's events have been
        // acted on
        _ = try await host.createEngine("Faulty", session: nil)
        #expect(ends.get().first?.reason.hasPrefix("Error: gone") == true, "\(ends.get())")
        #expect(logs.get().contains { $0.contains("queryResult: no bytes") }, "\(logs.get())")
        await host.closeAndJoin()
    }

    // an Engine that nothing holds closes, and its host runs on
    @Test(.timeLimit(.minutes(1)))
    func anEngineNothingHoldsCloses() async throws {
        let host = try await EngineHost.open(bundle: spinner, bundleName: "spinner.js", transport: Nowhere())
        var engine: HostedEngine? = try await host.createEngine("Spinner", session: nil)
        let closed = engine!.closed
        engine = nil
        try await closed.value()
        _ = try await host.createEngine("Spinner", session: nil)
        await host.closeAndJoin()
    }

    // a host that nothing holds, nor any Engine of it, frees its runtime and stops its thread
    @Test(.timeLimit(.minutes(1)))
    func aHostNothingHoldsCloses() async throws {
        var host: EngineHost? = try await EngineHost.open(bundle: spinner, bundleName: "spinner.js", transport: Nowhere())
        var engine: HostedEngine? = try await host!.createEngine("Spinner", session: nil)
        let freed = host!.freed
        #expect(engine != nil)
        engine = nil
        host = nil
        try await freed.value()
    }

    @Test func aBundleThatFailsToLoadFailsTheOpen() async throws {
        do {
            _ = try await EngineHost.open(bundle: Array("throw new Error('no')".utf8), bundleName: "bad.js", transport: Nowhere())
            Issue.record("a bad bundle opened")
        } catch let e as HostError {
            #expect(e.description.contains("no"), "\(e)")
        }
    }
}

// a query source that counts the queries it runs, each answering its call's bytes once
private struct Counting: QuerySource {
    let runs = Locked(0)

    func query(_ call: [UInt8], ejectable: Bool) -> AsyncThrowingStream<[UInt8], any Error> {
        runs.with { $0 += 1 }
        return AsyncThrowingStream { c in
            c.yield(call)
            c.finish()
        }
    }
}

@Suite struct QueryResultsTests {
    /* Results run their query when they are iterated, afresh each time, as a SwiftUI task that
       restarts when its view reappears iterates them again; making them runs nothing. */
    @Test func eachIterationRunsTheQueryAfresh() async throws {
        let source = Counting()
        let results = QueryResults(source, call: { [1, 2] }) { $0 }
        #expect(source.runs.get() == 0)
        for pass in 1...2 {
            var got: [[UInt8]] = []
            for try await r in results { got.append(r) }
            #expect(got == [[1, 2]], "pass \(pass)")
        }
        #expect(source.runs.get() == 2)
    }
}
