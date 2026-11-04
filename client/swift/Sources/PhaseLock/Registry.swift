// The Swift walk of the generated type registry: the model's types as a node table, as every
// emitter emits it, which this walker interprets to convert Swift values to msgpack and back,
// checked against the schema both ways.  Generated code supplies each struct's initializer and
// field getter, each struct's type, and each enum's wrapping of its members, so the walk builds
// the generated types without reflection.
//
// A struct writes its discriminator first, the field a union tells it apart by, then the rest
// in declaration order; an optional field that is nil is left out.  A literal field is no
// property of its struct: the walk writes it from the schema, and checks it on the way back.
// Dates are the msgpack timestamp extension at millisecond precision.  A field the schema does
// not name is dropped.  A record writes its keys in sorted order, since a Swift dictionary has
// none of its own.  Reading walks the msgpack itself, into the generated types in one pass; a
// union's tests look ahead at a value without decoding it, and its member then reads it.

import Foundation

/** A literal of the schema: a string, an integer, or a boolean. */
public enum Literal: Sendable, Hashable, CustomStringConvertible {
    case str(String)
    case int(Int)
    case bool(Bool)

    /** the literal as a plain value */
    public var value: Any {
        switch self {
        case .str(let s): s
        case .int(let i): i
        case .bool(let b): b
        }
    }

    public var description: String {
        switch self {
        case .str(let s): s
        case .int(let i): String(i)
        case .bool(let b): String(b)
        }
    }

    // whether a value read as its own type is this literal
    func equals(_ v: Any?) -> Bool {
        switch (self, v) {
        case (.str(let a), let b as String): a == b
        case (.int(let a), let b as Int): a == b
        case (.bool(let a), let b as Bool): a == b
        default: false
        }
    }

    // whether a plain value is this literal for a union's test: equal to it, or a number that
    // truncates to the same integer
    func matches(_ v: Any?) -> Bool {
        switch (self, v) {
        case (.str(let a), let b as String): a == b
        case (.int(let a), let b as Int): a == b
        case (.int(let a), let b as Double): Double(a) == b.rounded(.towardZero)
        case (.bool(let a), let b as Bool): a == b
        default: false
        }
    }
}

/** How the walk tells a union's members apart, as the union solver decided: each test reads the
    value at hand, or a part of it, until a match names the member. */
public indirect enum Solution: Sendable {
    case match(Int)
    case jsonType([(String, Solution)])
    case literal([(Literal, Solution)])
    case length([(Int, Solution)], Solution?)
    case index(Int, Solution)
    case field(String, Solution)
    case hasField([(String, Solution)])
}

/** One field of a struct: its name, its type's node, and whether it may be left out. */
public struct SchemaField: Sendable {
    public let name: String
    public let type: Int
    public let optional: Bool

    public init(_ name: String, _ type: Int, _ optional: Bool) {
        self.name = name
        self.type = type
        self.optional = optional
    }
}

/** A struct node: its fields, its discriminator's index or -1, and its generated type, built
    from its non-literal fields in declaration order by make and answered by get. */
public struct StructNode: Sendable {
    public let name: String?
    public let fields: [SchemaField]
    public let discriminator: Int
    public let type: ObjectIdentifier
    public let make: @Sendable ([Any?]) -> Any
    public let get: @Sendable (Any) -> [Any?]

    public init(
        _ name: String?,
        _ fields: [SchemaField],
        _ discriminator: Int,
        _ type: Any.Type,
        make: @escaping @Sendable ([Any?]) -> Any,
        get: @escaping @Sendable (Any) -> [Any?]
    ) {
        self.name = name
        self.fields = fields
        self.discriminator = discriminator
        self.type = ObjectIdentifier(type)
        self.make = make
        self.get = get
    }
}

/** A union node.  A union the emitter declared as a Swift enum carries its wrapping: wrap makes
    the enum's value of a member's, by the member's node, and unwrap answers the member a value of
    the enum holds, or nil for a value of another type. */
