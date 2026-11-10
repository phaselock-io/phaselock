// Msgpack: a writer that picks the smallest encoding of every integer, string, and container, so
// the bytes it writes are the encoding every PhaseLock host writes, and a pull reader over bytes.
// A timestamp is the msgpack timestamp extension, type -1.

package io.phaselock.client

import java.io.ByteArrayOutputStream
import java.time.Instant
import okio.Buffer
import okio.BufferedSource

/** the msgpack timestamp extension's type */
const val EXT_TIMESTAMP: Byte = -1

/** A msgpack writer over a growable buffer. */
class MsgWriter {
    private val out = ByteArrayOutputStream()

    fun bytes(): ByteArray = out.toByteArray()

    private fun byte(b: Int) = out.write(b and 0xff)

    private fun be(v: Long, n: Int) {
        for (i in n - 1 downTo 0) byte((v ushr (8 * i)).toInt())
    }

    fun nil() = byte(0xc0)

    fun bool(b: Boolean) = byte(if (b) 0xc3 else 0xc2)

    fun int(v: Long) {
        when {
            v >= 0 -> uint(v)
            v >= -32 -> byte(v.toInt())
            v >= Byte.MIN_VALUE -> { byte(0xd0); be(v, 1) }
            v >= Short.MIN_VALUE -> { byte(0xd1); be(v, 2) }
            v >= Int.MIN_VALUE -> { byte(0xd2); be(v, 4) }
            else -> { byte(0xd3); be(v, 8) }
        }
    }

    fun int(v: Int) = int(v.toLong())

    private fun uint(v: Long) {
        when {
            v < 0x80 -> byte(v.toInt())
            v < 0x100 -> { byte(0xcc); be(v, 1) }
            v < 0x10000 -> { byte(0xcd); be(v, 2) }
            v < 0x100000000 -> { byte(0xce); be(v, 4) }
            else -> { byte(0xcf); be(v, 8) }
        }
    }

    fun double(d: Double) {
        byte(0xcb)
        be(d.toRawBits(), 8)
    }

    fun str(s: String) = str(s.encodeToByteArray())

    /** a string given as its UTF-8 bytes */
    fun str(b: ByteArray) {
        val n = b.size
        when {
            n < 32 -> byte(0xa0 or n)
            n < 0x100 -> { byte(0xd9); be(n.toLong(), 1) }
            n < 0x10000 -> { byte(0xda); be(n.toLong(), 2) }
            else -> { byte(0xdb); be(n.toLong(), 4) }
        }
        out.write(b)
    }

    fun bin(b: ByteArray) {
        val n = b.size
        when {
            n < 0x100 -> { byte(0xc4); be(n.toLong(), 1) }
            n < 0x10000 -> { byte(0xc5); be(n.toLong(), 2) }
            else -> { byte(0xc6); be(n.toLong(), 4) }
        }
        out.write(b)
    }

    /** a timestamp in the smallest of the extension's three sizes */
    fun timestamp(t: Instant) {
        val sec = t.epochSecond
        val nsec = t.nano.toLong()
        when {
            nsec == 0L && sec in 0..0xffffffffL -> { byte(0xd6); byte(-1); be(sec, 4) }
            sec in 0..0x3ffffffffL -> { byte(0xd7); byte(-1); be((nsec shl 34) or sec, 8) }
            else -> { byte(0xc7); byte(12); byte(-1); be(nsec, 4); be(sec, 8) }
        }
    }

    fun array(n: Int) {
        when {
            n < 16 -> byte(0x90 or n)
            n < 0x10000 -> { byte(0xdc); be(n.toLong(), 2) }
            else -> { byte(0xdd); be(n.toLong(), 4) }
        }
    }

    fun map(n: Int) {
        when {
            n < 16 -> byte(0x80 or n)
            n < 0x10000 -> { byte(0xde); be(n.toLong(), 2) }
            else -> { byte(0xdf); be(n.toLong(), 4) }
        }
    }

    /** bytes that are already msgpack, as they are */
    fun raw(b: ByteArray) = out.write(b)

