// Msgpack: a writer that picks the smallest encoding of every integer, string, and container, so
// the bytes it writes are the encoding every PhaseLock host writes, and a pull reader over bytes.
// A timestamp is the msgpack timestamp extension, type -1.

import Foundation

/** the msgpack timestamp extension's type */
let extTimestamp: Int8 = -1

/** A msgpack writer over a growable buffer. */
public struct MsgWriter {
    public private(set) var bytes: [UInt8] = []

    public init() {}

    private mutating func byte(_ b: UInt8) {
        bytes.append(b)
    }

    private mutating func be(_ v: UInt64, _ n: Int) {
        for i in stride(from: n - 1, through: 0, by: -1) { bytes.append(UInt8(truncatingIfNeeded: v >> (8 * UInt64(i)))) }
    }

    public mutating func nil_() {
        byte(0xc0)
    }

    public mutating func bool(_ b: Bool) {
        byte(b ? 0xc3 : 0xc2)
    }

    public mutating func int(_ v: Int) {
        let u = UInt64(bitPattern: Int64(v))
        switch v {
        case 0...: uint(UInt64(v))
        case (-32)...: byte(UInt8(truncatingIfNeeded: v))
        case Int(Int8.min)...: byte(0xd0); be(u, 1)
        case Int(Int16.min)...: byte(0xd1); be(u, 2)
        case Int(Int32.min)...: byte(0xd2); be(u, 4)
        default: byte(0xd3); be(u, 8)
        }
    }

    private mutating func uint(_ v: UInt64) {
        switch v {
        case ..<0x80: byte(UInt8(v))
        case ..<0x100: byte(0xcc); be(v, 1)
        case ..<0x10000: byte(0xcd); be(v, 2)
        case ..<0x1_0000_0000: byte(0xce); be(v, 4)
        default: byte(0xcf); be(v, 8)
        }
    }

    public mutating func double(_ d: Double) {
        byte(0xcb)
        be(d.bitPattern, 8)
    }

    public mutating func str(_ s: String) {
        str(utf8: Array(s.utf8))
    }

    /** a string given as its UTF-8 bytes */
    public mutating func str(utf8 b: [UInt8]) {
        let n = UInt64(b.count)
        switch n {
        case ..<32: byte(0xa0 | UInt8(n))
        case ..<0x100: byte(0xd9); be(n, 1)
        case ..<0x10000: byte(0xda); be(n, 2)
        default: byte(0xdb); be(n, 4)
        }
        bytes.append(contentsOf: b)
    }

    public mutating func bin(_ b: [UInt8]) {
        let n = UInt64(b.count)
        switch n {
        case ..<0x100: byte(0xc4); be(n, 1)
        case ..<0x10000: byte(0xc5); be(n, 2)
        default: byte(0xc6); be(n, 4)
        }
        bytes.append(contentsOf: b)
    }

    /** a timestamp in the smallest of the extension's three sizes */
    public mutating func timestamp(seconds sec: Int64, nanoseconds nsec: UInt32) {
        if nsec == 0 && sec >= 0 && sec <= 0xffff_ffff {
            byte(0xd6); byte(0xff); be(UInt64(sec), 4)
        } else if sec >= 0 && sec <= 0x3_ffff_ffff {
            byte(0xd7); byte(0xff); be((UInt64(nsec) << 34) | UInt64(sec), 8)
        } else {
            byte(0xc7); byte(12); byte(0xff); be(UInt64(nsec), 4); be(UInt64(bitPattern: sec), 8)
        }
    }

    /** a date at millisecond precision, as every host writes one */
    public mutating func date(_ d: Date) {
        let ms = epochMillis(d)
        let sec = ms >= 0 ? ms / 1000 : (ms - 999) / 1000
        timestamp(seconds: sec, nanoseconds: UInt32((ms - sec * 1000) * 1_000_000))
    }

    public mutating func array(_ n: Int) {
        switch n {
        case ..<16: byte(0x90 | UInt8(n))
        case ..<0x10000: byte(0xdc); be(UInt64(n), 2)
        default: byte(0xdd); be(UInt64(n), 4)
        }
    }

