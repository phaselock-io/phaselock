import Foundation
import Testing

@testable import PhaseLock

// msgpack written by hand, for values no encoder of the model writes
private func msg(_ fn: (inout MsgWriter) throws -> Void) rethrows -> [UInt8] {
    var w = MsgWriter()
    try fn(&w)
    return w.bytes
}

private func expectMismatch(_ message: String, _ fn: () throws -> Any?) {
    do {
        _ = try fn()
        Issue.record("expected the mismatch \(message)")
    } catch let e as ConvertError {
        #expect(e.description == message)
    } catch {
        Issue.record("expected a ConvertError, got \(error)")
    }
}

// the struct the hand-built registry declares: a literal discriminator, then a required integer, an
// optional string, and an optional record
private struct S: Equatable {
    var a: Int
    var b: String? = nil
    var c: [String: Int]? = nil
}

/** A registry built by hand, for the node kinds and solutions the library model does not use. */
@Suite struct RegistryTests {
    private let reg = Registry(
        [
            .int, // 0
            .str, // 1
            .record(nil, 0), // 2
            .tuple(nil, [1, 0]), // 3
            .union(UnionNode("Num", .literal([(.int(1), .match(0)), (.str("two"), .match(1))]))), // 4
            .json, // 5
            .lit(.int(1)), // 6
            .union(UnionNode("Any", .jsonType([("int", .match(0)), ("*", .match(5))]))), // 7
            .union(UnionNode("Sized", .length([(2, .match(3))], .match(9)))), // 8
            .array(nil, 0), // 9
            .structure(
                StructNode(
                    "S",
                    [SchemaField("kind", 11, false), SchemaField("a", 0, false), SchemaField("b", 1, true), SchemaField("c", 2, true)],
                    0,
                    S.self,
                    make: { a in S(a: a[0] as! Int, b: a[1] as? String, c: a[2] as? [String: Int]) },
                    get: { v in let s = v as! S; return [s.a, s.b, s.c] }
                )
            ), // 10
            .lit(.str("s")), // 11
            .union(UnionNode("Second", .index(1, .jsonType([("string", .match(13)), ("null", .match(9))])))), // 12
            .array(nil, 1), // 13
            .union(UnionNode("Keyed", .field("k", .jsonType([("int", .match(2)), ("null", .match(5))])))), // 14
            .array(nil, 9), // 15
        ],
        [
            "record": 2, "pair": 3, "num": 4, "one": 6, "any": 7, "sized": 8, "S": 10, "second": 12,
            "keyed": 14, "grid": 15,
        ]
    )

    private func decode(_ type: String, _ fn: (inout MsgWriter) throws -> Void) throws -> Any? {
        try reg.decode(type, try msg(fn))
    }

    @Test func records() throws {
        let m = try reg.decode("record", try reg.encode("record", ["x": 1, "y": -2])) as? [String: Any?]
        #expect(m?.mapValues { $0 as? Int } == ["x": 1, "y": -2])
        expectMismatch("$.y: expected an integer") { try decode("record") { try $0.any(["x": 1, "y": "no"]) } }
        expectMismatch("$: expected a dictionary") { try decode("record") { try $0.any([1]) } }
    }

    @Test func tuples() throws {
        let t = try decode("pair") { try $0.any(["a", 1]) } as? [Any?]
        #expect(t?[0] as? String == "a" && t?[1] as? Int == 1)
        expectMismatch("$: expected 2 items") { try decode("pair") { try $0.any(["a"]) } }
        expectMismatch("$[1]: expected an integer") { try decode("pair") { try $0.any(["a", "b"]) } }
    }

    @Test func nestedArrays() throws {
        #expect(try reg.decode("grid", try msg { try $0.any([[1], [2, 3]]) }, as: [[Int]].self) == [[1], [2, 3]])
        expectMismatch("$[1][1]: expected an integer") { try decode("grid") { try $0.any([[1], [2, "x"]]) } }
    }

    @Test func anIntegerIsNoFloatButALiteralTestComparesNumbers() throws {
        #expect(try decode("num") { $0.int(1) } as? Int == 1)
        #expect(try decode("num") { $0.str("two") } as? String == "two")
        expectMismatch("$: expected an integer") { try decode("num") { $0.double(1.0) } }
        expectMismatch("$: no member of Num fits") { try decode("num") { $0.int(3) } }
        #expect(try decode("one") { $0.int(1) } as? Int == 1)
        expectMismatch("$: expected 1") { try decode("one") { $0.double(1.0) } }
    }

    @Test func aJsonTypeTestFallsToItsWildcard() throws {
        #expect(try decode("any") { $0.int(7) } as? Int == 7)
        #expect(try decode("any") { $0.double(1.5) } as? JSON == .double(1.5))
        #expect(try decode("any") { try $0.any(["x": [true]]) } as? JSON == .object(["x": .array([.bool(true)])]))
    }

