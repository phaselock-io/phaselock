// A query's latest result, kept for a UI, which reads it as observable state.

import Observation

/** A query's latest result as observable state: a SwiftUI view, or anything else that tracks
    observation, reads value and redraws when a new result arrives.  The query starts the first
    time value, isLoaded, or error is read, and stops when the LiveQuery is let go of.  So a view
    may make one as a @State's initial value, which SwiftUI makes again each time it rebuilds the
    view and keeps only the first of: the ones it drops are never read and run nothing.  While the
    app is in the background the host ejects the query, which keeps its last result, and when the
    app returns it registers the query again together with every other LiveQuery of the host.
    A result equal to the one shown, for a value that is Equatable, changes nothing. */
@MainActor @Observable
public final class LiveQuery<Value: Sendable> {
    private var latest: Value
    private var loaded = false
    private var failure: (any Error)?
    @ObservationIgnored private let results: QueryResults<Value>
    @ObservationIgnored private var task: Task<Void, Never>?

    /** the query's results, with what value is until the first arrives */
    public init(_ results: QueryResults<Value>, initial: Value) {
        self.results = results
        latest = initial
    }

    /** the latest result, or the initial value until one arrives */
    public var value: Value {
        start()
        return latest
    }

    /** whether a result has arrived */
    public var isLoaded: Bool {
        start()
        return loaded
    }

    /** why the query failed, which ends it; value keeps its last result */
    public var error: (any Error)? {
        start()
        return failure
    }

    /* The query, the first time it is wanted.  It is queued for the engine thread here rather
       than in the task, so the LiveQueries a view reads in one pass queue together.  The task
       holds the LiveQuery weakly, so letting go of it ends the task, and with the task the
       query. */
    private func start() {
        if task != nil { return }
        let results = results.started(ejectable: true)
        task = Task { [weak self] in
            do {
                for try await v in results {
                    guard let self else { return }
                    if self.loaded && same(self.latest, v) { continue }
                    self.latest = v
                    self.loaded = true
                }
            } catch {
                self?.failure = error
            }
        }
    }

    deinit {
        task?.cancel()
    }
}

extension LiveQuery where Value: ExpressibleByNilLiteral {
    /** the results of a query whose result may be nil, with value nil until the first arrives */
    public convenience init(_ results: QueryResults<Value>) {
        self.init(results, initial: nil)
    }
}

extension LiveQuery {
    /** the results of a query, with value nil until the first arrives */
    public convenience init<Result>(_ results: QueryResults<Result>) where Value == Result? {
        self.init(results.map { $0 }, initial: nil)
    }
}

// whether two values are equal, for a type that is Equatable; values of any other type never are
private func same<T>(_ a: T, _ b: T) -> Bool {
    guard let a = a as? any Equatable else { return false }
    return a.isEqual(to: b)
}

extension Equatable {
    fileprivate func isEqual(to other: Any) -> Bool {
        (other as? Self) == self
    }
}
