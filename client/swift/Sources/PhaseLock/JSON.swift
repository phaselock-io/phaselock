// A schema's json node as a Swift value: any plain value, held so that a generated struct with a
// json field stays Sendable and Equatable.

/** Any plain value, as a json field holds it.  Integers and floats stay apart, as msgpack keeps
    them. */
public enum JSON: Sendable, Hashable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case bytes([UInt8])
    case array([JSON])
    case object([String: JSON])

    func write(_ w: inout MsgWriter) {
        switch self {
        case .null: w.nil_()
        case .bool(let b): w.bool(b)
        case .int(let i): w.int(i)
        case .double(let d): w.double(d)
        case .string(let s): w.str(s)
        case .bytes(let b): w.bin(b)
        case .array(let l):
            w.array(l.count)
            for x in l { x.write(&w) }
        case .object(let m):
            w.map(m.count)
            for k in m.keys.sorted() {
                w.str(k)
                m[k]!.write(&w)
            }
        }
    }

    static func read(_ r: inout MsgReader) throws -> JSON {
        switch try r.kind() {
        case .nil_:
            try r.nil_()
            return .null
        case .bool: return .bool(try r.bool())
        case .int: return .int(try r.int())
        case .float: return .double(try r.double())
        case .str: return .string(try r.str())
        case .bin: return .bytes(try r.bin())
        case .array:
            let n = try r.arrayHeader()
            var l: [JSON] = []
            l.reserveCapacity(n)
            for _ in 0..<n { l.append(try read(&r)) }
            return .array(l)
        case .map:
            let n = try r.mapHeader()
            var m: [String: JSON] = [:]
            for _ in 0..<n {
                let k = try r.str()
                m[k] = try read(&r)
            }
            return .object(m)
        case .ext:
            // a timestamp, which a plain value holds as its milliseconds
            return .int(Int(epochMillis(try r.date())))
        }
    }
}
