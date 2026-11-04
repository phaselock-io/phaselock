// Small concurrency pieces the host and the transport share: a value behind a lock, and a value
// that arrives once, which an async caller awaits.

import Foundation

/** A value guarded by a lock. */
final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T

    init(_ value: T) {
        self.value = value
    }

    func with<R>(_ fn: (inout T) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try fn(&value)
    }

    func get() -> T {
        with { $0 }
    }

    func set(_ v: T) {
        with { $0 = v }
    }
}

/** A result that arrives once, from any thread, which any number of tasks await; a task
    cancelled while it waits stops waiting with a CancellationError. */
final class Deferred<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<T, any Error>?
    private var waiters: [UInt64: CheckedContinuation<T, any Error>] = [:]
    private var next: UInt64 = 0

    init() {}

    var isDone: Bool {
        lock.lock()
        defer { lock.unlock() }
        return result != nil
    }

    /** settles the value, answering every waiter; only the first settle counts */
    func resolve(_ r: Result<T, any Error>) {
        lock.lock()
        if result != nil {
            lock.unlock()
            return
        }
        result = r
        let ws = waiters.values
        waiters.removeAll()
        lock.unlock()
        for w in ws { w.resume(with: r) }
    }

    func complete(_ v: T) {
        resolve(.success(v))
    }

    func fail(_ e: any Error) {
        resolve(.failure(e))
    }

    func value() async throws -> T {
        let id: UInt64 = lock.withLock {
            next += 1
            return next
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<T, any Error>) in
                lock.lock()
                if let result {
                    lock.unlock()
                    c.resume(with: result)
                } else if Task.isCancelled {
                    lock.unlock()
                    c.resume(throwing: CancellationError())
                } else {
                    waiters[id] = c
                    lock.unlock()
                }
            }
        } onCancel: {
            lock.lock()
            let w = waiters.removeValue(forKey: id)
            lock.unlock()
            w?.resume(throwing: CancellationError())
        }
    }
}

extension Deferred where T == Void {
    func complete() {
        resolve(.success(()))
    }
}