    @Test func aLengthTestFallsToItsDefault() throws {
        let pair = try decode("sized") { try $0.any(["a", 1]) } as? [Any?]
        #expect(pair?.count == 2 && pair?[0] as? String == "a")
        #expect(try reg.decode("sized", try msg { try $0.any([1, 2, 3]) }, as: [Int].self) == [1, 2, 3])
        expectMismatch("$: expected an array") { try decode("sized") { $0.str("no") } }
    }

    @Test func anItemOrAFieldThatIsNotThereTestsAsNull() throws {
        #expect(try reg.decode("second", try msg { try $0.any(["x", "y"]) }, as: [String].self) == ["x", "y"])
        #expect(try reg.decode("second", try msg { try $0.any([5]) }, as: [Int].self) == [5])
        #expect(try reg.decode("keyed", try msg { try $0.any(["k": 1]) }, as: [String: Int].self) == ["k": 1])
        #expect(try decode("keyed") { try $0.any(["j": "x"]) } as? JSON == .object(["j": .string("x")]))
        #expect(try decode("keyed") { try $0.any(["k": nil]) } as? JSON == .object(["k": .null]))
    }

    @Test func structs() throws {
        // optional fields left out, and a key the schema does not name passed over
        #expect(try decode("S") { try $0.any(["kind": "s", "zz": ["deep": [1]], "a": 1]) } as? S == S(a: 1))
        let full = S(a: 1, b: "b", c: ["x": 2])
        #expect(try reg.decode("S", try reg.encode("S", full)) as? S == full)

        // of a key that repeats, the last entry counts
        #expect(
            try decode("S") { w in
                w.map(3)
                w.str("kind"); w.str("s")
                w.str("a"); w.str("bad")
                w.str("a"); w.int(2)
            } as? S == S(a: 2)
        )
        expectMismatch("$.a: expected an integer") {
            try decode("S") { w in
                w.map(3)
                w.str("kind"); w.str("s")
                w.str("a"); w.int(2)
                w.str("a"); w.str("bad")
            }
        }

        // the literal, checked, and every mismatch reported in declaration order
        expectMismatch("$.kind: expected s") { try decode("S") { try $0.any(["kind": "t", "a": 1]) } }
        expectMismatch("$.kind: missing") { try decode("S") { try $0.any(["a": "bad"]) } }
        expectMismatch("$.a: missing") { try decode("S") { try $0.any(["c": ["x": "bad"], "kind": "s"]) } }
        expectMismatch("$.c.x: expected an integer") { try decode("S") { try $0.any(["c": ["x": "bad"], "kind": "s", "a": 1]) } }
        expectMismatch("$: expected a map") { try decode("S") { try $0.any([1]) } }
    }

    @Test func encodingNamesThePathToo() {
        expectMismatch("$[0][1]: expected an integer") { try reg.encode("grid", [[1, "x"]]) }
        expectMismatch("$: expected S") { try reg.encode("S", [1]) }
    }
}

@Suite struct MsgpackTests {
    @Test func integersTakeTheirSmallestEncoding() throws {
        for (v, b) in [(0, [0x00]), (127, [0x7f]), (-1, [0xff]), (-33, [0xd0, 0xdf]), (255, [0xcc, 0xff]), (-129, [0xd1, 0xff, 0x7f])] {
            #expect(msg { $0.int(v) } == b.map(UInt8.init))
            var r = MsgReader(b.map(UInt8.init))
            #expect(try r.int() == v)
        }
        #expect(try decodeAny(msg { $0.int(Int.min) }) as? Int == Int.min)
        #expect(try decodeAny(msg { $0.int(Int.max) }) as? Int == Int.max)
    }

    @Test func datesKeepMilliseconds() throws {
        let d = Date(timeIntervalSince1970: 1_700_000_000.123)
        var r = MsgReader(msg { $0.date(d) })
        #expect(epochMillis(try r.date()) == 1_700_000_000_123)
        let before = Date(timeIntervalSince1970: -1.5)
        r = MsgReader(msg { $0.date(before) })
        #expect(epochMillis(try r.date()) == -1500)
    }

    @Test func skipPassesOverAnyValue() throws {
        let b = try msg { w in
            try w.any(["a": [1, "two", 3.5, nil, true], "b": [UInt8](repeating: 7, count: 300)])
            w.int(42)
        }
        var r = MsgReader(b)
        try r.skip()
        #expect(try r.int() == 42)
        #expect(r.done)
    }

    @Test func emptyArraysAreNoBin() throws {
        let empty: [[Any?]] = []
        #expect(try encodeAny(empty) == [0x90])
        #expect(try encodeAny([UInt8]()) == [0xc4, 0x00])
    }

    @Test func checksums() {
        #expect(crc32c(Array("123456789".utf8)) == 0xe306_9283)
        var f = Fnv64()
        f.update(Array("a".utf8))
        #expect(f.state == "af63dc4c8601ec8c")
        #expect(Fnv64(state: f.state)?.state == f.state)
        #expect(Fnv64(state: "AF63DC4C8601EC8C") == nil)
    }
}
