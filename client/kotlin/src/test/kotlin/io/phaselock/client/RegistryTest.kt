package io.phaselock.client

import io.phaselock.examples.library.AdminBookInfo
import io.phaselock.examples.library.AdminBookInfoState
import io.phaselock.examples.library.AdminEditionInfo
import io.phaselock.examples.library.Book
import io.phaselock.examples.library.BookStatus
import io.phaselock.examples.library.ChangePassword
import io.phaselock.examples.library.Checkout
import io.phaselock.examples.library.Edition
import io.phaselock.examples.library.HoldTarget
import io.phaselock.examples.library.MutationAuth
import io.phaselock.examples.library.PatronHold
import io.phaselock.examples.library.TryHold
import io.phaselock.examples.library.UserBookInfo
import io.phaselock.examples.library.UserCheckoutInfo
import io.phaselock.examples.library.UserHoldInfo
import io.phaselock.examples.library.UserPatronInfo
import io.phaselock.examples.library.registry as library
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

// msgpack written by hand, for values no encoder of the model writes
private fun msg(fn: MsgWriter.() -> Unit): ByteArray = MsgWriter().apply(fn).bytes()

private fun MsgWriter.entry(key: String, value: Any?) {
    str(key)
    any(value)
}

private fun assertMismatch(message: String, fn: () -> Unit) =
    assertEquals(message, assertFailsWith<ConvertError> { fn() }.message)

/** The library model's registry: each value decodes to what was encoded, through every union
    solution the model's types use. */
class LibraryRegistryTest {
    private val at = Instant.ofEpochMilli(1_700_000_000_123)

    private fun roundTrip(type: String, value: Any?) =
        assertEquals(value, library.decode(type, library.encode(type, value)))

    @Test
    fun structsWithOptionalFieldsPresentAndLeftOut() {
        roundTrip("Book", Book("b1", "978-0", true, at))
        roundTrip("Book", Book("b1", "978-0", false, at, BookStatus.Checkout("c1")))
    }

    @Test
    fun unionsByWhichFieldTheyHave() {
        roundTrip("Book", Book("b1", "978-0", false, at, BookStatus.Hold("h1")))
        roundTrip("PatronHold", PatronHold("h1", HoldTarget.Edition("978-0"), at, true))
        roundTrip("PatronHold", PatronHold("h1", HoldTarget.Book("b1")))
    }

    @Test
    fun unionsByALiteralField() {
        roundTrip("UserMutations", TryHold("r", "h1", "p1", HoldTarget.Book("b1"), false, at))
        roundTrip("UserMutations", ChangePassword("r", MutationAuth.Password("old"), "new"))
        roundTrip("LibraryDBMutation", ChangePassword("r", MutationAuth.Totp("123456"), "new"))
    }

    @Test
    fun unionsOfAStructOrNull() {
        roundTrip("UserBookInfo", UserBookInfo("978-0", "T", 2, listOf("b1", "b2"), null, null))
        roundTrip("UserBookInfo", UserBookInfo("978-0", "T", 0, listOf(), UserHoldInfo("h1", HoldTarget.Edition("978-0"), restricted = false), null))
    }

    @Test
    fun anEnumByItsWireLiteral() {
        val books = listOf(
            AdminBookInfo("b1", false, AdminBookInfoState.OPEN),
            AdminBookInfo("b2", true, AdminBookInfoState.OUT, pending = true, patronId = "p1", checkoutId = "c1"),
        )
        roundTrip("AdminQueries.allEditions#result", listOf(AdminEditionInfo("978-0", "T", books), AdminEditionInfo("978-1", "U", listOf())))
    }

    @Test
    fun nestedArraysOfStructs() {
        val patron = UserPatronInfo(
            "Alice", "red", false,
            listOf(PatronHold("h1", HoldTarget.Book("b1")), PatronHold("h2", HoldTarget.Edition("978-0"), at)),
            listOf(UserCheckoutInfo("c1", "b3", "T", at, true)),
        )
        roundTrip("UserQueries.myPatron#result", patron)
        roundTrip("UserQueries.allBooks#result", listOf(UserBookInfo("978-0", "T", 1, listOf("b1"), null, Checkout("c1", "b2", at, false))))
    }

    @Test
    fun aUnionOfTuplesByLengthAndAnItemsLiteral() {
        roundTrip("UserQuery", listOf("UserQueries.allBooks"))
        roundTrip("AdminQuery", listOf("AdminQueries.roomCreated"))
        assertMismatch("$: no member of UserQuery fits") { library.decode("UserQuery", msg { array(0) }) }
        assertMismatch("$: no member of UserQuery fits") { library.decode("UserQuery", msg { any(listOf("AdminQueries.notices")) }) }
    }

