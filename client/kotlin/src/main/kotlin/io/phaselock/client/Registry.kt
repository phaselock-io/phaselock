// The Kotlin walk of the generated type registry: the model's types as a node table, as every
// emitter emits it, which this walker interprets to convert Kotlin values to msgpack and back,
// checked against the schema both ways.  Generated code supplies each struct's constructor and
// field getters and each enum's wire values, so the walk builds the generated classes without
// reflection.
//
// A struct writes its discriminator first, the field a union tells it apart by, then the rest
// in declaration order; an optional field that is null is left out.  A literal field is no
// property of its class: the walk writes it from the schema, and checks it on the way back.
// Dates are the msgpack timestamp extension at millisecond precision.  A field the schema does
// not name is dropped.  Reading walks the msgpack itself, into the generated classes in one pass;
// a union's tests look ahead at a value without decoding it, and its member then reads it.

package io.phaselock.client

import java.time.Instant
import kotlin.reflect.KClass

/** How the walk tells a union's members apart, as the union solver decided: each test reads the
    value at hand, or a part of it, until a Match names the member. */
sealed interface Solution {
    class Match(val node: Int) : Solution
    class JsonType(val options: List<Pair<String, Solution>>) : Solution
    class Literal(val options: List<Pair<Any, Solution>>) : Solution
    class Length(val options: List<Pair<Int, Solution>>, val default: Solution?) : Solution
    class Index(val index: Int, val solution: Solution) : Solution
    class Field(val key: String, val solution: Solution) : Solution
    class HasField(val options: List<Pair<String, Solution>>) : Solution
}

/** One field of a struct: its name, its type's node, and whether it may be left out. */
class SchemaField(val name: String, val type: Int, val optional: Boolean)

/** One type of the model.  A struct carries its class's constructor, taking its non-literal
    fields in declaration order, and the getter answering them; an enum, a union of literals,
    carries its constants' wire values. */
sealed interface SchemaNode {
    data object Null : SchemaNode
    data object Int : SchemaNode
    data object Str : SchemaNode
    data object Bool : SchemaNode
    data object Date : SchemaNode
    data object Json : SchemaNode
    class Lit(val value: Any) : SchemaNode
    class Struct(
        val name: String?,
        val fields: List<SchemaField>,
        val discriminator: kotlin.Int,
        val make: (kotlin.Array<Any?>) -> Any,
        val get: (Any) -> kotlin.Array<Any?>,
    ) : SchemaNode
    class Record(val name: String?, val value: kotlin.Int) : SchemaNode
    class Array(val name: String?, val item: kotlin.Int) : SchemaNode
    class Tuple(val name: String?, val items: List<kotlin.Int>) : SchemaNode
    class Union(
        val name: String?,
        val solution: Solution,
        val fromWire: ((Any) -> Any)? = null,
        val toWire: ((Any) -> Any)? = null,
    ) : SchemaNode
    class Intake(val kind: String, val wire: kotlin.Int) : SchemaNode
}

/** A value that fails its type: the first mismatch, with its path. */
class ConvertError(message: String) : Exception(message)

/* A mismatch on its way out of the walk, which each level it leaves places under its own
   segment (`.field`, `[k]`, `.key`), innermost first, so a conversion that succeeds builds no
   path.  It takes no stack trace, since the walk's entry point turns it into a ConvertError. */
private class Mismatch(val what: String) : Exception(null, null, false, false) {
    private val segments = ArrayList<String>()

    fun under(segment: String): Nothing {
        segments.add(segment)
        throw this
    }

    fun error(): ConvertError = ConvertError("\$${segments.asReversed().joinToString("")}: $what")
}

private fun fail(what: String): Nothing = throw Mismatch(what)

// the position of a value that is not there, an item or a field the value lacks, which a
// union's tests read as null
private const val ABSENT = -1

// what a union's literal test sees at an array or a map, which equals no literal
private object NotScalar

// whether a value is a literal option: equal to it, or a number that truncates to the same integer
private fun isLiteral(option: Any, v: Any?): Boolean =
    option == v || (option is Number && v is Number && option.toLong() == v.toLong())