    /** A plain value: null, a Boolean, an integer, a Double, a String, a ByteArray as bin, an
        Instant as a timestamp, a List, or a Map with String keys. */
    fun any(v: Any?) {
        when (v) {
            null -> nil()
            is Boolean -> bool(v)
            is Int -> int(v.toLong())
            is Long -> int(v)
            is Double -> if (v == Math.floor(v) && Math.abs(v) < 9.007199254740992E15) int(v.toLong()) else double(v)
            is String -> str(v)
            is ByteArray -> bin(v)
            is Instant -> timestamp(v)
            is List<*> -> { array(v.size); v.forEach { any(it) } }
            is Map<*, *> -> {
                map(v.size)
                for ((k, value) in v) {
                    str(k as String)
                    any(value)
                }
            }
            else -> throw IllegalArgumentException("not a plain value: ${v::class}")
        }
    }
}

/** the msgpack of a plain value, as MsgWriter.any writes it */
fun encodeAny(v: Any?): ByteArray = MsgWriter().apply { any(v) }.bytes()

/** a plain value from msgpack, as MsgReader.any reads it */
fun decodeAny(b: ByteArray): Any? = MsgReader(b).run { any().also { if (!done) throw MsgpackError("trailing bytes") } }

class MsgpackError(message: String) : Exception(message)

/** The kinds of msgpack value, as a value's type byte tells them; EXT is an extension, a
    timestamp among them, or a byte no value starts with. */
enum class MsgKind { NIL, BOOL, INT, FLOAT, STR, BIN, ARRAY, MAP, EXT }

/** A pull reader over msgpack bytes.  Each read takes one value at the cursor, or fails. */
class MsgReader(private val b: ByteArray, var at: Int = 0, private val end: Int = b.size) {
    val done: Boolean get() = at >= end

    private fun need(n: Int) {
        if (n < 0 || end - at < n) throw MsgpackError("msgpack: truncated")
    }

    private fun u8(): Int {
        need(1)
        return b[at++].toInt() and 0xff
    }

    private fun be(n: Int): Long {
        need(n)
        var v = 0L
        repeat(n) { v = (v shl 8) or (b[at++].toLong() and 0xff) }
        return v
    }

    /** the type byte at the cursor, without consuming it */
    fun peek(): Int {
        need(1)
        return b[at].toInt() and 0xff
    }

    fun isNil(): Boolean = peek() == 0xc0

    /** the kind of the value at the cursor, without consuming it */
    fun kind(): MsgKind {
        val c = peek()
        return when {
            c == 0xc0 -> MsgKind.NIL
            c == 0xc2 || c == 0xc3 -> MsgKind.BOOL
            c <= 0x7f || c >= 0xe0 || c in 0xcc..0xd3 -> MsgKind.INT
            c == 0xca || c == 0xcb -> MsgKind.FLOAT
            c in 0xa0..0xbf || c in 0xd9..0xdb -> MsgKind.STR
            c in 0xc4..0xc6 -> MsgKind.BIN
            c in 0x90..0x9f || c == 0xdc || c == 0xdd -> MsgKind.ARRAY
            c in 0x80..0x8f || c == 0xde || c == 0xdf -> MsgKind.MAP
            else -> MsgKind.EXT
        }
    }

    fun nil() {
        if (u8() != 0xc0) throw MsgpackError("expected nil")
    }

    /** an array's count, failing as truncated past what the bytes left hold at a byte an item */
    fun arrayHeader(): Int {
        val n = when (val c = u8()) {
            in 0x90..0x9f -> (c and 0x0f).toLong()
            0xdc -> be(2)
            0xdd -> be(4)
            else -> throw MsgpackError("expected an array")
        }
        if (n > end - at) throw MsgpackError("msgpack: truncated")
        return n.toInt()
    }

