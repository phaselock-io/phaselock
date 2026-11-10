package io.phaselock.client

import com.sun.net.httpserver.HttpServer
import java.io.IOException
import java.net.InetSocketAddress
import java.util.concurrent.Executors
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okio.Buffer

/** An origin on a loopback port whose stream opens at position 40 of epoch e3 and stays open,
    whose tail has nothing, and whose snapshot is the test's bytes. */
private class Origin(snapshot: ByteArray) : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val url get() = "http://127.0.0.1:${server.address.port}"

    init {
        server.executor = Executors.newCachedThreadPool()

        // the stream's headers, and a body left open until the origin closes
        server.createContext("/stream") { x ->
            x.responseHeaders.add("Content-Type", "application/msgpack")
            x.responseHeaders.add("PhaseLock-Epoch", "e3")
            x.responseHeaders.add("PhaseLock-Position", "40")
            x.sendResponseHeaders(200, 0)
            x.responseBody.flush()
        }

        // a tail that scanned to until at once
        server.createContext("/edits/") { x ->
            val before = Regex("before=(\\d+)").find(x.requestURI.query)!!.groupValues[1]
            x.responseHeaders.add("Content-Type", "application/msgpack")
            x.responseHeaders.add("PhaseLock-Scanned", before)
            x.sendResponseHeaders(200, -1)
            x.close()
        }

        server.createContext("/snapshot/") { x ->
            x.responseHeaders.add("Content-Type", "application/octet-stream")
            x.responseHeaders.add("PhaseLock-Epoch", "e3")
            x.responseHeaders.add("PhaseLock-Position", "40")
            x.sendResponseHeaders(200, snapshot.size.toLong())
            x.responseBody.write(snapshot)
            x.close()
        }
        server.start()
    }

    override fun close() = server.stop(0)
}

private object Quiet : ConnectionHooks {
    override fun onOpen(epoch: String, head: Long) {}
    override fun onView(token: String, position: Long, selectors: List<String>) {}
    override fun onEdits(edits: ByteArray) {}
    override fun onLive(position: Long) {}
    override fun onVouch(position: Long) {}
    override fun onEnd(code: Int, reason: String, fatal: AuthError?) {}
}

// a blob's start: its magic and version, and a header of length hlen
private fun start(hlen: Long): Buffer = Buffer().writeUtf8("PLSN").writeByte(1).writeInt(hlen.toInt())

// a blob's start with a whole header for position 40 of epoch e3
private fun headed(): Buffer {
    val header = encodeAny(mapOf("epoch" to "e3", "position" to 40L, "visible" to 40L, "slices" to emptyMap<String, Long>()))
    return start(header.size.toLong()).write(header).writeInt(crc32c(header).toInt())
}

class HttpTest {
    // the error a backfill of the snapshot fails with
    private fun failure(snapshot: ByteArray): String = Origin(snapshot).use { origin ->
        val transport = HttpTransport(origin.url)
        val conn = transport.connect(-1, null, listOf("*"), null, Quiet)
        try {
            val e = assertFailsWith<IOException> {
                runBlocking { withTimeout(10_000) { conn.backfill(Backfill("patron:*", 45, null) {}) } }
            }
            e.message ?: ""
        } finally {
            conn.abort()
            transport.close()
        }
    }

    @Test
    fun aHeaderLengthPastTheMostAHeaderHoldsFails() {
        val msg = failure(start(0xffff_ffffL).writeUtf8("short").readByteArray())
        assertTrue(msg.contains("header too long"), msg)
    }

    @Test
    fun anOperationLengthPastTheMostAnOperationHoldsFails() {
        // a set whose key claims a str of 4 GiB
        val msg = failure(headed().writeByte(0x00).write(byteArrayOf(0xdb.toByte(), -1, -1, -1, -1)).writeUtf8("short").readByteArray())
        assertTrue(msg.contains("corrupt operation"), msg)
    }
}
