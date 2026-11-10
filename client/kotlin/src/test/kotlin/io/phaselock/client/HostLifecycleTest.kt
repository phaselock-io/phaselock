package io.phaselock.client

import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

/* A native bundle of three Engines.  A Batcher's queries run as the skeleton's do: a new query
   waits for the Engine's next run, which a timer schedules, and each run answers every query that
   waited for it with the run's number and how many queries are open.  A Busy keeps the engine
   thread for 300 ms when asked to reconnect.  A Linked connects as it is created, and logs each
   reconnect and the end of its connection. */
private val ENGINES = """
    globalThis.__engines = {
      Batcher: {
        create: () => {
          const waiting = [];
          const open = new Set();
          let runs = 0;
          let scheduled = false;
          const run = () => {
            scheduled = false;
            runs += 1;
            for (const q of waiting.splice(0)) q.cb({ run: runs, open: open.size });
          };
          return {
            newQuery: () => ({
              subscribe(cb) {
                this.cb = cb;
                open.add(this);
                waiting.push(this);
                if (!scheduled) {
                  scheduled = true;
                  setTimeout(run, 0);
                }
              },
              close() {
                open.delete(this);
              },
            }),
          };
        },
      },
      Busy: {
        create: () => ({
          reconnectNow() {
            const start = Date.now();
            while (Date.now() - start < 300) {}
          },
        }),
      },
      Linked: {
        create: (transport) => {
          const hooks = {
            onOpen() {},
            onView() {},
            onEdits() {},
            onLive() {},
            onVouch() {},
            onEnd(_code, reason) {
              console.log(`ended ${'$'}{reason}`);
            },
          };
          transport.connect(0, null, [], new AbortController().signal, hooks, null);
          return { reconnectNow: () => console.log('reconnect') };
        },
      },
    };
""".trimIndent().encodeToByteArray()

// a transport whose connections count their aborts, each ending as an aborted connection does
private class Lines : Transport {
    val aborts = AtomicInteger()

    override fun connect(
        since: Long,
        view: String?,
        wants: List<String>,
        session: Session?,
        hooks: ConnectionHooks,
    ): Connection = object : Connection {
        override suspend fun backfill(b: Backfill): BackfillOutcome = throw IOException("no backfills")
        override suspend fun sendMutations(mutations: List<Mutation>): List<MutationResult> =
            throw IOException("no sends")
        override fun abort() {
            aborts.incrementAndGet()
            hooks.onEnd(0, "aborted", null)
        }
    }

    override suspend fun post(mutations: List<Mutation>, session: Session?): List<MutationResult> =
        throw IOException("no posts")
}

// waits until ok holds
private suspend fun until(what: String, ok: () -> Boolean) {
    repeat(500) {
        if (ok()) return
        delay(10)
    }
    throw AssertionError("never: $what")
}

class HostLifecycleTest {
    // queries that start while the engine thread is busy start in one request, which the Engine
    // answers in one run
    @Test
    fun queriesStartedTogetherShareOneRun() = runBlocking<Unit> {
        withTimeout(10_000) {
            val host = EngineHost.open(ENGINES, "engines.js", Lines())
            val batcher = host.createEngine("Batcher", null)
            val busy = host.createEngine("Busy", null)
            busy.reconnectNow()
            val firsts = List(3) { async(Dispatchers.Default) { batcher.runs(host).first() } }.awaitAll()
            assertEquals(List(3) { mapOf("run" to 1L, "open" to 3L) }, firsts)
            host.closeAndJoin()
        }
    }

    // returning to the foreground reconnects every Engine, and a network change ends each
    // Engine's connection and reconnects it
    @Test
    fun theForegroundAndANetworkChangeReconnect() = runBlocking<Unit> {
        withTimeout(10_000) {
            val logs = CopyOnWriteArrayList<String>()
            val lines = Lines()
            val host = EngineHost.open(ENGINES, "engines.js", lines) { logs.add(it) }
            repeat(2) { host.createEngine("Linked", null) }

            host.enterForeground()
            until("both reconnect") { logs.count { it == "reconnect" } == 2 }

            host.networkChanged()
            until("both reconnect again") { logs.count { it == "reconnect" } == 4 }
            until("both connections end") { logs.count { it == "ended aborted" } == 2 }
            assertEquals(2, lines.aborts.get())
            host.closeAndJoin()
        }
    }
}

// a Batcher's answers, through the status query that host.js serves from the Engine's newQuery
private fun HostedEngine.runs(host: EngineHost) =
    host.results(id) { q -> listOf("statusQuery", q, id) }.map { decodeAny(it) }
