// The snapshot blob's checksums: CRC-32C per record and header, FNV-1a 64 over the records.

package io.phaselock.client

private val crcTable = IntArray(256) { i ->
    var c = i
    repeat(8) { c = if (c and 1 != 0) 0x82f63b78.toInt() xor (c ushr 1) else c ushr 1 }
    c
}

fun crc32c(bytes: ByteArray, from: Int = 0, to: Int = bytes.size): Long {
    var c = 0.inv()
    for (i in from until to) c = crcTable[(c xor bytes[i].toInt()) and 0xff] xor (c ushr 8)
    return c.inv().toLong() and 0xffffffffL
}

/** FNV-1a 64, whose running state a resumed download continues from. */
class Fnv64(private var h: Long = OFFSET) {
    fun update(bytes: ByteArray, from: Int = 0, to: Int = bytes.size) {
        for (i in from until to) {
            h = h xor (bytes[i].toLong() and 0xff)
            h *= PRIME
        }
    }

    /** the running state as 16 hex digits, the digest so far */
    fun state(): String = java.lang.Long.toUnsignedString(h, 16).padStart(16, '0')

    /** the big-endian digest */
    fun digest(): ByteArray = ByteArray(8) { i -> (h ushr (8 * (7 - i))).toByte() }

    companion object {
        private const val OFFSET = -0x340d631b7bdddcdbL // 0xcbf29ce484222325
        private const val PRIME = 0x100000001b3L

        fun resume(state: String): Fnv64 {
            require(Regex("^[0-9a-f]{16}$").matches(state)) { "bad FNV-1a 64 state $state" }
            return Fnv64(java.lang.Long.parseUnsignedLong(state, 16))
        }
    }
}
