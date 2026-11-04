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

// a transport the Spinner never uses
private struct Nowhere: Transport {
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

    @Test func aBundleThatFailsToLoadFailsTheOpen() async throws {
        do {
            _ = try await EngineHost.open(bundle: Array("throw new Error('no')".utf8), bundleName: "bad.js", transport: Nowhere())
            Issue.record("a bad bundle opened")
        } catch let e as HostError {
            #expect(e.description.contains("no"), "\(e)")
        }
    }
}