    @Test
    fun aKeyTheSchemaDoesNotNameIsSkipped() {
        val bytes = msg {
            map(3)
            entry("extra", mapOf("deep" to listOf(1, mapOf("x" to 2.5)), "bin" to byteArrayOf(1, 2)))
            entry("isbn", "978-0")
            entry("title", "T")
        }
        assertEquals(Edition("978-0", "T"), library.decode("Edition", bytes))
    }

    @Test
    fun aLiteralFieldIsChecked() {
        val bytes = msg {
            map(4)
            entry("type", "cancel-hold")
            entry("room", "r")
            entry("id", "h1")
            entry("patron", "p1")
        }
        assertMismatch("$.type: expected try-hold") { library.decode("TryHold", bytes) }
    }

    @Test
    fun aMismatchDeepInsideNamesItsPath() {
        val hold = mapOf("id" to "h1", "target" to mapOf("book" to "b1"))
        val bad = mapOf("id" to "h2", "target" to mapOf("copy" to "b1"))
        val bytes = msg {
            map(5)
            entry("name", "Alice")
            entry("color", "red")
            entry("researcher", false)
            entry("holds", listOf(hold, bad))
            entry("checkouts", listOf<Any>())
        }
        assertMismatch("$.holds[1].target: no member of the union fits") {
            library.decode("UserPatronInfo", bytes)
        }
    }
}

/** A registry built by hand, for the node kinds and solutions the library model does not use. */
class RegistryTest {
    // the struct S: a literal discriminator, then a required integer, an optional string, and
    // an optional record, built as the list of its constructor's arguments
    private val struct = SchemaNode.Struct(
        "S",
        listOf(SchemaField("kind", 11, false), SchemaField("a", 0, false), SchemaField("b", 1, true), SchemaField("c", 2, true)),
        0,
        { a -> a.toList() },
        { v -> (v as List<*>).toTypedArray() },
    )

    private val reg = Registry(
        listOf(
            SchemaNode.Int, // 0
            SchemaNode.Str, // 1
            SchemaNode.Record(null, 0), // 2
            SchemaNode.Tuple(null, listOf(1, 0)), // 3
            SchemaNode.Union("Num", Solution.Literal(listOf(1L to Solution.Match(0), "two" to Solution.Match(1)))), // 4
            SchemaNode.Json, // 5
            SchemaNode.Lit(1), // 6
            SchemaNode.Union("Any", Solution.JsonType(listOf("int" to Solution.Match(0), "*" to Solution.Match(5)))), // 7
            SchemaNode.Union("Sized", Solution.Length(listOf(2 to Solution.Match(3)), Solution.Match(9))), // 8
            SchemaNode.Array(null, 0), // 9
            struct, // 10
            SchemaNode.Lit("s"), // 11
            SchemaNode.Union(
                "Second",
                Solution.Index(1, Solution.JsonType(listOf("string" to Solution.Match(13), "null" to Solution.Match(9)))),
            ), // 12
            SchemaNode.Array(null, 1), // 13
            SchemaNode.Union(
                "Keyed",
                Solution.Field("k", Solution.JsonType(listOf("int" to Solution.Match(2), "null" to Solution.Match(5)))),
            ), // 14
            SchemaNode.Array(null, 9), // 15
        ),
        mapOf(
            "record" to 2, "pair" to 3, "num" to 4, "one" to 6, "any" to 7, "sized" to 8, "S" to 10,
            "second" to 12, "keyed" to 14, "grid" to 15,
        ),
        mapOf(),
    )

    private fun decode(type: String, fn: MsgWriter.() -> Unit): Any? = reg.decode(type, msg(fn))

    @Test
    fun records() {
        assertEquals(linkedMapOf("x" to 1L, "y" to -2L), reg.decode("record", reg.encode("record", mapOf("x" to 1, "y" to -2))))
        assertMismatch("$.y: expected an integer") { decode("record") { any(mapOf("x" to 1, "y" to "no")) } }
        assertMismatch("$: expected a map") { decode("record") { any(listOf(1)) } }
    }

    @Test
    fun tuples() {
        assertEquals(listOf("a", 1L), decode("pair") { any(listOf("a", 1)) })
        assertMismatch("$: expected 2 items") { decode("pair") { any(listOf("a")) } }
        assertMismatch("$[1]: expected an integer") { decode("pair") { any(listOf("a", "b")) } }
    }

