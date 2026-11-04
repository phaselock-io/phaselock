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

            // the host has closed itself: its Engines' closes complete, and a call fails with why
            for (e in engines) e.closeAndJoin()
            host.closeAndJoin()
            val err = assertFailsWith<HostError> { host.createEngine("Spinner", null) }
            assertTrue(err.message!!.startsWith("the engine host has ended: the call ran past its limit"), err.message)
        }
    }
}
