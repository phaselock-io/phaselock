// Mutation ids: a uuid string in the Engine and in app code, its 16 bytes on the wire.

import Foundation

/** the 16 bytes of a uuid written as 32 hex digits, dashed or not, in either case */
public func uuidBytes(_ id: String) throws -> [UInt8] {
    let hex = Array(id.replacingOccurrences(of: "-", with: "").utf8)
    guard hex.count == 32, hex.allSatisfy({ Character(UnicodeScalar($0)).isHexDigit }) else {
        throw ConvertError(description: "mutation id is not a uuid: \(id)")
    }
    return (0..<16).map { i in UInt8(String(decoding: hex[2 * i..<2 * i + 2], as: UTF8.self), radix: 16)! }
}

/** a fresh version 4 uuid, lower-case */
public func generateUuid() -> String {
    UUID().uuidString.lowercased()
}