    @Test
    fun nestedArrays() {
        assertEquals(listOf(listOf(1L), listOf(2L, 3L)), decode("grid") { any(listOf(listOf(1), listOf(2, 3))) })
        assertMismatch("$[1][1]: expected an integer") { decode("grid") { any(listOf(listOf(1), listOf(2, "x"))) } }
    }

    @Test
    fun anIntegerIsNoFloatButALiteralTestComparesNumbers() {
        assertEquals(1L, decode("num") { int(1) })
        assertEquals("two", decode("num") { str("two") })
        assertMismatch("$: expected an integer") { decode("num") { double(1.0) } }
        assertMismatch("$: no member of Num fits") { decode("num") { int(3) } }
        assertEquals(1, decode("one") { int(1) })
        assertMismatch("$: expected 1") { decode("one") { double(1.0) } }
    }

    @Test
    fun aJsonTypeTestFallsToItsWildcard() {
        assertEquals(7L, decode("any") { int(7) })
        assertEquals(1.5, decode("any") { double(1.5) })
        assertEquals(mapOf("x" to listOf(true)), decode("any") { any(mapOf("x" to listOf(true))) })
    }

    @Test
    fun aLengthTestFallsToItsDefault() {
        assertEquals(listOf("a", 1L), decode("sized") { any(listOf("a", 1)) })
        assertEquals(listOf(1L, 2L, 3L), decode("sized") { any(listOf(1, 2, 3)) })
        assertMismatch("$: expected a list") { decode("sized") { str("no") } }
    }

    @Test
    fun anItemOrAFieldThatIsNotThereTestsAsNull() {
        assertEquals(listOf("x", "y"), decode("second") { any(listOf("x", "y")) })
        assertEquals(listOf(5L), decode("second") { any(listOf(5)) })
        assertEquals(linkedMapOf("k" to 1L), decode("keyed") { any(mapOf("k" to 1)) })
        assertEquals(mapOf("j" to "x"), decode("keyed") { any(mapOf("j" to "x")) })
        assertEquals(mapOf("k" to null), decode("keyed") { any(mapOf("k" to null)) })
    }

    @Test
    fun structs() {
        // optional fields left out, and a key the schema does not name passed over
        assertEquals(listOf(1L, null, null), decode("S") { any(mapOf("kind" to "s", "zz" to mapOf("deep" to listOf(1)), "a" to 1)) })
        val full = listOf(1L, "b", linkedMapOf("x" to 2L))
        assertEquals(full, reg.decode("S", reg.encode("S", full)))

        // of a key that repeats, the last entry counts
        assertEquals(listOf(2L, null, null), decode("S") { map(3); entry("kind", "s"); entry("a", "bad"); entry("a", 2) })
        assertMismatch("$.a: expected an integer") { decode("S") { map(3); entry("kind", "s"); entry("a", 2); entry("a", "bad") } }

        // the literal, checked, and every mismatch reported in declaration order
        assertMismatch("$.kind: expected s") { decode("S") { any(mapOf("kind" to "t", "a" to 1)) } }
        assertMismatch("$.kind: missing") { decode("S") { any(mapOf("a" to "bad")) } }
        assertMismatch("$.a: missing") { decode("S") { any(mapOf("c" to mapOf("x" to "bad"), "kind" to "s")) } }
        assertMismatch("$.c.x: expected an integer") { decode("S") { any(mapOf("c" to mapOf("x" to "bad"), "kind" to "s", "a" to 1)) } }
        assertMismatch("$: expected a map") { decode("S") { any(listOf(1)) } }
    }

    @Test
    fun encodingNamesThePathToo() {
        assertMismatch("$.c.x: expected an integer") { reg.encode("S", listOf(1, null, mapOf("x" to "bad"))) }
        assertMismatch("$[0][1]: expected an integer") { reg.encode("grid", listOf(listOf(1, "x"))) }
        assertMismatch("$: expected string keys") { reg.encode("record", mapOf(1 to 1)) }
    }
}

/** The msgpack reader, over bytes no writer makes. */
class MsgpackTest {
    // a count the bytes cannot hold fails as truncated, before anything is allocated for it
    @Test
    fun aCountPastTheBytesFails() {
        for (head in listOf(0xdd, 0xdf)) {
            for (count in listOf(0x7f, 0xff)) {
                val b = intArrayOf(head, count, 0xff, 0xff, 0xff, 0xc0, 0xc0).map { it.toByte() }.toByteArray()
                val e = assertFailsWith<MsgpackError> { MsgReader(b).any() }
                assertEquals("msgpack: truncated", e.message)
            }
        }
    }
}