    /** a map's count, failing as truncated past what the bytes left hold at two bytes an entry */
    fun mapHeader(): Int {
        val n = when (val c = u8()) {
            in 0x80..0x8f -> (c and 0x0f).toLong()
            0xde -> be(2)
            0xdf -> be(4)
            else -> throw MsgpackError("expected a map")
        }
        if (2 * n > end - at) throw MsgpackError("msgpack: truncated")
        return n.toInt()
    }

    fun long(): Long = when (val c = u8()) {
        in 0x00..0x7f -> c.toLong()
        in 0xe0..0xff -> (c.toByte()).toLong()
        0xcc -> be(1)
        0xcd -> be(2)
        0xce -> be(4)
        0xcf -> be(8).also { if (it < 0) throw MsgpackError("integer past 64 bits") }
        0xd0 -> be(1).toByte().toLong()
        0xd1 -> be(2).toShort().toLong()
        0xd2 -> be(4).toInt().toLong()
        0xd3 -> be(8)
        0xca, 0xcb -> {
            at--
            val d = double()
            if (d != Math.floor(d) || Math.abs(d) > 9.007199254740992E15) throw MsgpackError("expected an integer")
            d.toLong()
        }
        else -> throw MsgpackError("expected an integer")
    }

    fun int(): Int = long().toInt()

    fun double(): Double = when (u8()) {
        0xca -> Float.fromBits(be(4).toInt()).toDouble()
        0xcb -> Double.fromBits(be(8))
        else -> { at--; long().toDouble() }
    }

    fun bool(): Boolean = when (u8()) {
        0xc2 -> false
        0xc3 -> true
        else -> throw MsgpackError("expected a boolean")
    }

    private fun strLen(): Int = when (val c = u8()) {
        in 0xa0..0xbf -> c and 0x1f
        0xd9 -> be(1).toInt()
        0xda -> be(2).toInt()
        0xdb -> be(4).toInt()
        else -> throw MsgpackError("expected a string")
    }

    fun str(): String {
        val n = strLen()
        need(n)
        return String(b, at, n, Charsets.UTF_8).also { at += n }
    }

    fun bin(): ByteArray {
        val n = when (u8()) {
            0xc4 -> be(1).toInt()
            0xc5 -> be(2).toInt()
            0xc6 -> be(4).toInt()
            else -> throw MsgpackError("expected bin")
        }
        need(n)
        return b.copyOfRange(at, at + n).also { at += n }
    }

    /** a timestamp extension, in any of its three sizes */
    fun timestamp(): Instant {
        val (type, len) = when (val c = u8()) {
            0xd6 -> u8().toByte() to 4
            0xd7 -> u8().toByte() to 8
            0xc7 -> { val n = u8(); u8().toByte() to n }
            else -> throw MsgpackError("expected a timestamp, found 0x${c.toString(16)}")
        }
        if (type != EXT_TIMESTAMP) throw MsgpackError("expected a timestamp")
        return when (len) {
            4 -> Instant.ofEpochSecond(be(4))
            8 -> { val v = be(8); Instant.ofEpochSecond(v and 0x3ffffffffL, v ushr 34) }
            12 -> { val nsec = be(4); Instant.ofEpochSecond(be(8), nsec) }
            else -> throw MsgpackError("a timestamp of $len bytes")
        }
    }

    /** the next value's bytes, consumed whole and undecoded */
    fun raw(): ByteArray {
        val start = at
        skip()
        return b.copyOfRange(start, at)
    }