public struct UnionNode: Sendable {
    public let name: String?
    public let solution: Solution
    public let wrap: (@Sendable (Int, Any) -> Any)?
    public let unwrap: (@Sendable (Any) -> (Int, Any)?)?

    public init(
        _ name: String?,
        _ solution: Solution,
        wrap: (@Sendable (Int, Any) -> Any)? = nil,
        unwrap: (@Sendable (Any) -> (Int, Any)?)? = nil
    ) {
        self.name = name
        self.solution = solution
        self.wrap = wrap
        self.unwrap = unwrap
    }
}

/** One type of the model. */
public enum SchemaNode: Sendable {
    case null
    case int
    case str
    case bool
    case date
    case json
    case lit(Literal)
    case structure(StructNode)
    case record(String?, Int)
    case array(String?, Int)
    case tuple(String?, [Int])
    case union(UnionNode)
    case intake(String, Int)
}

/** A value that fails its type: the first mismatch, with its path. */
public struct ConvertError: Error, CustomStringConvertible {
    public let description: String
}

/* A mismatch on its way out of the walk, which each level it leaves places under its own segment
   (`.field`, `[k]`, `.key`), innermost first, so a conversion that succeeds builds no path. */
private struct Mismatch: Error {
    let what: String
    var segments: [String] = []

    func under(_ segment: String) -> Mismatch {
        var m = self
        m.segments.append(segment)
        return m
    }

    var error: ConvertError {
        ConvertError(description: "$\(segments.reversed().joined()): \(what)")
    }
}

// the position of a value that is not there, an item or a field the value lacks, which a union's
// tests read as nil
private let absent = -1

// what a union's literal test sees at an array or a map, which equals no literal
private struct NotScalar {}

/* How a struct reads: each field's index by its name, as UTF-8, and each field's place among the
   initializer's arguments, or -1 for a literal, which the initializer does not take. */
private struct StructPlan: Sendable {
    let keys: [[UInt8]]
    let args: [Int]
    let argCount: Int

    init(_ n: StructNode, _ nodes: [SchemaNode]) {
        keys = n.fields.map { Array($0.name.utf8) }
        var k = 0
        var args: [Int] = []
        for f in n.fields {
            if case .lit = nodes[f.type] {
                args.append(-1)
            } else {
                args.append(k)
                k += 1
            }
        }
        self.args = args
        argCount = k
    }

    // the field a key names, or nil for a key the schema does not name
    func slot(_ r: inout MsgReader) throws -> Int? {
        let start = r.at
        for (j, key) in keys.enumerated() {
            r.at = start
            if try r.strEquals(key) { return j }
        }
        r.at = start
        _ = try r.str()
        return nil
    }
}

/** The registry over a model's node table: each identity's node, and the node of each generated
    struct type, which a union's member is found by. */
public final class Registry: Sendable {
    private let nodes: [SchemaNode]
    private let ids: [String: Int]
    // each struct type's node
    private let types: [ObjectIdentifier: Int]
    // each union's members, the nodes its solution can match, by node
    private let members: [Int: [Int]]
    // each struct node's plan, by node
    private let plans: [StructPlan?]

    public init(_ nodes: [SchemaNode], _ ids: [String: Int]) {
        self.nodes = nodes
        self.ids = ids
        var types: [ObjectIdentifier: Int] = [:]
        var members: [Int: [Int]] = [:]
        for (i, n) in nodes.enumerated() {
            switch n {
            case .structure(let s): types[s.type] = i
            case .union(let u): members[i] = Registry.members(u.solution)
            default: break
            }
        }
        self.types = types
        self.members = members
        plans = nodes.map { n in
            if case .structure(let s) = n { StructPlan(s, nodes) } else { nil }
        }
    }