    public mutating func map(_ n: Int) {
        switch n {
        case ..<16: byte(0x80 | UInt8(n))
        case ..<0x10000: byte(0xde); be(UInt64(n), 2)
        default: byte(0xdf); be(UInt64(n), 4)
        }
    }

    /** bytes that are already msgpack, as they are */
    public mutating func raw(_ b: [UInt8]) {
        bytes.append(contentsOf: b)
    }

    /** A plain value: nil, a Bool, an integer, a Double, a String, [UInt8] as bin, a Date as a
        timestamp, an array, or a dictionary with String keys, written in sorted key order. */
    public mutating func any(_ v: Any?) throws {
        guard let v else { return nil_() }
        switch v {
        case let b as Bool: bool(b)
        case let i as Int: int(i)
        case let i as Int64: int(Int(i))
        case let i as Int32: int(Int(i))
        case let d as Double:
            if d == d.rounded(.down) && abs(d) < 9.007199254740992e15 { int(Int(d)) } else { double(d) }
        case let s as String: str(s)
        // bin by its exact type, since an empty array of any element type casts to [UInt8]
        case let b as [UInt8] where type(of: v) == [UInt8].self: bin(b)
        case let d as Date: date(d)
        case let l as [Any?]:
            array(l.count)
            for item in l { try any(item) }
        case let m as [String: Any?]:
            map(m.count)
            for k in m.keys.sorted() {
                str(k)
                try any(m[k]!)
            }
        default: throw MsgpackError("not a plain value: \(type(of: v))")
        }
    }
}

/** the milliseconds since the epoch of a date, the precision every host keeps */
func epochMillis(_ d: Date) -> Int64 {
    // a Date is a Double of seconds, so a value read from milliseconds may land just below them
    let ms = d.timeIntervalSince1970 * 1000
    let near = ms.rounded()
    return Int64(abs(ms - near) < 0.001 ? near : ms.rounded(.down))
}

/** the msgpack of a plain value, as MsgWriter.any writes it */
public func encodeAny(_ v: Any?) throws -> [UInt8] {
    var w = MsgWriter()
    try w.any(v)
    return w.bytes
}

/** a plain value from msgpack, as MsgReader.any reads it */
public func decodeAny(_ b: [UInt8]) throws -> Any? {
    var r = MsgReader(b)
    let v = try r.any()
    if !r.done { throw MsgpackError("trailing bytes") }
    return v
}

public struct MsgpackError: Error, CustomStringConvertible {
    public let description: String

    init(_ message: String) {
        description = message
    }
}

/** The kinds of msgpack value, as a value's type byte tells them; ext is an extension, a
    timestamp among them, or a byte no value starts with. */
public enum MsgKind {
    case nil_, bool, int, float, str, bin, array, map, ext
}

/** A pull reader over msgpack bytes.  Each read takes one value at the cursor, or fails. */
public struct MsgReader {
    private let b: [UInt8]
    public var at: Int
    private let end: Int

    public init(_ b: [UInt8], at: Int = 0) {
        self.b = b
        self.at = at
        end = b.count
    }

    public var done: Bool { at >= end }

    private func need(_ n: Int) throws {
        if n < 0 || end - at < n { throw MsgpackError("msgpack: truncated") }
    }

    private mutating func u8() throws -> UInt8 {
        try need(1)
        defer { at += 1 }
        return b[at]
    }

    private mutating func be(_ n: Int) throws -> UInt64 {
        try need(n)
        var v: UInt64 = 0
        for _ in 0..<n {
            v = (v << 8) | UInt64(b[at])
            at += 1
        }
        return v
    }

    /** the type byte at the cursor, without consuming it */
    public func peek() throws -> UInt8 {
        try need(1)
        return b[at]
    }

    public func isNil() throws -> Bool { try peek() == 0xc0 }