/* How a struct reads: each field's index by its name, and each field's place among the
   constructor's arguments, or -1 for a literal, which the constructor does not take. */
private class StructPlan(n: SchemaNode.Struct, nodes: List<SchemaNode>) {
    val slots = HashMap<String, Int>(n.fields.size * 2)
    val args = IntArray(n.fields.size)
    val argCount: Int

    init {
        var k = 0
        for ((j, f) in n.fields.withIndex()) {
            slots[f.name] = j
            args[j] = if (nodes[f.type] is SchemaNode.Lit) -1 else k++
        }
        argCount = k
    }
}

/** The registry over a model's node table: each identity's node, and the node of each
    generated class, which a union's member is found by. */
class Registry(
    private val nodes: List<SchemaNode>,
    private val ids: Map<String, Int>,
    private val classes: Map<KClass<*>, Int>,
) {
    // each union's members, the nodes its solution can match
    private val members = HashMap<Int, List<Int>>()
    // each struct node's plan, by node
    private val plans: Array<StructPlan?> =
        Array(nodes.size) { i -> (nodes[i] as? SchemaNode.Struct)?.let { StructPlan(it, nodes) } }

    private fun node(type: String): Int = ids[type] ?: throw ConvertError("no registry entry for type $type")

    /** a value as msgpack under a type */
    fun encode(type: String, value: Any?): ByteArray {
        val i = node(type)
        val w = MsgWriter()
        try {
            write(w, i, value)
        } catch (e: Mismatch) {
            throw e.error()
        }
        return w.bytes()
    }

    /** a value of a type, from msgpack */
    fun decode(type: String, bytes: ByteArray): Any? {
        val i = node(type)
        try {
            return read(i, MsgReader(bytes))
        } catch (e: Mismatch) {
            throw e.error()
        }
    }

    private fun membersOf(i: Int): List<Int> = members.getOrPut(i) {
        val out = LinkedHashSet<Int>()
        fun walk(s: Solution) {
            when (s) {
                is Solution.Match -> out.add(s.node)
                is Solution.JsonType -> s.options.forEach { walk(it.second) }
                is Solution.Literal -> s.options.forEach { walk(it.second) }
                is Solution.Length -> { s.options.forEach { walk(it.second) }; s.default?.let(::walk) }
                is Solution.Index -> walk(s.solution)
                is Solution.Field -> walk(s.solution)
                is Solution.HasField -> s.options.forEach { walk(it.second) }
            }
        }
        walk((nodes[i] as SchemaNode.Union).solution)
        out.toList()
    }

    // writing ////////////////////////////////////////////////////////////////

    private fun write(w: MsgWriter, i: Int, v: Any?) {
        when (val n = nodes[i]) {
            SchemaNode.Null -> if (v == null) w.nil() else fail("expected null")
            SchemaNode.Int -> when (v) {
                is Long -> w.int(v)
                is kotlin.Int -> w.int(v.toLong())
                else -> fail("expected an integer")
            }
            SchemaNode.Str -> if (v is String) w.str(v) else fail("expected a string")
            SchemaNode.Bool -> if (v is Boolean) w.bool(v) else fail("expected a boolean")
            SchemaNode.Date -> if (v is Instant) w.timestamp(Instant.ofEpochMilli(v.toEpochMilli())) else fail("expected an Instant")
            SchemaNode.Json -> w.any(v)
            is SchemaNode.Lit -> if (v == null || v == n.value) w.any(n.value) else fail("expected ${n.value}")
            is SchemaNode.Struct -> writeStruct(w, n, v)
            is SchemaNode.Record -> {
                val m = v as? Map<*, *> ?: fail("expected a map")
                w.map(m.size)
                for ((k, value) in m) {
                    w.str(k as? String ?: fail("expected string keys"))
                    try {
                        write(w, n.value, value)
                    } catch (e: Mismatch) {
                        e.under(".$k")
                    }
                }
            }
            is SchemaNode.Array -> {
                val l = v as? List<*> ?: fail("expected a list")
                w.array(l.size)
                l.forEachIndexed { k, item ->
                    try {
                        write(w, n.item, item)
                    } catch (e: Mismatch) {
                        e.under("[$k]")
                    }
                }
            }
            is SchemaNode.Tuple -> {
                val l = v as? List<*> ?: fail("expected a list")
                if (l.size != n.items.size) fail("expected ${n.items.size} items")
                w.array(l.size)
                l.forEachIndexed { k, item ->
                    try {
                        write(w, n.items[k], item)
                    } catch (e: Mismatch) {
                        e.under("[$k]")
                    }
                }
            }
            is SchemaNode.Union -> {
                if (n.toWire != null && v != null) {
                    write(w, member(i, n, n.toWire.invoke(v)), n.toWire.invoke(v))
                } else {
                    write(w, member(i, n, v), v)
                }
            }
            is SchemaNode.Intake -> write(w, n.wire, v)
        }
    }

    private fun writeStruct(w: MsgWriter, n: SchemaNode.Struct, v: Any?) {
        if (v == null) fail("expected ${n.name ?: "a struct"}")
        val values = n.get(v)

        // each field's value, a literal's from the schema, and those present in writing order
        var k = 0
        val all = n.fields.map { f ->
            val lit = nodes[f.type] as? SchemaNode.Lit
            if (lit != null) lit.value else values[k++]
        }
        val order = n.fields.indices.sortedBy { if (it == n.discriminator) -1 else it }
        val present = order.filter { !(n.fields[it].optional && all[it] == null) }
        w.map(present.size)
        for (j in present) {
            w.str(n.fields[j].name)
            try {
                write(w, n.fields[j].type, all[j])
            } catch (e: Mismatch) {
                e.under(".${n.fields[j].name}")
            }
        }
    }

    // the member of a union a value writes as: the one its class names, or the first whose kind
    // fits it, or, for a plain list or map, the one the union's solution picks
    private fun member(i: Int, n: SchemaNode.Union, v: Any?): Int {
        if (v is List<*> || v is Map<*, *>) return solve(n.solution, v) ?: fail("no member of ${n.name ?: "the union"} fits")
        val ms = membersOf(i)
        if (v != null) classes[v::class]?.let { if (it in ms) return it }
        for (m in ms) {
            val fits = when (val mn = nodes[m]) {
                SchemaNode.Null -> v == null
                SchemaNode.Int -> v is Long || v is kotlin.Int
                SchemaNode.Str -> v is String
                SchemaNode.Bool -> v is Boolean
                SchemaNode.Date -> v is Instant
                SchemaNode.Json -> true
                is SchemaNode.Lit -> mn.value == v
                is SchemaNode.Intake -> v is String
                else -> false
            }
            if (fits) return m
        }
        fail("no member of ${n.name ?: "the union"} fits ${if (v == null) "null" else v::class.simpleName}")
    }

    // the JSON type of a plain value, as the union solver names them
    private fun jsonType(v: Any?): String = when (v) {
        null -> "null"
        is Boolean -> "boolean"
        is Long, is kotlin.Int -> "int"
        is String, is Instant -> "string"
        is List<*> -> "array"
        is Map<*, *> -> "object"
        else -> "unknown"
    }

    // the member a plain value belongs to, as the solution tells, or null for none
    private fun solve(s: Solution, v: Any?): Int? = when (s) {
        is Solution.Match -> s.node
        is Solution.JsonType -> s.options.firstOrNull { it.first == jsonType(v) || it.first == "*" }?.let { solve(it.second, v) }
        is Solution.Literal -> s.options.firstOrNull { isLiteral(it.first, v) }?.let { solve(it.second, v) }
        is Solution.Length -> {
            val size = (v as? List<*>)?.size
            (s.options.firstOrNull { it.first == size }?.second ?: s.default)?.let { solve(it, v) }
        }
        is Solution.Index -> solve(s.solution, (v as? List<*>)?.getOrNull(s.index))
        is Solution.Field -> solve(s.solution, (v as? Map<*, *>)?.get(s.key))
        is Solution.HasField -> s.options.firstOrNull { (v as? Map<*, *>)?.containsKey(it.first) == true }?.let { solve(it.second, v) }
    }

    // reading ////////////////////////////////////////////////////////////////

    // the value at the reader's cursor, read by its type straight into the generated classes
    private fun read(i: Int, r: MsgReader): Any? = when (val n = nodes[i]) {
        SchemaNode.Null -> if (r.kind() == MsgKind.NIL) { r.nil(); null } else fail("expected null")
        SchemaNode.Int -> if (r.kind() == MsgKind.INT) r.long() else fail("expected an integer")
        SchemaNode.Str -> if (r.kind() == MsgKind.STR) r.str() else fail("expected a string")
        SchemaNode.Bool -> if (r.kind() == MsgKind.BOOL) r.bool() else fail("expected a boolean")
        SchemaNode.Date -> if (r.kind() == MsgKind.EXT) r.timestamp() else fail("expected a timestamp")
        SchemaNode.Json -> r.any()
        is SchemaNode.Lit -> {
            val v = r.any()
            val lit = n.value
            if (v == lit || (v is Long && lit is Number && v == lit.toLong())) lit else fail("expected $lit")
        }
        is SchemaNode.Struct -> readStruct(plans[i]!!, n, r)
        is SchemaNode.Record -> {
            if (r.kind() != MsgKind.MAP) fail("expected a map")
            val size = r.mapHeader()
            val m = LinkedHashMap<String, Any?>(size)
            repeat(size) {
                val k = r.str()
                m[k] = try { read(n.value, r) } catch (e: Mismatch) { e.under(".$k") }
            }
            m
        }
        is SchemaNode.Array -> {
            if (r.kind() != MsgKind.ARRAY) fail("expected a list")
            readItems(r, r.arrayHeader()) { n.item }
        }
        is SchemaNode.Tuple -> {
            if (r.kind() != MsgKind.ARRAY) fail("expected a list")
            val size = r.arrayHeader()
            if (size != n.items.size) fail("expected ${n.items.size} items")
            readItems(r, size) { n.items[it] }
        }
        is SchemaNode.Union -> {
            // the member the solution picks by looking at the value, which is then read from
            // where it starts
            val start = r.at
            val m = solveAt(n.solution, r, start) ?: fail("no member of ${n.name ?: "the union"} fits")
            r.at = start
            val value = read(m, r)
            if (n.fromWire != null && value != null) n.fromWire.invoke(value) else value
        }
        is SchemaNode.Intake -> read(n.wire, r)
    }

    // an array's items, each read by the type typeOf gives its index
    private inline fun readItems(r: MsgReader, size: Int, typeOf: (Int) -> Int): List<Any?> {
        val l = ArrayList<Any?>(size)
        for (k in 0 until size) l.add(try { read(typeOf(k), r) } catch (e: Mismatch) { e.under("[$k]") })
        return l
    }

    /* A struct, read entry by entry into its constructor's arguments.  A mismatch in a field
       waits until every entry is read, since the first field in declaration order that is
       missing or mismatched is the one reported. */
    private fun readStruct(plan: StructPlan, n: SchemaNode.Struct, r: MsgReader): Any {
        if (r.kind() != MsgKind.MAP) fail("expected a map")
        val args = arrayOfNulls<Any?>(plan.argCount)
        val seen = BooleanArray(n.fields.size)
        var mismatches: Array<Mismatch?>? = null

        // each entry: a field's value read by its type, and a key the schema does not name
        // skipped; of a key that repeats, the last entry counts
        repeat(r.mapHeader()) {
            val j = plan.slots[r.str()]
            if (j == null) {
                r.skip()
                return@repeat
            }
            seen[j] = true
            val start = r.at
            try {
                val v = read(n.fields[j].type, r)
                if (plan.args[j] >= 0) args[plan.args[j]] = v
                mismatches?.set(j, null)
            } catch (e: Mismatch) {
                // the field's mismatch, kept, and the rest of its value passed over
                val held = mismatches ?: arrayOfNulls<Mismatch>(n.fields.size).also { mismatches = it }
                held[j] = e
                r.at = start
                r.skip()
            }
        }

        // the first field, in declaration order, that mismatched or is missing
        for ((j, f) in n.fields.withIndex()) {
            mismatches?.get(j)?.under(".${f.name}")
            if (!seen[j] && !f.optional) Mismatch("missing").under(".${f.name}")
        }
        return n.make(args)
    }

    // the union tests, which look at a value from its position without decoding it

    // the member the value at a position belongs to, as the solution tells, or null for none
    private fun solveAt(s: Solution, r: MsgReader, at: Int): Int? = when (s) {
        is Solution.Match -> s.node
        is Solution.JsonType -> {
            val t = jsonTypeAt(r, at)
            s.options.firstOrNull { it.first == t || it.first == "*" }?.let { solveAt(it.second, r, at) }
        }
        is Solution.Literal -> {
            val v = scalarAt(r, at)
            s.options.firstOrNull { isLiteral(it.first, v) }?.let { solveAt(it.second, r, at) }
        }
        is Solution.Length -> {
            val size = lengthAt(r, at)
            (s.options.firstOrNull { it.first == size }?.second ?: s.default)?.let { solveAt(it, r, at) }
        }
        is Solution.Index -> solveAt(s.solution, r, itemAt(r, at, s.index))
        is Solution.Field -> solveAt(s.solution, r, fieldAt(r, at, s.key))
        is Solution.HasField -> s.options.firstOrNull { hasField(r, at, it.first) }?.let { solveAt(it.second, r, at) }
    }

    // the JSON type of the value at a position, as jsonType names the plain value's
    private fun jsonTypeAt(r: MsgReader, at: Int): String {
        if (at == ABSENT) return "null"
        r.at = at
        return when (r.kind()) {
            MsgKind.NIL -> "null"
            MsgKind.BOOL -> "boolean"
            MsgKind.INT -> "int"
            MsgKind.STR, MsgKind.EXT -> "string" // an extension reads as a timestamp
            MsgKind.ARRAY -> "array"
            MsgKind.MAP -> "object"
            MsgKind.FLOAT, MsgKind.BIN -> "unknown"
        }
    }

    // the scalar at a position, as MsgReader.any reads it, or NotScalar at an array or a map
    private fun scalarAt(r: MsgReader, at: Int): Any? {
        if (at == ABSENT) return null
        r.at = at
        val k = r.kind()
        return if (k == MsgKind.ARRAY || k == MsgKind.MAP) NotScalar else r.any()
    }

    // the length of the array at a position, or null for any other value
    private fun lengthAt(r: MsgReader, at: Int): Int? {
        if (at == ABSENT) return null
        r.at = at
        return if (r.kind() == MsgKind.ARRAY) r.arrayHeader() else null
    }

    // the position of an array's item, or ABSENT when the value has no such item
    private fun itemAt(r: MsgReader, at: Int, index: Int): Int {
        if (at == ABSENT) return ABSENT
        r.at = at
        if (r.kind() != MsgKind.ARRAY) return ABSENT
        if (index !in 0 until r.arrayHeader()) return ABSENT
        repeat(index) { r.skip() }
        return r.at
    }

    // the position of a map's field, the last of a key that repeats, or ABSENT when the value has
    // no such field
    private fun fieldAt(r: MsgReader, at: Int, key: String): Int {
        if (at == ABSENT) return ABSENT
        r.at = at
        if (r.kind() != MsgKind.MAP) return ABSENT
        var found = ABSENT
        repeat(r.mapHeader()) {
            if (r.str() == key) found = r.at
            r.skip()
        }
        return found
    }

    // whether the value at a position is a map with the key
    private fun hasField(r: MsgReader, at: Int, key: String): Boolean = fieldAt(r, at, key) != ABSENT
}

/** A fresh series for mutations numbered outside an Engine: 16 random bytes, base64url. */
fun generateSeries(): String {
    val b = ByteArray(16)
    java.security.SecureRandom().nextBytes(b)
    return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b)
}