    // the nodes a solution can match, in order, each once
    private static func members(_ s: Solution) -> [Int] {
        var out: [Int] = []
        func walk(_ s: Solution) {
            switch s {
            case .match(let n): if !out.contains(n) { out.append(n) }
            case .jsonType(let o): o.forEach { walk($0.1) }
            case .literal(let o): o.forEach { walk($0.1) }
            case .length(let o, let d):
                o.forEach { walk($0.1) }
                if let d { walk(d) }
            case .index(_, let s), .field(_, let s): walk(s)
            case .hasField(let o): o.forEach { walk($0.1) }
            }
        }
        walk(s)
        return out
    }

    private func node(_ type: String) throws -> Int {
        guard let i = ids[type] else { throw ConvertError(description: "no registry entry for type \(type)") }
        return i
    }

    /** a value as msgpack under a type */
    public func encode(_ type: String, _ value: Any?) throws -> [UInt8] {
        let i = try node(type)
        var w = MsgWriter()
        do {
            try write(&w, i, value)
        } catch let m as Mismatch {
            throw m.error
        }
        return w.bytes
    }

    /** a value of a type, from msgpack */
    public func decode(_ type: String, _ bytes: [UInt8]) throws -> Any? {
        let i = try node(type)
        var r = MsgReader(bytes)
        do {
            return try read(i, &r)
        } catch let m as Mismatch {
            throw m.error
        }
    }

    /** a value of a type, from msgpack, as the Swift type the emitter declared for it */
    public func decode<T>(_ type: String, _ bytes: [UInt8], as: T.Type) throws -> T {
        try cast(decode(type, bytes))
    }

    // writing ////////////////////////////////////////////////////////////////

    private func write(_ w: inout MsgWriter, _ i: Int, _ v: Any?) throws {
        switch nodes[i] {
        case .null:
            guard v == nil else { throw Mismatch(what: "expected null") }
            w.nil_()
        case .int:
            guard let n = v as? Int else { throw Mismatch(what: "expected an integer") }
            w.int(n)
        case .str:
            guard let s = v as? String else { throw Mismatch(what: "expected a string") }
            w.str(s)
        case .bool:
            guard let b = v as? Bool else { throw Mismatch(what: "expected a boolean") }
            w.bool(b)
        case .date:
            guard let d = v as? Date else { throw Mismatch(what: "expected a Date") }
            w.date(d)
        case .json:
            guard let j = v == nil ? JSON.null : v as? JSON else { throw Mismatch(what: "expected JSON") }
            j.write(&w)
        case .lit(let lit):
            guard v == nil || lit.equals(v) else { throw Mismatch(what: "expected \(lit)") }
            try w.any(lit.value)
        case .structure(let s):
            try writeStruct(&w, s, v)
        case .record(_, let item):
            guard let m = v as? [String: Any?] else { throw Mismatch(what: "expected a dictionary") }
            w.map(m.count)
            for k in m.keys.sorted() {
                w.str(k)
                do {
                    try write(&w, item, m[k]!)
                } catch let e as Mismatch {
                    throw e.under(".\(k)")
                }
            }
        case .array(_, let item):
            guard let l = v as? [Any?] else { throw Mismatch(what: "expected an array") }
            w.array(l.count)
            for (k, x) in l.enumerated() {
                do {
                    try write(&w, item, x)
                } catch let e as Mismatch {
                    throw e.under("[\(k)]")
                }
            }
        case .tuple(_, let items):
            guard let l = v as? [Any?] else { throw Mismatch(what: "expected an array") }
            guard l.count == items.count else { throw Mismatch(what: "expected \(items.count) items") }
            w.array(l.count)
            for (k, x) in l.enumerated() {
                do {
                    try write(&w, items[k], x)
                } catch let e as Mismatch {
                    throw e.under("[\(k)]")
                }
            }
        case .union(let u):
            // an enum's value writes as the member it holds; any other as the member it fits
            if let v, let unwrap = u.unwrap, let (m, inner) = unwrap(v) {
                try write(&w, m, inner)
            } else {
                try write(&w, member(i, u, v), v)
            }
        case .intake(_, let wire):
            try write(&w, wire, v)
        }
    }