    /** the kind of the value at the cursor, without consuming it */
    public func kind() throws -> MsgKind {
        switch try peek() {
        case 0xc0: .nil_
        case 0xc2, 0xc3: .bool
        case 0x00...0x7f, 0xe0...0xff, 0xcc...0xd3: .int
        case 0xca, 0xcb: .float
        case 0xa0...0xbf, 0xd9...0xdb: .str
        case 0xc4...0xc6: .bin
        case 0x90...0x9f, 0xdc, 0xdd: .array
        case 0x80...0x8f, 0xde, 0xdf: .map
        default: .ext
        }
    }

    public mutating func nil_() throws {
        if try u8() != 0xc0 { throw MsgpackError("expected nil") }
    }

    /** an array's count, failing as truncated past what the bytes left hold at a byte an item */
    public mutating func arrayHeader() throws -> Int {
        let n = switch try u8() {
        case let c where c >= 0x90 && c <= 0x9f: Int(c & 0x0f)
        case 0xdc: Int(try be(2))
        case 0xdd: Int(try be(4))
        default: throw MsgpackError("expected an array")
        }
        try need(n)
        return n
    }

    /** a map's count, failing as truncated past what the bytes left hold at two bytes an entry */
    public mutating func mapHeader() throws -> Int {
        let n = switch try u8() {
        case let c where c >= 0x80 && c <= 0x8f: Int(c & 0x0f)
        case 0xde: Int(try be(2))
        case 0xdf: Int(try be(4))
        default: throw MsgpackError("expected a map")
        }
        try need(2 * n)
        return n
    }

    public mutating func int() throws -> Int {
        let c = try u8()
        switch c {
        case 0x00...0x7f: return Int(c)
        case 0xe0...0xff: return Int(Int8(bitPattern: c))
        case 0xcc: return Int(try be(1))
        case 0xcd: return Int(try be(2))
        case 0xce: return Int(try be(4))
        case 0xcf:
            let v = try be(8)
            if v > UInt64(Int.max) { throw MsgpackError("integer past 64 bits") }
            return Int(v)
        case 0xd0: return Int(Int8(truncatingIfNeeded: try be(1)))
        case 0xd1: return Int(Int16(truncatingIfNeeded: try be(2)))
        case 0xd2: return Int(Int32(truncatingIfNeeded: try be(4)))
        case 0xd3: return Int(Int64(bitPattern: try be(8)))
        case 0xca, 0xcb:
            at -= 1
            let d = try double()
            if d != d.rounded(.down) || abs(d) > 9.007199254740992e15 { throw MsgpackError("expected an integer") }
            return Int(d)
        default: throw MsgpackError("expected an integer")
        }
    }

    public mutating func double() throws -> Double {
        switch try u8() {
        case 0xca: return Double(Float(bitPattern: UInt32(try be(4))))
        case 0xcb: return Double(bitPattern: try be(8))
        default:
            at -= 1
            return Double(try int())
        }
    }

    public mutating func bool() throws -> Bool {
        switch try u8() {
        case 0xc2: false
        case 0xc3: true
        default: throw MsgpackError("expected a boolean")
        }
    }

    private mutating func strLen() throws -> Int {
        switch try u8() {
        case let c where c >= 0xa0 && c <= 0xbf: Int(c & 0x1f)
        case 0xd9: Int(try be(1))
        case 0xda: Int(try be(2))
        case 0xdb: Int(try be(4))
        default: throw MsgpackError("expected a string")
        }
    }

    public mutating func str() throws -> String {
        let n = try strLen()
        try need(n)
        defer { at += n }
        return String(decoding: b[at..<at + n], as: UTF8.self)
    }

    /** whether the string at the cursor is key, consuming it either way */
    mutating func strEquals(_ key: [UInt8]) throws -> Bool {
        let n = try strLen()
        try need(n)
        defer { at += n }
        return n == key.count && b[at..<at + n].elementsEqual(key)
    }

    public mutating func bin() throws -> [UInt8] {
        let n: Int
        switch try u8() {
        case 0xc4: n = Int(try be(1))
        case 0xc5: n = Int(try be(2))
        case 0xc6: n = Int(try be(4))
        default: throw MsgpackError("expected bin")
        }
        try need(n)
        defer { at += n }
        return Array(b[at..<at + n])
    }

