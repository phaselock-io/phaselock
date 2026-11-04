// Mutation ids: a uuid string in the Engine and in app code, its 16 bytes on the wire.

package io.phaselock.client

private val UUID_HEX = Regex("^[0-9a-fA-F]{32}$")

/** the 16 bytes of a uuid written as 32 hex digits, dashed or not, in either case */
fun uuidBytes(id: String): ByteArray {
    val hex = id.replace("-", "")
    require(UUID_HEX.matches(hex)) { "mutation id is not a uuid: $id" }
    return ByteArray(16) { i -> hex.substring(2 * i, 2 * i + 2).toInt(16).toByte() }
}

/** a fresh version 4 uuid, lower-case */
fun generateUuid(): String = java.util.UUID.randomUUID().toString()