    private func writeStruct(_ w: inout MsgWriter, _ n: StructNode, _ v: Any?) throws {
        guard let v, ObjectIdentifier(type(of: v)) == n.type else {
            throw Mismatch(what: "expected \(n.name ?? "a struct")")
        }
        let values = n.get(v)

        // each field's value, a literal's from the schema, and those present in writing order
        var k = 0
        var all: [Any?] = []
        for f in n.fields {
            if case .lit(let lit) = nodes[f.type] {
                all.append(lit.value)
            } else {
                all.append(values[k])
                k += 1
            }
        }
        let order = n.fields.indices.sorted { a, b in
            (a == n.discriminator ? -1 : a) < (b == n.discriminator ? -1 : b)
        }
        let present = order.filter { !(n.fields[$0].optional && all[$0] == nil) }
        w.map(present.count)
        for j in present {
            w.str(n.fields[j].name)
            do {
                try write(&w, n.fields[j].type, all[j])
            } catch let e as Mismatch {
                throw e.under(".\(n.fields[j].name)")
            }
        }
    }

    // the member of a union a value writes as: the one its struct type names, or the first whose
    // kind fits it, or, for a plain array or dictionary, the one the union's solution picks
    private func member(_ i: Int, _ u: UnionNode, _ v: Any?) throws -> Int {
        if v is [Any?] || v is [String: Any?] {
            guard let m = solve(u.solution, v) else { throw Mismatch(what: "no member of \(u.name ?? "the union") fits") }
            return m
        }
        let ms = members[i]!
        if let v, let t = types[ObjectIdentifier(type(of: v))], ms.contains(t) { return t }
        for m in ms {
            let fits: Bool
            switch nodes[m] {
            case .null: fits = v == nil
            case .int: fits = v is Int
            case .str, .intake: fits = v is String
            case .bool: fits = v is Bool
            case .date: fits = v is Date
            case .json: fits = true
            case .lit(let lit): fits = lit.equals(v)
            default: fits = false
            }
            if fits { return m }
        }
        throw Mismatch(what: "no member of \(u.name ?? "the union") fits \(v.map { "\(type(of: $0))" } ?? "nil")")
    }

    // the JSON type of a plain value, as the union solver names them
    private func jsonType(_ v: Any?) -> String {
        switch v {
        case nil: "null"
        case is Bool: "boolean"
        case is Int: "int"
        case is String, is Date: "string"
        case is [Any?]: "array"
        case is [String: Any?]: "object"
        default: "unknown"
        }
    }

    // the member a plain value belongs to, as the solution tells, or nil for none
    private func solve(_ s: Solution, _ v: Any?) -> Int? {
        switch s {
        case .match(let n):
            return n
        case .jsonType(let o):
            let t = jsonType(v)
            return o.first { $0.0 == t || $0.0 == "*" }.flatMap { solve($0.1, v) }
        case .literal(let o):
            return o.first { $0.0.matches(v) }.flatMap { solve($0.1, v) }
        case .length(let o, let d):
            let size = (v as? [Any?])?.count
            return (o.first { $0.0 == size }?.1 ?? d).flatMap { solve($0, v) }
        case .index(let k, let s):
            let l = v as? [Any?]
            return solve(s, l.flatMap { k < $0.count ? $0[k] : nil })
        case .field(let key, let s):
            return solve(s, (v as? [String: Any?])?[key] ?? nil)
        case .hasField(let o):
            let m = v as? [String: Any?]
            return o.first { m?[$0.0] != nil }.flatMap { solve($0.1, v) }
        }
    }

    // reading ////////////////////////////////////////////////////////////////

