// The native host: QuickJS running a model's native bundle, on a thread of its own, and the
// Engines the bundle builds.  Every call into the native library happens on that thread, and
// every call answers with the events the JS side raised (see native/src/jni.rs); the host acts
// on them here, starting the transport's work on the IO dispatcher and handing its results back
// to the engine thread.  The connections' hooks queue, and each drain of the queue is one call,
// so the frames that arrive together commit together.

package io.phaselock.client

import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The native library: three functions, every argument and answer msgpack. */
internal object Native {
    init {
        System.loadLibrary("phaselock_jni")
    }

    @JvmStatic external fun open(bundle: ByteArray, name: ByteArray, limits: ByteArray): ByteArray
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

/** How far the model's JS may run, which is the app's own code over its own data, so the limits
    are generous.  Each call into the runtime runs for at most callTimeout: JS still running then
    is interrupted where no JS can catch it, which ends the host and every Engine it runs, each
    with a reason naming the limit and the backtrace of the JS that ran away.  The runtime's heap
    holds at most memory bytes, past which an allocation throws in JS, which ends the Engine that
    does not catch it. */
data class EngineLimits(
    val callTimeout: Duration = 60.seconds,
    val memory: Long = 1L shl 30,
)

/* The engine thread's stack, and the part of it JS may take, counted down from each call into
   the runtime.  The 2 MiB between them hold the frames beneath the JS (the executor's, JNI's,
   and the native host's own, well under 256 KiB) and the natives JS calls, so a recursion that
   runs deep throws a stack overflow in JS before it reaches the end of the thread's stack. */
private const val ENGINE_STACK = 8L shl 20
private const val JS_STACK = 6L shl 20

/** The native host of a model's Engines: the bundle, loaded once into one QuickJS runtime on one
    thread, and the transport every Engine it builds syncs through.  Open one with open, and close
    it to end every Engine; a call on a host that is closed or closing fails with a HostError.
    The host also ends on its own when a call into its runtime runs past the call limit
    (EngineLimits): every Engine's onEnded hears why, and the host closes as close closes it. */
class EngineHost private constructor(
    private val transport: Transport,
    private val log: (String) -> Unit,
) : AutoCloseable {
    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(null, r, "phaselock-engine", ENGINE_STACK).apply { isDaemon = true }
    }
    // the engine thread, for suspending on
    private val engineThread = executor.asCoroutineDispatcher()
    // whether close has begun, and its completion once the native host is freed
    private val closing = AtomicBoolean()
    private val freed = CompletableDeferred<Unit>()
    // why the host ended on its own, once a call into it ran past its limit
    @Volatile private var endedWhy: String? = null
    // the transport's work for the Engines, which runs off the engine thread
    private val work = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    // every connection's hooks in arrival order, each a hook of a connHooks request, queued from
    // the transport's threads for the next drain; guarded by itself
    private val queued = ArrayList<List<Any?>>()

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

    companion object {
        /** Loads the model's native bundle, named bundleName in its errors, into a host of its own,
            whose Engines sync through transport unless given one of their own.  The bundle loads
            on the engine thread; a bundle that will not load fails with a HostError.  JS that
            passes a limit throws: past the call timeout, the host ends, and with it every
            Engine; past the memory limit, the allocation throws in JS, and an Engine that does
            not catch it ends with the error as its reason. */
        suspend fun open(
            bundle: ByteArray,
            bundleName: String,
            transport: Transport,
            limits: EngineLimits = EngineLimits(),
            log: (String) -> Unit = { System.err.println("phaselock: $it") },
        ): EngineHost {
            val host = EngineHost(transport, log)
            val w = MsgWriter()
            w.array(3)
            w.int(JS_STACK)
            w.int(limits.memory)
            w.int(limits.callTimeout.inWholeMilliseconds)
            try {
                withContext(host.engineThread) {
                    val r = MsgReader(Native.open(bundle, bundleName.encodeToByteArray(), w.bytes()))
                    r.arrayHeader()
                    if (r.str() == "error") throw HostError(r.str())
                    host.handle = r.long()
                }
            } catch (e: Throwable) {
                // a host that failed to open still holds its thread, and its runtime too when
                // the caller was cancelled after the bundle loaded
                host.close()
                throw e
            }
            return host
        }
    }

