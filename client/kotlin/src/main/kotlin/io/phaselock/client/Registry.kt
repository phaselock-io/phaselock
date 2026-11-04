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
// not name is dropped.

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

/** The registry over a model's node table: each identity's node, and the node of each
    generated class, which a union's member is found by. */
class Registry(
    private val nodes: List<SchemaNode>,
    private val ids: Map<String, Int>,
    private val classes: Map<KClass<*>, Int>,
) {
    // each union's members, the nodes its solution can match
    private val members = HashMap<Int, List<Int>>()

    private fun node(type: String): Int = ids[type] ?: throw ConvertError("no registry entry for type $type")

    /** a value as msgpack under a type */
    fun encode(type: String, value: Any?): ByteArray {
        val w = MsgWriter()
        write(w, node(type), value, "$")
        return w.bytes()
    }

    /** a value of a type, from msgpack */
    fun decode(type: String, bytes: ByteArray): Any? = read(node(type), MsgReader(bytes).any(), "$")

    private fun fail(path: String, what: String): Nothing = throw ConvertError("$path: $what")

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

    private fun write(w: MsgWriter, i: Int, v: Any?, path: String) {
        when (val n = nodes[i]) {
            SchemaNode.Null -> if (v == null) w.nil() else fail(path, "expected null")
            SchemaNode.Int -> when (v) {
                is Long -> w.int(v)
                is kotlin.Int -> w.int(v.toLong())
                else -> fail(path, "expected an integer")
            }
            SchemaNode.Str -> if (v is String) w.str(v) else fail(path, "expected a string")
            SchemaNode.Bool -> if (v is Boolean) w.bool(v) else fail(path, "expected a boolean")
            SchemaNode.Date -> if (v is Instant) w.timestamp(Instant.ofEpochMilli(v.toEpochMilli())) else fail(path, "expected an Instant")
            SchemaNode.Json -> w.any(v)
            is SchemaNode.Lit -> if (v == null || v == n.value) w.any(n.value) else fail(path, "expected ${n.value}")
            is SchemaNode.Struct -> writeStruct(w, n, v, path)
            is SchemaNode.Record -> {
                val m = v as? Map<*, *> ?: fail(path, "expected a map")
                w.map(m.size)
                for ((k, value) in m) {
                    w.str(k as? String ?: fail(path, "expected string keys"))
                    write(w, n.value, value, "$path.$k")
                }
            }
            is SchemaNode.Array -> {
                val l = v as? List<*> ?: fail(path, "expected a list")
                w.array(l.size)
                l.forEachIndexed { k, item -> write(w, n.item, item, "$path[$k]") }
            }
            is SchemaNode.Tuple -> {
                val l = v as? List<*> ?: fail(path, "expected a list")
                if (l.size != n.items.size) fail(path, "expected ${n.items.size} items")
                w.array(l.size)
                l.forEachIndexed { k, item -> write(w, n.items[k], item, "$path[$k]") }
            }
            is SchemaNode.Union -> {
                if (n.toWire != null && v != null) {
                    write(w, member(i, n, n.toWire.invoke(v), path), n.toWire.invoke(v), path)
                } else {
                    write(w, member(i, n, v, path), v, path)
                }
            }
            is SchemaNode.Intake -> write(w, n.wire, v, path)
        }
    }

    private fun writeStruct(w: MsgWriter, n: SchemaNode.Struct, v: Any?, path: String) {
        if (v == null) fail(path, "expected ${n.name ?: "a struct"}")
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
            write(w, n.fields[j].type, all[j], "$path.${n.fields[j].name}")
        }
    }

    // the member of a union a value writes as: the one its class names, or the first whose kind
    // fits it, or, for a plain list or map, the one the union's solution picks
    private fun member(i: Int, n: SchemaNode.Union, v: Any?, path: String): Int {
        if (v is List<*> || v is Map<*, *>) return solve(n.solution, v) ?: fail(path, "no member of ${n.name ?: "the union"} fits")
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
        fail(path, "no member of ${n.name ?: "the union"} fits ${if (v == null) "null" else v::class.simpleName}")
    }

    // reading ////////////////////////////////////////////////////////////////

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
        is Solution.Literal -> s.options.firstOrNull { it.first == v || (it.first is Number && v is Number && (it.first as Number).toLong() == v.toLong()) }?.let { solve(it.second, v) }
        is Solution.Length -> {
            val size = (v as? List<*>)?.size
            (s.options.firstOrNull { it.first == size }?.second ?: s.default)?.let { solve(it, v) }
        }
        is Solution.Index -> solve(s.solution, (v as? List<*>)?.getOrNull(s.index))
        is Solution.Field -> solve(s.solution, (v as? Map<*, *>)?.get(s.key))
        is Solution.HasField -> s.options.firstOrNull { (v as? Map<*, *>)?.containsKey(it.first) == true }?.let { solve(it.second, v) }
    }

    private fun read(i: Int, v: Any?, path: String): Any? = when (val n = nodes[i]) {
        SchemaNode.Null -> if (v == null) null else fail(path, "expected null")
        SchemaNode.Int -> v as? Long ?: fail(path, "expected an integer")
        SchemaNode.Str -> v as? String ?: fail(path, "expected a string")
        SchemaNode.Bool -> v as? Boolean ?: fail(path, "expected a boolean")
        SchemaNode.Date -> v as? Instant ?: fail(path, "expected a timestamp")
        SchemaNode.Json -> v
        is SchemaNode.Lit -> {
            val lit = n.value
            if (v == lit || (v is Long && lit is Number && v == lit.toLong())) lit else fail(path, "expected $lit")
        }
        is SchemaNode.Struct -> {
            val m = v as? Map<*, *> ?: fail(path, "expected a map")
            val args = ArrayList<Any?>(n.fields.size)
            for (f in n.fields) {
                val fp = "$path.${f.name}"
                if (!m.containsKey(f.name)) {
                    if (!f.optional) fail(fp, "missing")
                    if (nodes[f.type] !is SchemaNode.Lit) args.add(null)
                    continue
                }
                val value = read(f.type, m[f.name], fp)
                if (nodes[f.type] !is SchemaNode.Lit) args.add(value)
            }
            n.make(args.toTypedArray())
        }
        is SchemaNode.Record -> {
            val m = v as? Map<*, *> ?: fail(path, "expected a map")
            LinkedHashMap<String, Any?>(m.size).apply { for ((k, value) in m) put(k as String, read(n.value, value, "$path.$k")) }
        }
        is SchemaNode.Array -> {
            val l = v as? List<*> ?: fail(path, "expected a list")
            l.mapIndexed { k, item -> read(n.item, item, "$path[$k]") }
        }
        is SchemaNode.Tuple -> {
            val l = v as? List<*> ?: fail(path, "expected a list")
            if (l.size != n.items.size) fail(path, "expected ${n.items.size} items")
            l.mapIndexed { k, item -> read(n.items[k], item, "$path[$k]") }
        }
        is SchemaNode.Union -> {
            val m = solve(n.solution, v) ?: fail(path, "no member of ${n.name ?: "the union"} fits")
            val value = read(m, v, path)
            if (n.fromWire != null && value != null) n.fromWire.invoke(value) else value
        }
        is SchemaNode.Intake -> read(n.wire, v, path)
    }
}

/** A fresh series for mutations numbered outside an Engine: 16 random bytes, base64url. */
fun generateSeries(): String {
    val b = ByteArray(16)
    java.security.SecureRandom().nextBytes(b)
    return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b)
}