    // the value at the reader's cursor, read by its type straight into the generated types
    private func read(_ i: Int, _ r: inout MsgReader) throws -> Any? {
        switch nodes[i] {
        case .null:
            guard try r.kind() == .nil_ else { throw Mismatch(what: "expected null") }
            try r.nil_()
            return nil
        case .int:
            guard try r.kind() == .int else { throw Mismatch(what: "expected an integer") }
            return try r.int()
        case .str:
            guard try r.kind() == .str else { throw Mismatch(what: "expected a string") }
            return try r.str()
        case .bool:
            guard try r.kind() == .bool else { throw Mismatch(what: "expected a boolean") }
            return try r.bool()
        case .date:
            guard try r.kind() == .ext else { throw Mismatch(what: "expected a timestamp") }
            return try r.date()
        case .json:
            return try JSON.read(&r)
        case .lit(let lit):
            let v = try r.any()
            guard lit.equals(v) else { throw Mismatch(what: "expected \(lit)") }
            return lit.value
        case .structure(let s):
            return try readStruct(plans[i]!, s, &r)
        case .record(_, let item):
            guard try r.kind() == .map else { throw Mismatch(what: "expected a dictionary") }
            let size = try r.mapHeader()
            var m: [String: Any?] = [:]
            m.reserveCapacity(size)
            for _ in 0..<size {
                let k = try r.str()
                do {
                    m[k] = .some(try read(item, &r))
                } catch let e as Mismatch {
                    throw e.under(".\(k)")
                }
            }
            return m
        case .array(_, let item):
            guard try r.kind() == .array else { throw Mismatch(what: "expected an array") }
            let size = try r.arrayHeader()
            return try readItems(&r, size) { _ in item }
        case .tuple(_, let items):
            guard try r.kind() == .array else { throw Mismatch(what: "expected an array") }
            let size = try r.arrayHeader()
            guard size == items.count else { throw Mismatch(what: "expected \(items.count) items") }
            return try readItems(&r, size) { items[$0] }
        case .union(let u):
            // the member the solution picks by looking at the value, which is then read from
            // where it starts
            let start = r.at
            guard let m = try solveAt(u.solution, &r, start) else {
                throw Mismatch(what: "no member of \(u.name ?? "the union") fits")
            }
            r.at = start
            let value = try read(m, &r)
            if let value, let wrap = u.wrap { return wrap(m, value) }
            return value
        case .intake(_, let wire):
            return try read(wire, &r)
        }
    }

    // an array's items, each read by the type typeOf gives its index
    private func readItems(_ r: inout MsgReader, _ size: Int, _ typeOf: (Int) -> Int) throws -> [Any?] {
        var l: [Any?] = []
        l.reserveCapacity(size)
        for k in 0..<size {
            do {
                l.append(try read(typeOf(k), &r))
            } catch let e as Mismatch {
                throw e.under("[\(k)]")
            }
        }
        return l
    }

    /* A struct, read entry by entry into its initializer's arguments.  A mismatch in a field
       waits until every entry is read, since the first field in declaration order that is missing
       or mismatched is the one reported. */
    private func readStruct(_ plan: StructPlan, _ n: StructNode, _ r: inout MsgReader) throws -> Any {
        guard try r.kind() == .map else { throw Mismatch(what: "expected a map") }
        var args = [Any?](repeating: nil, count: plan.argCount)
        var seen = [Bool](repeating: false, count: n.fields.count)
        var mismatches: [Mismatch?]? = nil

        // each entry: a field's value read by its type, and a key the schema does not name
        // skipped; of a key that repeats, the last entry counts
        for _ in 0..<(try r.mapHeader()) {
            guard let j = try plan.slot(&r) else {
                try r.skip()
                continue
            }
            seen[j] = true
            let start = r.at
            do {
                let v = try read(n.fields[j].type, &r)
                if plan.args[j] >= 0 { args[plan.args[j]] = v }
                mismatches?[j] = nil
            } catch let e as Mismatch {
                // the field's mismatch, kept, and the rest of its value passed over
                if mismatches == nil { mismatches = [Mismatch?](repeating: nil, count: n.fields.count) }
                mismatches![j] = e
                r.at = start
                try r.skip()
            }
        }

        // the first field, in declaration order, that mismatched or is missing
        for (j, f) in n.fields.enumerated() {
            if let e = mismatches?[j] { throw e.under(".\(f.name)") }
            if !seen[j] && !f.optional { throw Mismatch(what: "missing").under(".\(f.name)") }
        }
        return n.make(args)
    }

