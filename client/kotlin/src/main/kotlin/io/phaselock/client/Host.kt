// The native host: QuickJS running a model's native bundle, on a thread of its own, and the
// Engines the bundle builds.  Every call into the native library happens on that thread, and
// every call answers with the events the JS side raised (see native/src/jni.rs); the host acts
// on them here, starting the transport's work on the IO dispatcher and handing its results back
// to the engine thread.

package io.phaselock.client

import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** The native library: three functions, every argument and answer msgpack. */
internal object Native {
    init {
        System.loadLibrary("phaselock_jni")
    }

    @JvmStatic external fun open(bundle: ByteArray, name: ByteArray): ByteArray
    @JvmStatic external fun call(host: Long, request: ByteArray): ByteArray
    @JvmStatic external fun close(host: Long)
}

/** The native host failed a call: the bundle would not load, or JS threw where nothing could
    catch it. */
class HostError(message: String) : Exception(message)

/** How an Engine ended: why, and whether the database refused its session, which only signing in
    again mends. */
data class EngineEnded(val reason: String, val auth: Boolean)

/** A declared query failed to run or to convert its result. */
class QueryError(message: String) : Exception(message)

/** The native host of a model's Engines: the bundle, loaded once into one QuickJS runtime on one
    thread, and the transport every Engine it builds syncs through.  Close it to end every
    Engine. */
