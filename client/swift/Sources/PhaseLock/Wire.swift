// The transport contract, as the skeleton states it, in Swift: what a connection delivers to the
// Engine, what it fetches for a backfill, and what it sends.  A Promise there is an async function
// here, and a cancelled task is an aborted call.

/** A mutation as it travels: the id it carries through the log, the series and number the
    database dedups it by (both nil for an unnumbered one), and its wire bytes. */
public struct Mutation: Sendable {
    public let id: String
    public let series: String?
    public let n: Int?
    public let data: [UInt8]

    public init(id: String, series: String?, n: Int?, data: [UInt8]) {
        self.id = id
        self.series = series
        self.n = n
        self.data = data
    }
}

/** What the database answers for a mutation.  Ok means it was decided at or before position, so
    a client that has applied that far can read the outcome from its state. */
public enum MutationResult: Sendable, Equatable {
    case ok(position: Int)
    case reject(reason: String)
    case conflict(current: [String: Int])
}

/** What an earlier attempt at a backfill got through, as the skeleton's Backfill.resume. */
public struct Resume: Sendable, Equatable {
    public let position: Int
    public let visible: Int
    public let skipBytes: Int
    public let checksum: String
    public let fromPosition: Int
    public let snapshotDone: Bool
    public let tailDone: Bool
}

/** One delivery of a backfill, as the skeleton's BackfillItem.  Edits are a msgpack array of raw
    edits, as a frame carries them. */
public enum BackfillItem: Sendable {
    case length(Int)
    case header(position: Int, seqs: [String: Int], visible: Int)
    case page([UInt8], skip: Int, checksum: String)
    case pagesDone
    case edits([UInt8], scanned: Int)
    case editsDone
}

public enum BackfillOutcome: String, Sendable {
    case done
    case stale
}

/** One backfill call: the selector, the tail's exclusive upper bound, what an earlier attempt got
    through, and push, which returns once the Engine has committed the delivery. */
public struct Backfill: Sendable {
    public let selector: String
    public let until: Int
    public let resume: Resume?
    public let push: @Sendable (BackfillItem) async throws -> Void
}

/** What a connection delivers to the Engine, in order, from any thread. */
public protocol ConnectionHooks: Sendable {
    func onOpen(epoch: String, head: Int)
    func onView(token: String, position: Int, selectors: [String])

    /** a frame's edits: the msgpack array of raw edits it carries */
    func onEdits(_ edits: [UInt8])
    func onLive(position: Int)
    func onVouch(position: Int)

    /** the one end of the connection; fatal is a refused session, which ends the Engine */
    func onEnd(code: Int, reason: String, fatal: AuthError?)
}

/** One connection: the live stream, and the backfills and sends that ride on it.  Calls to
    sendMutations apply in call order; one that fails also fails every call behind it, unsent,
    and ends the connection. */
public protocol Connection: Sendable {
    func backfill(_ b: Backfill) async throws -> BackfillOutcome
    func sendMutations(_ mutations: [Mutation]) async throws -> [MutationResult]

    /** ends the connection, which ends with onEnd if it has not ended already */
    func abort()
}

/** How an Engine reaches its database. */
public protocol Transport: Sendable {
    func connect(
        since: Int,
        view: String?,
        wants: [String],
        session: Session?,
        hooks: any ConnectionHooks
    ) -> any Connection

    /** mutations outside any connection, as the session or as anonymous */
    func post(_ mutations: [Mutation], session: Session?) async throws -> [MutationResult]
}