    // the union tests, which look at a value from its position without decoding it

    // the member the value at a position belongs to, as the solution tells, or nil for none
    private func solveAt(_ s: Solution, _ r: inout MsgReader, _ at: Int) throws -> Int? {
        switch s {
        case .match(let n):
            return n
        case .jsonType(let o):
            let t = try jsonTypeAt(&r, at)
            guard let opt = o.first(where: { $0.0 == t || $0.0 == "*" }) else { return nil }
            return try solveAt(opt.1, &r, at)
        case .literal(let o):
            let v = try scalarAt(&r, at)
            guard let opt = o.first(where: { $0.0.matches(v) }) else { return nil }
            return try solveAt(opt.1, &r, at)
        case .length(let o, let d):
            let size = try lengthAt(&r, at)
            guard let next = o.first(where: { $0.0 == size })?.1 ?? d else { return nil }
            return try solveAt(next, &r, at)
        case .index(let k, let s):
            return try solveAt(s, &r, itemAt(&r, at, k))
        case .field(let key, let s):
            return try solveAt(s, &r, fieldAt(&r, at, Array(key.utf8)))
        case .hasField(let o):
            for opt in o where try fieldAt(&r, at, Array(opt.0.utf8)) != absent {
                return try solveAt(opt.1, &r, at)
            }
            return nil
        }
    }

    // the JSON type of the value at a position, as jsonType names the plain value's
    private func jsonTypeAt(_ r: inout MsgReader, _ at: Int) throws -> String {
        if at == absent { return "null" }
        r.at = at
        switch try r.kind() {
        case .nil_: return "null"
        case .bool: return "boolean"
        case .int: return "int"
        case .str, .ext: return "string" // an extension reads as a timestamp
        case .array: return "array"
        case .map: return "object"
        case .float, .bin: return "unknown"
        }
    }

    // the scalar at a position, as MsgReader.any reads it, or NotScalar at an array or a map
    private func scalarAt(_ r: inout MsgReader, _ at: Int) throws -> Any? {
        if at == absent { return nil }
        r.at = at
        let k = try r.kind()
        return k == .array || k == .map ? NotScalar() : try r.any()
    }

    // the length of the array at a position, or nil for any other value
    private func lengthAt(_ r: inout MsgReader, _ at: Int) throws -> Int? {
        if at == absent { return nil }
        r.at = at
        return try r.kind() == .array ? try r.arrayHeader() : nil
    }

    // the position of an array's item, or absent when the value has no such item
    private func itemAt(_ r: inout MsgReader, _ at: Int, _ index: Int) throws -> Int {
        if at == absent { return absent }
        r.at = at
        if try r.kind() != .array { return absent }
        let size = try r.arrayHeader()
        guard index >= 0 && index < size else { return absent }
        for _ in 0..<index { try r.skip() }
        return r.at
    }

    // the position of a map's field, the last of a key that repeats, or absent when the value has
    // no such field
    private func fieldAt(_ r: inout MsgReader, _ at: Int, _ key: [UInt8]) throws -> Int {
        if at == absent { return absent }
        r.at = at
        if try r.kind() != .map { return absent }
        var found = absent
        for _ in 0..<(try r.mapHeader()) {
            if try r.strEquals(key) { found = r.at }
            try r.skip()
        }
        return found
    }
}

/** a value the walk read, as the Swift type the emitter declared for it */
public func cast<T>(_ v: Any?) throws -> T {
    guard let t = v as? T else { throw ConvertError(description: "$: expected \(T.self), found \(v.map { "\(type(of: $0))" } ?? "nil")") }
    return t
}

/** A fresh series for mutations numbered outside an Engine: 16 random bytes, base64url. */
public func generateSeries() -> String {
    var g = SystemRandomNumberGenerator()
    let b = (0..<16).map { _ in UInt8.random(in: 0...255, using: &g) }
    return Data(b).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}