class EngineHost(
    bundle: ByteArray,
    bundleName: String,
    private val transport: Transport,
    private val log: (String) -> Unit = { System.err.println("phaselock: $it") },
) : AutoCloseable {
    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "phaselock-engine").apply { isDaemon = true }
    }
    // the transport's work for the Engines, which runs off the engine thread
    private val work = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // everything below is the engine thread's alone
    private var handle = 0L
    private var nextId = 1L
    private var timer: ScheduledFuture<*>? = null
    private val sessions = HashMap<Long, Session>()
    // each Engine's own transport, for an Engine built with one
    private val transports = HashMap<Long, Transport>()
    private val connections = HashMap<Long, Connection>()
    private val backfills = HashMap<Long, Job>()
    private val pushes = HashMap<Long, CompletableDeferred<Unit>>()
    private val queries = HashMap<Long, (Result<ByteArray>) -> Unit>()
    private val onlines = HashMap<Long, CompletableDeferred<MutationResult>>()
    private val ended = HashMap<Long, (EngineEnded) -> Unit>()

    init {
        val opened = onThread {
            val r = MsgReader(Native.open(bundle, bundleName.encodeToByteArray()))
            r.arrayHeader()
            if (r.str() == "error") throw HostError(r.str())
            handle = r.long()
        }
        opened.get()
    }

    // runs fn on the engine thread, answering its future
    private fun <T> onThread(fn: () -> T) = executor.submit<T>(fn)

    // runs fn on the engine thread, reporting what it throws
    private fun post(fn: () -> Unit) {
        if (executor.isShutdown) return
        executor.execute {
            try {
                fn()
            } catch (e: Exception) {
                log("${e::class.simpleName}: ${e.message}")
            }
        }
    }

    private fun id(): Long = nextId++

    /* One request to the native host, [op, ...args]: the next timer is scheduled, and then the
       events it answers with are acted on.  Acting on one may make a call of its own, whose timer
       is newer and takes the place of this one's. */
    private fun call(op: String, vararg args: Any?) {
        if (handle == 0L) return
        val w = MsgWriter()
        w.array(args.size + 1)
        w.str(op)
        for (a in args) w.any(a)
        val r = MsgReader(Native.call(handle, w.bytes()))
        r.arrayHeader()
        if (r.str() == "error") throw HostError(r.str())
        val delay = if (r.isNil()) { r.nil(); null } else r.long()
        timer?.cancel(false)
        timer = delay?.let { executor.schedule({ post { call("pump") } }, it, TimeUnit.MILLISECONDS) }
        val events = List(r.arrayHeader()) { r.any() as List<*> }
        events.forEach(::event)
    }

    private fun Any?.long(): Long = (this as Number).toLong()

    // one event from the JS side
    private fun event(e: List<*>) {
        when (e[0] as String) {
            "log" -> log(e[1] as String)
            "connect" -> connect(e[1].long(), e[2].long(), e[3].long(), e[4] as String?, e[5] as List<*>, e[6] as Number?)
            "abortConnection" -> connections[e[1].long()]?.abort()
            "backfill" -> backfill(e[1].long(), e[2].long(), e[3] as String, e[4].long(), e[5] as Map<*, *>?)
            "abortBackfill" -> backfills[e[1].long()]?.cancel()
            "pushSettled" -> {
                val d = pushes.remove(e[1].long())
                val error = e[2] as String?
                if (error == null) d?.complete(Unit) else d?.completeExceptionally(java.io.IOException(error))
            }
            "send" -> send(e[1].long(), e[2].long(), e[3] as List<*>)
            "queryResult" -> queries[e[1].long()]?.invoke(Result.success(e[2] as ByteArray))
            "queryFailed" -> queries[e[1].long()]?.invoke(Result.failure(QueryError(e[2] as String)))
            "onlineSettled" -> {
                val d = onlines.remove(e[1].long())
                val error = e[3] as String?
                if (error != null) d?.completeExceptionally(java.io.IOException(error))
                else d?.complete(mutationResult(e[2] as Map<*, *>))
            }
            "ended" -> ended[e[1].long()]?.invoke(EngineEnded(e[2] as String, e[3] as Boolean))
            else -> log("unknown event ${e[0]}")
        }
    }

    private fun mutationResult(m: Map<*, *>): MutationResult = when (m["kind"]) {
        "ok" -> MutationResult.Ok(m["position"].long())
        "reject" -> MutationResult.Reject(m["reason"] as String)
        else -> MutationResult.Conflict((m["current"] as Map<*, *>).entries.associate { (k, v) -> k as String to v.long() })
    }

    // a connection the Engine asked for, whose hooks hand everything back to the engine thread
    private fun connect(engine: Long, id: Long, since: Long, view: String?, wants: List<*>, session: Number?) {
        val hooks = object : ConnectionHooks {
            override fun onOpen(epoch: String, head: Long) = post { call("connOpen", id, epoch, head) }
            override fun onView(token: String, position: Long, selectors: List<String>) =
                post { call("connView", id, token, position, selectors) }
            override fun onEdits(edits: ByteArray) = post { call("connEdits", id, edits) }
            override fun onLive(position: Long) = post { call("connLive", id, position) }
            override fun onVouch(position: Long) = post { call("connVouch", id, position) }
            override fun onEnd(code: Int, reason: String, fatal: AuthError?) = post {
                connections.remove(id)
                call("connEnd", id, code, reason, fatal?.message)
            }
        }
        val s = session?.let { sessions[it.toLong()] }
        val t = transports[engine] ?: transport
        connections[id] = t.connect(since, view, wants.map { it as String }, s, hooks)
    }

    // a backfill call on a connection, settled however it ends; a push waits for the Engine's
    // commit
    private fun backfill(conn: Long, id: Long, selector: String, until: Long, resume: Map<*, *>?) {
        val c = connections[conn]
        if (c == null) {
            call("backfillSettled", id, null, "the connection has ended")
            return
        }
        val r = resume?.let {
            Resume(
                it["position"].long(),
                it["visible"].long(),
                it["skipBytes"].long(),
                it["checksum"] as String,
                it["fromPosition"].long(),
                it["snapshotDone"] as Boolean,
                it["tailDone"] as Boolean,
            )
        }
        backfills[id] = work.launch {
            val outcome = try {
                Result.success(c.backfill(Backfill(selector, until, r) { item -> push(id, item) }))
            } catch (e: CancellationException) {
                Result.failure(java.io.IOException("backfill $selector: aborted"))
            } catch (e: Exception) {
                Result.failure(e)
            }
            post {
                backfills.remove(id)
                outcome.fold(
                    { call("backfillSettled", id, it.name.lowercase(), null) },
                    { call("backfillSettled", id, null, it.message ?: it.toString()) },
                )
            }
        }
    }

    // one delivery, returning once the Engine has committed it
    private suspend fun push(backfill: Long, item: BackfillItem) {
        val done = CompletableDeferred<Unit>()
        post {
            val p = id()
            pushes[p] = done
            when (item) {
                is BackfillItem.Length -> call("push", backfill, p, "length", item.length)
                is BackfillItem.Header -> call("push", backfill, p, "header", item.position, encodeAny(item.seqs), item.visible)
                is BackfillItem.Page -> call("push", backfill, p, "page", item.page, item.skip, item.checksum)
                BackfillItem.PagesDone -> call("push", backfill, p, "pagesDone")
                is BackfillItem.Edits -> call("push", backfill, p, "edits", item.edits, item.scanned)
                BackfillItem.EditsDone -> call("push", backfill, p, "editsDone")
            }
        }
        done.await()
    }

    // a send on a connection, settled however it ends
    private fun send(conn: Long, id: Long, wire: List<*>) {
        val c = connections[conn]
        if (c == null) {
            call("sendSettled", id, null, "the connection has ended")
            return
        }
        val mutations = wire.map {
            val m = it as List<*>
            Mutation(m[2] as String, m[0] as String?, (m[1] as Number?)?.toLong(), m[3] as ByteArray)
        }
        work.launch {
            val outcome = try {
                Result.success(c.sendMutations(mutations))
            } catch (e: Exception) {
                Result.failure(e)
            }
            post {
                outcome.fold(
                    { results ->
                        val w = MsgWriter()
                        w.array(results.size)
                        for (res in results) {
                            w.array(2)
                            when (res) {
                                is MutationResult.Ok -> { w.str("ok"); w.int(res.position) }
                                is MutationResult.Reject -> { w.str("reject"); w.str(res.reason) }
                                is MutationResult.Conflict -> { w.str("conflict"); w.any(res.current) }
                            }
                        }
                        call("sendSettled", id, w.bytes(), null)
                    },
                    { call("sendSettled", id, null, it.message ?: it.toString()) },
                )
            }
        }
    }

    /** Builds the bundle's Engine called name, syncing as the session or as anonymous, over an
        LMDB store in the directory store, or in memory without one, and through a transport of
        its own when given one.  A directory holds one Engine's store, and only while that Engine
        runs. */
    fun createEngine(
        name: String,
        session: Session?,
        store: File? = null,
        transport: Transport? = null,
    ): HostedEngine {
        store?.mkdirs()
        val id = onThread {
            val id = id()
            if (transport != null) transports[id] = transport
            val s = session?.let { val sid = id(); sessions[sid] = it; sid }
            call("createEngine", id, name, s, store?.path)
            id
        }.get()
        return HostedEngine(this, id)
    }

    internal fun sendMutation(engine: Long, mutation: ByteArray) = post { call("sendMutation", engine, mutation) }

    internal suspend fun sendOnlineMutation(engine: Long, mutation: ByteArray): MutationResult {
        val done = CompletableDeferred<MutationResult>()
        post {
            val c = id()
            onlines[c] = done
            call("sendOnlineMutation", engine, c, mutation)
        }
        return done.await()
    }

    internal fun reconnectNow(engine: Long) = post { call("reconnectNow", engine) }

    internal fun onEnded(engine: Long, fn: (EngineEnded) -> Unit) = post { ended[engine] = fn }

    internal fun closeEngine(engine: Long) = post {
        ended.remove(engine)
        call("closeEngine", engine)
        transports.remove(engine)
    }

    // a query's results as they come, each its msgpack; the query runs while the flow is collected
    internal fun results(engine: Long, start: (Long) -> Array<Any?>): Flow<ByteArray> = callbackFlow {
        var qid = 0L
        post {
            qid = id()
            queries[qid] = { r -> r.fold({ trySend(it) }, { close(it) }) }
            val args = start(qid)
            call(args[0] as String, *args.copyOfRange(1, args.size))
        }
        awaitClose {
            post {
                queries.remove(qid)
                call("closeQuery", qid)
            }
        }
    }

    override fun close() {
        work.cancel()
        onThread {
            timer?.cancel(false)
            if (handle != 0L) Native.close(handle)
            handle = 0L
        }.get()
        executor.shutdown()
    }
}

