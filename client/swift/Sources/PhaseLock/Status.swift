// The Engine's status, as the skeleton's EngineStatus reports it, read from the plain value the
// native host's status query delivers.

import Foundation

public struct ConnectionStatus: Sendable, Equatable {
    public enum State: String, Sendable {
        case connecting, syncing, live, offline
    }

    public let state: State
    public let nextAttemptAt: Date?
    public let hasBase: Bool
    public let frozen: Bool
}

/** One backfill in flight: its snapshot in bytes, and its tail in log positions once the blob's
    header gives the cut. */
public struct BackfillStatus: Sendable, Equatable {
    public struct Tail: Sendable, Equatable {
        public let cut: Int
        public let scanned: Int
        public let until: Int
        public let done: Bool
    }

    public let selector: String
    public let snapshotBytes: Int
    public let snapshotLength: Int?
    public let snapshotDone: Bool
    public let tail: Tail?
    public let retryAt: Date?
}

/** How far syncing has come; estimate runs from 0 to 1 over the work in progress, and is nil
    when nothing is in progress. */
public struct ProgressStatus: Sendable, Equatable {
    public let estimate: Double?
    public let since: Int
    public let head: Int?
    public let committed: Int
    public let applied: Int
    public let backfills: [BackfillStatus]
}

/** the outbox: mutations the database has not acknowledged */
public struct OutboxStatus: Sendable, Equatable {
    public let unacknowledged: Int
}

public struct EngineStatus: Sendable, Equatable {
    public let connection: ConnectionStatus
    public let progress: ProgressStatus
    public let outbox: OutboxStatus
}

// the plain value's parts, which the status query always delivers whole
private func map(_ v: Any?) throws -> [String: Any?] {
    guard let m = v as? [String: Any?] else { throw HostError("status: expected a map") }
    return m
}

private func int(_ v: Any??) throws -> Int {
    guard let i = v as? Int else { throw HostError("status: expected an integer") }
    return i
}

private func date(_ v: Any??) -> Date? {
    (v as? Int).map { Date(timeIntervalSince1970: Double($0) / 1000) }
}

func engineStatus(_ v: Any?) throws -> EngineStatus {
    let m = try map(v)
    let c = try map(m["connection"] ?? nil)
    let p = try map(m["progress"] ?? nil)
    let log = try map(p["log"] ?? nil)
    let backfills = try (p["backfills"] as? [Any?] ?? []).map { b in
        let bm = try map(b)
        let snap = try map(bm["snapshot"] ?? nil)
        let tail = try (bm["tail"] as? [String: Any?]).map {
            BackfillStatus.Tail(
                cut: try int($0["cut"]),
                scanned: try int($0["scanned"]),
                until: try int($0["until"]),
                done: $0["done"] as? Bool ?? false
            )
        }
        return BackfillStatus(
            selector: bm["selector"] as? String ?? "",
            snapshotBytes: try int(snap["bytes"]),
            snapshotLength: snap["length"] as? Int,
            snapshotDone: snap["done"] as? Bool ?? false,
            tail: tail,
            retryAt: date(bm["retryAt"])
        )
    }
    return EngineStatus(
        connection: ConnectionStatus(
            state: ConnectionStatus.State(rawValue: c["state"] as? String ?? "") ?? .offline,
            nextAttemptAt: date(c["nextAttemptAt"]),
            hasBase: c["hasBase"] as? Bool ?? false,
            frozen: c["frozen"] as? Bool ?? false
        ),
        progress: ProgressStatus(
            estimate: (p["estimate"] as? Double) ?? (p["estimate"] as? Int).map(Double.init),
            since: try int(log["since"]),
            head: log["head"] as? Int,
            committed: try int(log["committed"]),
            applied: try int(log["applied"]),
            backfills: backfills
        ),
        outbox: OutboxStatus(unacknowledged: try int(try map(m["outbox"] ?? nil)["unacknowledged"]))
    )
}
