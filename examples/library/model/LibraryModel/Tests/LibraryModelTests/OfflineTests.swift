import Foundation
import Testing

@testable import LibraryModel
@testable import PhaseLock

// the model's development bundle, beside this package
private let bundlePath = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("native.dev.bundle.js")

// a transport whose every connection ends at once, as a device with no network sees it
private struct Offline: Transport {
    struct Dropped: Connection {
        func backfill(_ b: Backfill) async throws -> BackfillOutcome { throw HostError("offline") }
        func sendMutations(_ mutations: [Mutation]) async throws -> [MutationResult] { throw HostError("offline") }
        func abort() {}
    }

    func connect(since: Int, view: String?, wants: [String], session: Session?, hooks: any ConnectionHooks) -> any Connection {
        hooks.onEnd(code: 0, reason: "offline", fatal: nil)
        return Dropped()
    }

    func post(_ mutations: [Mutation], session: Session?) async throws -> [MutationResult] {
        throw HostError("offline")
    }
}

/** The library's Engines in the Swift host with no database: an Engine boots over its store and
    reports its status, though a first boot has no base for other queries to answer from. */
@Suite struct OfflineTests {
    @Test(.timeLimit(.minutes(1)))
    func anEngineBootsAndReportsItsStatusOffline() async throws {
        let bundle = try [UInt8](Data(contentsOf: bundlePath))
        let host = try await EngineHost.open(bundle: bundle, bundleName: "native.dev.bundle.js", transport: Offline())
        let store = FileManager.default.temporaryDirectory.appendingPathComponent("library-\(generateUuid())")
        defer { try? FileManager.default.removeItem(at: store) }

        // an Engine over an LMDB store, with nothing synced and nothing in its outbox
        let engine = try await UserEngine.open(host: host, session: nil, store: store)
        for try await status in engine.status {
            #expect(!status.connection.hasBase)
            #expect(status.connection.state != .live)
            #expect(status.outbox.unacknowledged == 0)
            break
        }

        await engine.closeAndJoin()
        await host.closeAndJoin()
    }
}
