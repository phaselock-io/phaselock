// Sessions: who a request speaks for, as a token the database signed at login.

import Foundation

/** The database refused a login, or refused a session: its token was revoked, its account is
    gone, or it expired.  A session the database refused is ended for good, and the app signs in
    again. */
public struct AuthError: Error, CustomStringConvertible {
    public let status: Int
    public let description: String

    public init(status: Int, _ message: String) {
        self.status = status
        description = message
    }
}

/** A signed-in user: the token the database signed, the user it names, and its expiry in seconds
    since the epoch.  A transport refreshes a session in place as it uses one, calling onRefresh
    after, which is the app's cue to save the new token; and sets ended once the database refuses
    it.  HTTPTransport.login and Session.restore make them. */
public final class Session: @unchecked Sendable {
    private struct State {
        var token: String
        var exp: Int
        var ended = false
        var onRefresh: (@Sendable (Session) -> Void)?
    }

    public let user: String
    private let state: Locked<State>

    init(token: String) throws {
        let c = try claims(token)
        user = c.sub
        state = Locked(State(token: token, exp: c.exp))
    }

    /** a session from a token the app saved, without asking the database; refreshing it is what
        checks that the database still honors it */
    public static func restore(_ token: String) throws -> Session {
        try Session(token: token)
    }

    public var token: String { state.get().token }
    public var exp: Int { state.get().exp }
    public var ended: Bool { state.get().ended }

    public var onRefresh: (@Sendable (Session) -> Void)? {
        get { state.get().onRefresh }
        set { state.with { $0.onRefresh = newValue } }
    }

    // the token a refresh answered, in place of the last
    func refreshed(_ token: String) throws {
        let c = try claims(token)
        state.with {
            $0.token = token
            $0.exp = c.exp
        }
    }

    func end() {
        state.with { $0.ended = true }
    }
}

/** a token's claims, read without verifying it, which only the database does */
struct Claims {
    let sub: String
    let iat: Int
    let exp: Int
}

func claims(_ token: String) throws -> Claims {
    let notToken = ConvertError(description: "not a session token")
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count > 1 else { throw notToken }

    // the payload, base64url without padding
    var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
    guard let data = Data(base64Encoded: b64),
        let c = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let sub = c["sub"] as? String,
        let iat = (c["iat"] as? NSNumber)?.intValue,
        let exp = (c["exp"] as? NSNumber)?.intValue
    else { throw notToken }
    return Claims(sub: sub, iat: iat, exp: exp)
}
