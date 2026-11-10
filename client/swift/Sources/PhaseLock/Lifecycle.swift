// What a host follows of the app it runs in: on iOS, the app going to the background and
// returning, and on Apple's platforms, the network path changing.

import Foundation

#if canImport(UIKit)
import UIKit
#endif
#if canImport(Network)
import Network
#endif

/** The observers that tell a host what its app does.  They hold the host weakly, so a host that
    nothing else holds still closes, and stopping them, as the host's close does, ends them all. */
final class AppFollower: @unchecked Sendable {
    private let lock = NSLock()
    private var observers: [any NSObjectProtocol] = []
    #if canImport(Network)
    private var monitor: NWPathMonitor?
    #endif

    static func start(_ host: EngineHost) async -> AppFollower {
        let f = AppFollower()

        // the app going to the background and returning, whose names UIKit keeps on the main actor
        #if canImport(UIKit) && !os(watchOS)
        let (background, foreground) = await MainActor.run {
            (UIApplication.didEnterBackgroundNotification, UIApplication.willEnterForegroundNotification)
        }
        let center = NotificationCenter.default
        f.observers = [
            center.addObserver(forName: background, object: nil, queue: nil) { [weak host] _ in host?.enterBackground() },
            center.addObserver(forName: foreground, object: nil, queue: nil) { [weak host] _ in host?.enterForeground() },
        ]
        #endif

        /* The network path: the first update is the path the host starts on, and after it a path
           that is usable and differs from the last, in being usable at all or in its interfaces,
           is a change. */
        #if canImport(Network)
        let monitor = NWPathMonitor()
        let last = Locked<(usable: Bool, interfaces: [String])?>(nil)
        monitor.pathUpdateHandler = { [weak host] path in
            let now = (usable: path.status == .satisfied, interfaces: path.availableInterfaces.map(\.name))
            let before = last.with { l in
                defer { l = now }
                return l
            }
            guard let before, now.usable, before.usable != now.usable || before.interfaces != now.interfaces else { return }
            host?.networkChanged()
        }
        monitor.start(queue: DispatchQueue(label: "phaselock-network"))
        f.monitor = monitor
        #endif
        return f
    }

    func stop() {
        let observers = lock.withLock {
            defer { self.observers = [] }
            return self.observers
        }
        for o in observers { NotificationCenter.default.removeObserver(o) }
        #if canImport(Network)
        lock.withLock {
            defer { monitor = nil }
            return monitor
        }?.cancel()
        #endif
    }

    deinit {
        stop()
    }
}
