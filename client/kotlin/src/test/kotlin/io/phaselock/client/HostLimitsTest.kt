package io.phaselock.client

import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

// a native bundle of one Engine, which runs forever when asked to reconnect
private val SPINNER = """
    globalThis.__engines = {
      Spinner: { create: () => ({ reconnectNow() { for (;;) {} } }) },
    };
""".trimIndent().encodeToByteArray()

/* A native bundle of two Engines: an Ender, which ends as it is created, and a Faulty, which
   when asked to reconnect raises an event that is too short, then one that fails, then its end. */
private val FAULTS = """
    globalThis.__engines = {
      Ender: { create: (_transport, o) => { o.onError(new Error('gone')); return {}; } },
      Faulty: {
        create: (_transport, o) => ({
          reconnectNow() {
            __pl.emit(['connect', 1, 2, 0]);
            __pl.emit(['queryResult', 1]);
            o.onError(new Error('gone'));
          },
        }),
      },
    };
""".trimIndent().encodeToByteArray()

// a transport the Spinner never uses
private object Nowhere : Transport {
    override fun connect(
        since: Long,
        view: String?,
        wants: List<String>,
        session: Session?,
        hooks: ConnectionHooks,
    ): Connection = throw IOException("nowhere")

    override suspend fun post(mutations: List<Mutation>, session: Session?): List<MutationResult> =
        throw IOException("nowhere")
}

class HostLimitsTest {
    @Test
    fun aCallPastItsLimitEndsEveryEngineAndTheHost() = runBlocking<Unit> {
        withTimeout(10_000) {
            val host = EngineHost.open(SPINNER, "spinner.js", Nowhere, EngineLimits(callTimeout = 200.milliseconds))
            val engines = List(2) { host.createEngine("Spinner", null) }
            val ends = CopyOnWriteArrayList<EngineEnded>()
            val heard = CompletableDeferred<Unit>()
            for (e in engines) {
                e.onEnded {
                    ends.add(it)
                    if (ends.size == engines.size) heard.complete(Unit)
                }
            }

            // one Engine's call runs away, and every Engine hears why, with the JS's backtrace
            engines[0].reconnectNow()
            heard.await()
            for (e in ends) {
                assertTrue(e.reason.startsWith("the call ran past its limit of 200ms: InternalError: interrupted\n"), e.reason)
                assertTrue("at reconnectNow" in e.reason, e.reason)
                assertFalse(e.auth)
            }
            assertEquals(2, ends.size)

            // a listener given after the end hears it at once
            var late: EngineEnded? = null
            engines[1].onEnded { late = it }
            assertTrue(late?.reason?.startsWith("the call ran past its limit of 200ms") == true, "$late")

            // the host has closed itself: its Engines' closes complete, and a call fails with why
            for (e in engines) e.closeAndJoin()
            host.closeAndJoin()
            val err = assertFailsWith<HostError> { host.createEngine("Spinner", null) }
            assertTrue(err.message!!.startsWith("the engine host has ended: the call ran past its limit"), err.message)
        }
    }

    // an Engine that ends before anyone listens is heard by the first listener
    @Test
    fun anEndBeforeOnEndedIsHeard() = runBlocking<Unit> {
        val host = EngineHost.open(FAULTS, "faults.js", Nowhere)
        val e = host.createEngine("Ender", null)
        val ends = CopyOnWriteArrayList<EngineEnded>()
        e.onEnded { ends.add(it) }

        // a round trip through the engine thread, after which the listener has been called
        host.createEngine("Ender", null)
        assertEquals(1, ends.size)
        assertTrue(ends[0].reason.startsWith("Error: gone"), ends[0].reason)
        host.closeAndJoin()
    }

    // a call's events are each acted on, past one too short to read and one that fails
    @Test
    fun everyEventOfACallIsActedOn() = runBlocking<Unit> {
        val logs = CopyOnWriteArrayList<String>()
        val host = EngineHost.open(FAULTS, "faults.js", Nowhere, log = { logs.add(it) })
        val e = host.createEngine("Faulty", null)
        val ends = CopyOnWriteArrayList<EngineEnded>()
        e.onEnded { ends.add(it) }
        e.reconnectNow()

        // a round trip through the engine thread, after which the reconnect's events have been
        // acted on
        host.createEngine("Faulty", null)
        assertTrue(ends.firstOrNull()?.reason?.startsWith("Error: gone") == true, "$ends")
        assertTrue(logs.any { "IndexOutOfBounds" in it }, "$logs")
        host.closeAndJoin()
    }
}