    /** consumes the next value without decoding it */
    fun skip() {
        var pending = 1L
        while (pending > 0) {
            pending--
            val c = u8()
            val (payload, items) = when (c) {
                in 0x00..0x7f, in 0xe0..0xff, 0xc0, 0xc2, 0xc3 -> 0L to 0L
                in 0x80..0x8f -> 0L to 2L * (c and 0x0f)
                in 0x90..0x9f -> 0L to (c and 0x0f).toLong()
                in 0xa0..0xbf -> (c and 0x1f).toLong() to 0L
                0xc4, 0xd9 -> be(1) to 0L
                0xc5, 0xda -> be(2) to 0L
                0xc6, 0xdb -> be(4) to 0L
                0xc7 -> be(1) + 1 to 0L
                0xc8 -> be(2) + 1 to 0L
                0xc9 -> be(4) + 1 to 0L
                0xcc, 0xd0 -> 1L to 0L
                0xcd, 0xd1 -> 2L to 0L
                0xca, 0xce, 0xd2 -> 4L to 0L
                0xcb, 0xcf, 0xd3 -> 8L to 0L
                in 0xd4..0xd8 -> (1L + (1 shl (c - 0xd4))) to 0L
                0xdc -> 0L to be(2)
                0xdd -> 0L to be(4)
                0xde -> 0L to 2 * be(2)
                0xdf -> 0L to 2 * be(4)
                else -> throw MsgpackError("msgpack: invalid")
            }
            if (payload > end - at) throw MsgpackError("msgpack: truncated")
            at += payload.toInt()
            pending += items
            if (pending > end - at) throw MsgpackError("msgpack: truncated")
        }
    }

    /** A plain value: nil as null, booleans, integers as Long, floats as Double, strings, bin as
        ByteArray, a timestamp as an Instant, arrays as List, maps as Map with String keys. */
    fun any(): Any? = when (kind()) {
        MsgKind.NIL -> { nil(); null }
        MsgKind.BOOL -> bool()
        MsgKind.INT -> long()
        MsgKind.FLOAT -> double()
        MsgKind.STR -> str()
        MsgKind.BIN -> bin()
        MsgKind.ARRAY -> List(arrayHeader()) { any() }
        MsgKind.MAP -> {
            val n = mapHeader()
            val m = LinkedHashMap<String, Any?>(n)
            repeat(n) { m[str()] = any() }
            m
        }
        MsgKind.EXT -> timestamp()
    }
}

/** a value that would run past the limit its read was given */
class PastLimit : Exception("msgpack: a value past its limit")

/* Reads one msgpack value from a stream into out, whole and undecoded, blocking until it has
   arrived; false when the stream ends cleanly before the value starts.  Headers alone are
   decoded, so a value of any size and depth reads in one pass.  A value that would take out past
   limit bytes throws PastLimit before its payload is read. */
fun readValue(src: BufferedSource, out: Buffer, limit: Long = Long.MAX_VALUE): Boolean {
    if (src.exhausted()) return false
    var pending = 1L
    while (pending > 0) {
        pending--
        val c = src.readByte().toInt() and 0xff
        out.writeByte(c)
        fun be(n: Int): Long {
            var v = 0L
            repeat(n) {
                val x = src.readByte().toInt() and 0xff
                out.writeByte(x)
                v = (v shl 8) or x.toLong()
            }
            return v
        }
        val (payload, items) = when (c) {
            in 0x00..0x7f, in 0xe0..0xff, 0xc0, 0xc2, 0xc3 -> 0L to 0L
            in 0x80..0x8f -> 0L to 2L * (c and 0x0f)
            in 0x90..0x9f -> 0L to (c and 0x0f).toLong()
            in 0xa0..0xbf -> (c and 0x1f).toLong() to 0L
            0xc4, 0xd9 -> be(1) to 0L
            0xc5, 0xda -> be(2) to 0L
            0xc6, 0xdb -> be(4) to 0L
            0xc7 -> be(1) + 1 to 0L
            0xc8 -> be(2) + 1 to 0L
            0xc9 -> be(4) + 1 to 0L
            0xcc, 0xd0 -> 1L to 0L
            0xcd, 0xd1 -> 2L to 0L
            0xca, 0xce, 0xd2 -> 4L to 0L
            0xcb, 0xcf, 0xd3 -> 8L to 0L
            in 0xd4..0xd8 -> (1L + (1 shl (c - 0xd4))) to 0L
            0xdc -> 0L to be(2)
            0xdd -> 0L to be(4)
            0xde -> 0L to 2 * be(2)
            0xdf -> 0L to 2 * be(4)
            else -> throw MsgpackError("msgpack: invalid")
        }
        if (payload > limit - out.size) throw PastLimit()
        src.readFully(out, payload)
        pending += items
    }
    return true
}