    private fun closedError() =
        HostError(endedWhy?.let { "the engine host has ended: $it" } ?: "the engine host is closed")

    // runs fn on the engine thread and answers what it returns, failing on a host that is closed
    // or closing
    private suspend fun <T> onThread(fn: () -> T): T {
        if (closing.get()) throw closedError()
        try {
            return withContext(engineThread) {
                if (handle == 0L) throw closedError()
                fn()
            }
        } catch (e: CancellationException) {
            // either the caller was cancelled, or the host shut its thread down as the call
            // began, which rejects the call and cancels it alone
            currentCoroutineContext().ensureActive()
            throw closedError()
        }
    }

    // runs fn on the engine thread, reporting what it throws; a host that has shut its thread
    // down has nothing left for fn to act on, so fn is dropped
    private fun post(fn: () -> Unit) {
        try {
            executor.execute {
                try {
                    fn()
                } catch (e: Exception) {
                    log("${e::class.simpleName}: ${e.message}")
                }
            }
        } catch (e: RejectedExecutionException) {}
    }

    // posts a caller's request, failing on a host that is closed or closing
    private fun request(fn: () -> Unit) {
        if (closing.get()) throw closedError()
        post(fn)
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
        when (r.str()) {
            "error" -> throw HostError(r.str())
            "ended" -> end(r.str())
        }
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
            override fun onOpen(epoch: String, head: Long) = hook("connOpen", id, epoch, head)
            override fun onView(token: String, position: Long, selectors: List<String>) =
                hook("connView", id, token, position, selectors)
            override fun onEdits(edits: ByteArray) = hook("connEdits", id, edits)
            override fun onLive(position: Long) = hook("connLive", id, position)
            override fun onVouch(position: Long) = hook("connVouch", id, position)
            override fun onEnd(code: Int, reason: String, fatal: AuthError?) =
                hook("connEnd", id, code, reason, fatal?.message)
        }
        val s = session?.let { sessions[it.toLong()] }
        val t = transports[engine] ?: transport
        connections[id] = t.connect(since, view, wants.map { it as String }, s, hooks)
    }

    // a hook for the next drain, which the first hook into an empty queue posts
    private fun hook(vararg request: Any?) {
        val first = synchronized(queued) {
            queued.add(request.asList())
            queued.size == 1
        }
        if (first) post(::drainHooks)
    }

    /* Every hook queued so far, in one call, so the Engine commits the frames among them in one
       transaction; hooks that arrive during the call queue for the next drain. */
    private fun drainHooks() {
        val hooks = synchronized(queued) { ArrayList(queued).also { queued.clear() } }

        // a connection whose end is among them leaves the table before the Engine hears of it
        for (h in hooks) if (h[0] == "connEnd") connections.remove(h[1] as Long)
        call("connHooks", hooks)
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
        its own when given one.  The Engine boots on the engine thread, loading its store, before
        this returns.  A directory holds one Engine's store, and only while that Engine runs: a
        new Engine may open it only once the last one's close has completed, which closeAndJoin
        awaits. */
    suspend fun createEngine(
        name: String,
        session: Session?,
        store: File? = null,
        transport: Transport? = null,
    ): HostedEngine {
        val id = onThread {
            store?.mkdirs()
            val id = id()
            if (transport != null) transports[id] = transport
            val s = session?.let { val sid = id(); sessions[sid] = it; sid }
            call("createEngine", id, name, s, store?.path)
            id
        }
        return HostedEngine(this, id)
    }

    internal fun sendMutation(engine: Long, mutation: ByteArray) = request { call("sendMutation", engine, mutation) }

    internal suspend fun sendOnlineMutation(engine: Long, mutation: ByteArray): MutationResult {
        val done = CompletableDeferred<MutationResult>()
        onThread {
            val c = id()
            onlines[c] = done
            try {
                call("sendOnlineMutation", engine, c, mutation)
            } catch (e: Exception) {
                onlines.remove(c)
                throw e
            }
        }
        return done.await()
    }

    internal fun reconnectNow(engine: Long) = request { call("reconnectNow", engine) }

    internal fun onEnded(engine: Long, fn: (EngineEnded) -> Unit) = request { ended[engine] = fn }

    // ends an Engine, completing done once its store is closed, by this or by the host's close
    internal fun closeEngine(engine: Long, done: CompletableDeferred<Unit>) {
        val byHost = freed.invokeOnCompletion { done.complete(Unit) }
        post {
            try {
                ended.remove(engine)
                call("closeEngine", engine)
                transports.remove(engine)
            } finally {
                done.complete(Unit)
                byHost.dispose()
            }
        }
    }

    /* A query's results as they come, each its msgpack; the query runs while the flow is
       collected.  The flow is conflated: a result that arrives while the collector is busy
       replaces the one still waiting, so a collector that falls behind skips to the newest. */
    internal fun results(engine: Long, start: (Long) -> Array<Any?>): Flow<ByteArray> = callbackFlow {
        var qid = 0L
        onThread {
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
    }.buffer(Channel.CONFLATED)

    /** Ends every Engine and frees the native host, closing every store, once the work already
        queued for the engine thread has run.  It returns at once; closeAndJoin waits. */
    override fun close() {
        if (!closing.compareAndSet(false, true)) return
        work.cancel()
        executor.execute(::shutDown)
    }

    /* The host's end, once a call into it ran past its limit, which the native host answered by
       aborting every store transaction; it runs no JS again.  Every Engine's onEnded hears why,
       the host closes as close closes it, and the call fails with why. */
    private fun end(why: String): Nothing {
        endedWhy = why
        closing.set(true)
        work.cancel()

        // each Engine's end, every callback heard even when one throws
        val ends = ArrayList(ended.values)
        ended.clear()
        for (fn in ends) {
            try {
                fn(EngineEnded(why, auth = false))
            } catch (e: Exception) {
                log("onEnded: ${e::class.simpleName}: ${e.message}")
            }
        }

        // the close, at once
        shutDown()
        throw HostError(why)
    }

    // the host's close on the engine thread, which both close and the host's end run, so a
    // second run is harmless
    private fun shutDown() {
        try {
            // an @online mutation still waiting has no answer coming
            for (d in onlines.values) d.completeExceptionally(closedError())
            onlines.clear()

            // the runtime, and every store with it
            timer?.cancel(false)
            if (handle != 0L) Native.close(handle)
            handle = 0L
        } finally {
            executor.shutdown()
            freed.complete(Unit)
        }
    }

    /** closes the host, suspending until the native host is freed and every store closed */
    suspend fun closeAndJoin() {
        close()
        freed.await()
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
    // whether close has begun, and its completion once the store is closed
    private val closing = AtomicBoolean()
    private val closed = CompletableDeferred<Unit>()

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

    /** Calls fn, on the engine thread, if the Engine ends with an error, or when its host ends
        because a call into the runtime ran past the call limit (EngineLimits), which ends every
        Engine of the host with a reason naming the limit. */
    fun onEnded(fn: (EngineEnded) -> Unit) = host.onEnded(id, fn)

    /** ends the Engine and closes its store after the work already queued for it, returning at
        once */
    override fun close() {
        if (closing.compareAndSet(false, true)) host.closeEngine(id, closed)
    }

    /** closes the Engine, suspending until its store is closed */
    suspend fun closeAndJoin() {
        close()
        closed.await()
    }
}
