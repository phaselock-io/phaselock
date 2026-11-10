#if canImport(Darwin)
import Foundation
import Testing

@testable import PhaseLock

/* An origin in the URL loading system, one for each host name: its stream opens at position 40 of
   epoch e3 and stays open, its tail has nothing, and its snapshot is the bytes the test gave the
   host. */
private final class Origin: URLProtocol, @unchecked Sendable {
    // {host: the snapshot it serves}
    static let snapshots = Locked<[String: [UInt8]]>([:])

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let at = ["PhaseLock-Epoch": "e3", "PhaseLock-Position": "40"]
        func respond(_ headers: [String: String], _ body: [UInt8]?) {
            let r = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            guard let body else { return }
            client?.urlProtocol(self, didLoad: Data(body))
            client?.urlProtocolDidFinishLoading(self)
        }

        // the stream's headers, and a body that never ends; a tail that scanned to until at once;
        // and the host's snapshot
        let path = url.path
        if path.hasPrefix("/stream") {
            respond(at.merging(["Content-Type": "application/msgpack"]) { a, _ in a }, nil)
        } else if path.hasPrefix("/edits/") {
            let before = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "before" }!.value!
            respond(["Content-Type": "application/msgpack", "PhaseLock-Scanned": before], [])
        } else {
            let snapshot = Origin.snapshots.get()[url.host!]!
            respond(at.merging(["Content-Type": "application/octet-stream"]) { a, _ in a }, snapshot)
        }
    }

    override func stopLoading() {}
}

private struct Quiet: ConnectionHooks {
    func onOpen(epoch: String, head: Int) {}
    func onView(token: String, position: Int, selectors: [String]) {}
    func onEdits(_ edits: [UInt8]) {}
    func onLive(position: Int) {}
    func onVouch(position: Int) {}
    func onEnd(code: Int, reason: String, fatal: AuthError?) {}
}

// a blob's start: its magic and version, and a header of length hlen
private func start(_ hlen: UInt32) -> [UInt8] {
    Array("PLSN".utf8) + [1] + withUnsafeBytes(of: hlen.bigEndian) { Array($0) }
}

// a blob's start with a whole header for position 40 of epoch e3
private func headed() throws -> [UInt8] {
    let header = try encodeAny(["epoch": "e3", "position": 40, "visible": 40, "slices": [String: Int]()] as [String: Any?])
    return start(UInt32(header.count)) + header + withUnsafeBytes(of: crc32c(header).bigEndian) { Array($0) }
}

// the error a backfill of the snapshot fails with, from an origin of its own under host
private func failure(_ host: String, _ snapshot: [UInt8]) async throws -> String {
    Origin.snapshots.with { $0[host] = snapshot }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [Origin.self]
    let transport = HTTPTransport(url: URL(string: "http://\(host)")!, session: URLSession(configuration: config))
    let conn = transport.connect(since: -1, view: nil, wants: ["*"], session: nil, hooks: Quiet())
    defer { conn.abort() }
    do {
        _ = try await conn.backfill(Backfill(selector: "patron:*", until: 45, resume: nil) { _ in })
        return "no failure"
    } catch {
        return "\(error)"
    }
}

@Suite struct HttpTests {
    @Test(.timeLimit(.minutes(1)))
    func aHeaderLengthPastTheMostAHeaderHoldsFails() async throws {
        let msg = try await failure("header.test", start(0xffff_ffff) + Array("short".utf8))
        #expect(msg.contains("header too long"), "\(msg)")
    }

    @Test(.timeLimit(.minutes(1)))
    func anOperationLengthPastTheMostAnOperationHoldsFails() async throws {
        // a set whose key claims a str of 4 GiB
        let msg = try await failure("operation.test", try headed() + [0x00, 0xdb, 0xff, 0xff, 0xff, 0xff] + Array("short".utf8))
        #expect(msg.contains("corrupt operation"), "\(msg)")
    }
}
#endif
