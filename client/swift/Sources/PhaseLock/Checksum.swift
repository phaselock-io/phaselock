// The snapshot blob's checksums: CRC-32C per record and header, FNV-1a 64 over the records.

private let crcTable: [UInt32] = (0..<256).map { i in
    var c = UInt32(i)
    for _ in 0..<8 { c = c & 1 != 0 ? 0x82f6_3b78 ^ (c >> 1) : c >> 1 }
    return c
}

public func crc32c<C: Collection>(_ bytes: C) -> UInt32 where C.Element == UInt8 {
    var c: UInt32 = ~0
    for b in bytes { c = crcTable[Int((c ^ UInt32(b)) & 0xff)] ^ (c >> 8) }
    return ~c
}

/** FNV-1a 64, whose running state a resumed download continues from. */
public struct Fnv64: Sendable {
    private var h: UInt64

    public init() {
        h = 0xcbf2_9ce4_8422_2325
    }

    /** a hash continuing from a running state of 16 hex digits */
    public init?(state: String) {
        guard state.count == 16, state.allSatisfy(\.isHexDigit), state == state.lowercased(),
            let h = UInt64(state, radix: 16)
        else { return nil }
        self.h = h
    }

    public mutating func update<C: Collection>(_ bytes: C) where C.Element == UInt8 {
        for b in bytes {
            h ^= UInt64(b)
            h &*= 0x100_0000_01b3
        }
    }

    /** the running state as 16 hex digits, the digest so far */
    public var state: String {
        let s = String(h, radix: 16)
        return String(repeating: "0", count: 16 - s.count) + s
    }

    /** the big-endian digest */
    public var digest: [UInt8] {
        (0..<8).map { i in UInt8(truncatingIfNeeded: h >> (8 * UInt64(7 - i))) }
    }
}