/** What runs a model's declared queries: a call as msgpack under its queries' wire type, and
    each result as msgpack under the query's result type.  Generated query classes take one. */
interface QuerySource {
    fun query(call: ByteArray): Flow<ByteArray>
}

/** One Engine the host runs: its mutations and declared queries as msgpack under the model's
    types, which generated code converts.  Closing it ends it and closes its store. */
class HostedEngine internal constructor(private val host: EngineHost, private val id: Long) :
    QuerySource, AutoCloseable {
    /** a mutation for the outbox, as msgpack under the Engine's mutations union */
    fun sendMutation(mutation: ByteArray) = host.sendMutation(id, mutation)

    /** an @online mutation, as msgpack under the mutations union, answered with its outcome */
    suspend fun sendOnlineMutation(mutation: ByteArray): MutationResult = host.sendOnlineMutation(id, mutation)

    /** each result of a declared query, its call as msgpack under the queries' wire type */
    override fun query(call: ByteArray): Flow<ByteArray> = host.results(id) { q -> arrayOf("query", q, id, call) }

    /** the Engine's status, each time it changes */
    val status: Flow<EngineStatus> =
        host.results(id) { q -> arrayOf("statusQuery", q, id) }.map { engineStatus(decodeAny(it)) }

    /** connect now rather than when the backoff timer fires */
    fun reconnectNow() = host.reconnectNow(id)

    /** calls fn, on the engine thread, if the Engine ends with an error */
    fun onEnded(fn: (EngineEnded) -> Unit) = host.onEnded(id, fn)

    override fun close() = host.closeEngine(id)
}