    /** a timestamp extension, in any of its three sizes, as seconds and nanoseconds */
    public mutating func timestamp() throws -> (seconds: Int64, nanoseconds: UInt32) {
        let c = try u8()
        let type: UInt8
        let len: Int
        switch c {
        case 0xd6: type = try u8(); len = 4
        case 0xd7: type = try u8(); len = 8
        case 0xc7: len = Int(try u8()); type = try u8()
        default: throw MsgpackError("expected a timestamp, found 0x\(String(c, radix: 16))")
        }
        if Int8(bitPattern: type) != extTimestamp { throw MsgpackError("expected a timestamp") }
        switch len {
        case 4: return (Int64(try be(4)), 0)
        case 8:
            let v = try be(8)
            return (Int64(v & 0x3_ffff_ffff), UInt32(v >> 34))
        case 12:
            let nsec = UInt32(try be(4))
            return (Int64(bitPattern: try be(8)), nsec)
        default: throw MsgpackError("a timestamp of \(len) bytes")
        }
    }

    /** a timestamp extension as a Date */
    public mutating func date() throws -> Date {
        let (sec, nsec) = try timestamp()
        return Date(timeIntervalSince1970: Double(sec) + Double(nsec) / 1e9)
    }

    /** the next value's bytes, consumed whole and undecoded */
    public mutating func raw() throws -> [UInt8] {
        let start = at
        try skip()
        return Array(b[start..<at])
    }

    /** consumes the next value without decoding it */
    public mutating func skip() throws {
        var pending = 1
        while pending > 0 {
            pending -= 1
            let c = try u8()
            var payload = 0
            var items = 0
            switch c {
            case 0x00...0x7f, 0xe0...0xff, 0xc0, 0xc2, 0xc3: break
            case 0x80...0x8f: items = 2 * Int(c & 0x0f)
            case 0x90...0x9f: items = Int(c & 0x0f)
            case 0xa0...0xbf: payload = Int(c & 0x1f)
            case 0xc4, 0xd9: payload = Int(try be(1))
            case 0xc5, 0xda: payload = Int(try be(2))
            case 0xc6, 0xdb: payload = Int(try be(4))
            case 0xc7: payload = Int(try be(1)) + 1
            case 0xc8: payload = Int(try be(2)) + 1
            case 0xc9: payload = Int(try be(4)) + 1
            case 0xcc, 0xd0: payload = 1
            case 0xcd, 0xd1: payload = 2
            case 0xca, 0xce, 0xd2: payload = 4
            case 0xcb, 0xcf, 0xd3: payload = 8
            case 0xd4...0xd8: payload = 1 + (1 << Int(c - 0xd4))
            case 0xdc: items = Int(try be(2))
            case 0xdd: items = Int(try be(4))
            case 0xde: items = 2 * Int(try be(2))
            case 0xdf: items = 2 * Int(try be(4))
            default: throw MsgpackError("msgpack: invalid")
            }
            if payload > end - at { throw MsgpackError("msgpack: truncated") }
            at += payload
            pending += items
            if pending > end - at { throw MsgpackError("msgpack: truncated") }
        }
    }

    /** A plain value: nil, booleans, integers as Int, floats as Double, strings, bin as [UInt8], a
        timestamp as a Date, arrays as [Any?], maps as [String: Any?]. */
    public mutating func any() throws -> Any? {
        switch try kind() {
        case .nil_:
            try nil_()
            return nil
        case .bool: return try bool()
        case .int: return try int()
        case .float: return try double()
        case .str: return try str()
        case .bin: return try bin()
        case .array:
            let n = try arrayHeader()
            var l: [Any?] = []
            l.reserveCapacity(n)
            for _ in 0..<n { l.append(try any()) }
            return l
        case .map:
            let n = try mapHeader()
            var m: [String: Any?] = [:]
            m.reserveCapacity(n)
            for _ in 0..<n {
                let k = try str()
                m[k] = .some(try any())
            }
            return m
        case .ext: return try date()
        }
    }
}
