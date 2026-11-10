// The HTTP transport: logins and sessions, connections, and mutations posted outside them.  It
// keeps @phaselock/client's HTTPTransport behavior call for call, over OkHttp: blocking reads run
// on the IO dispatcher, and cancelling a call's coroutine cancels its request.

package io.phaselock.client

import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer

// the most edits one tail request asks for
private const val TAIL_MAX = 1000
// a snapshot page closes at this many operations or bytes, whichever comes first
private const val PAGE_OPS = 1000
private const val PAGE_BYTES = 256 * 1024
// a blob operation longer than this is corruption, since a key and a value are each at most 16 MiB
private const val MAX_OPERATION = 32L * 1024 * 1024
// a blob header longer than this is corruption: at this length its slices name half a million
// slices or more, which is more than one client holds
private const val MAX_HEADER = 64L * 1024 * 1024
// a blob's set opcode, and the first byte of its end marker, which sits where an opcode would
private const val SET = 0x00
private const val END = 0xff
// a send that fails for a reason that may not recur is tried again this many times, waiting this
// long before the first retry and twice as long before each one after, unless the database names
// its own wait, which is held to the longest
private const val SEND_RETRIES = 3
private const val SEND_RETRY_DELAY = 100L
private const val MAX_RETRY_DELAY = 30_000L
// a session is refreshed once it has lived this share of its lifetime
private const val REFRESH_AFTER = 0.5
// a read that waits longer than this fails: every read on a client the transport makes itself,
// and the stream's until the database names its heartbeat interval, 15 seconds by default, so a
// stream silent this long is a dead link
private const val READ_TIMEOUT = 20_000L
// a stream silent for this many heartbeat intervals is a dead link: one heartbeat late by up to
// a whole interval, as under a congested or waking mobile radio, still arrives in time
private const val HEARTBEATS_OF_SILENCE = 2

private val MSGPACK = "application/msgpack".toMediaType()

/** What a login presents: a password, or an account's identity alone, which only a database run
    with --dev-auth accepts. */
sealed interface Credentials {
    data class Password(val identity: String, val password: String) : Credentials
    data class Dev(val identity: String) : Credentials
}

/** A response whose status answers no mutation: safe when the database refused the request
    before deciding any of it, and retryAfter the wait it names in milliseconds, or null. */
private open class StatusError(
    val status: Int,
    message: String,
    val safe: Boolean = false,
    val retryAfter: Long? = null,
) : IOException(message)

/** a 413: the request carried more mutations than the database takes in one, max */
private class TooManyMutations(val max: Int, message: String) : StatusError(413, message)

// the most mutations one request carries, with a session and without one: the database's
// defaults, until a 413 names the database's own
private class MutationLimits(@Volatile var session: Int = 128, @Volatile var anonymous: Int = 8)

/** one call, its response once it arrives; cancelling the coroutine cancels the call, and closes
    a response that arrives as it is cancelled */
private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) =
            cont.resume(response) { _, r, _ -> r.close() }
        override fun onFailure(call: Call, e: IOException) = cont.resumeWithException(e)
    })
}

// a response header's integer, or null when the header is absent, empty, or no integer
private fun Response.headerLong(name: String): Long? = header(name)?.takeIf { it.isNotEmpty() }?.toLongOrNull()

/** The Transport to a database over HTTP, at its base URL: its origin and the path its routes are
    under, such as `https://example.com/phaselock`.  It signs in and refreshes sessions, and
    refreshes a session it is handed once the session has lived half its lifetime.

    It runs over an OkHttpClient of its own, or over the app's, which an app that opens several
    transports shares among them.  The stream reads under a timeout of its own, twice the
    heartbeat interval the database last named, which is how the stream finds out its link is
    dead; a stream opened before the database has named one waits 20 seconds.  close shuts down
    a client the transport made itself, and leaves the app's to the app. */
class HttpTransport private constructor(
    url: String,
    private val client: OkHttpClient,
    private val ownsClient: Boolean,
) : Transport {
    /** a transport over a client of its own */
    constructor(url: String) :
        this(url, OkHttpClient.Builder().readTimeout(READ_TIMEOUT, TimeUnit.MILLISECONDS).build(), true)

    /** a transport over the app's client, which close leaves running */
    constructor(url: String, client: OkHttpClient) : this(url, client, false)

    private val base: String = url.trimEnd('/')
    // the client the stream reads through, under the timeout its heartbeat calls for; it shares
    // the client's connections and threads
    @Volatile private var streamClient: OkHttpClient =
        client.newBuilder().readTimeout(READ_TIMEOUT, TimeUnit.MILLISECONDS).build()
    // each session's refresh in flight, which every caller that wants it refreshed meanwhile shares
    private val refreshes = ConcurrentHashMap<Session, Deferred<Unit>>()
    // shared with every connection, so a limit one request learns holds for all of them
    private val limits = MutationLimits()
    // the work of connections and refreshes, which outlives any one caller
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun url(path: String): HttpUrl = "$base$path".toHttpUrl()

    override fun connect(
        since: Long,
        view: String?,
        wants: List<String>,
        session: Session?,
        hooks: ConnectionHooks,
    ): Connection = HttpConnection(this, session, since, view, wants, hooks)

    /** Mutations outside any connection, as the session or as anonymous, answered with their
        outcomes in order, in as many requests as the database's limit calls for, one after
        another.  A request of numbered mutations that fails for a reason that may not recur is
        tried again a few times under the same ids, which the database's dedup makes safe; a
        request with an unnumbered mutation is tried again only when the database refused it
        before deciding any of it.  A refused session ends, and the post throws an AuthError. */
    override suspend fun post(mutations: List<Mutation>, session: Session?): List<MutationResult> {
        if (session != null) fresh(session)
        return inRequests(mutations, session == null) { request ->
            val numbered = request.all { it.series != null && it.n != null }
            var attempt = 0
            while (true) {
                try {
                    return@inRequests postMutations(authorization(session), request)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (attempt == SEND_RETRIES || !retryable(e, numbered)) throw refusal(e, session)
                    delay(retryDelay(e, attempt))
                    attempt++
                }
            }
            @Suppress("UNREACHABLE_CODE")
            throw IllegalStateException()
        }
    }

    /** Signs in, answering a new session.  A login the database refuses, for any reason, throws
        an AuthError naming the response's status. */
    suspend fun login(credentials: Credentials): Session {
        val body = when (credentials) {
            is Credentials.Password -> mapOf(
                "kind" to "password",
                "identity" to credentials.identity,
                "password" to credentials.password,
            )
            is Credentials.Dev -> mapOf("kind" to "dev", "identity" to credentials.identity)
        }
        try {
            return Session(authToken(body, null).first)
        } catch (e: StatusError) {
            throw AuthError(e.status, e.message ?: "auth")
        }
    }

    /** Re-issues the session's token in place, then calls its onRefresh.  Refreshes of one
        session while one is in flight share it.  A session the database refuses is ended, and
        the refresh throws an AuthError. */
    suspend fun refresh(session: Session) {
        val pending = refreshes.computeIfAbsent(session) {
            scope.async {
                try {
                    reissue(session)
                } finally {
                    refreshes.remove(session)
                }
            }
        }
        pending.await()
    }

    private suspend fun reissue(session: Session) {
        if (session.ended) throw AuthError(401, "the session has ended")
        val (token, exp) = try {
            authToken(mapOf("kind" to "refresh"), session.token)
        } catch (e: Exception) {
            throw refusal(e, session)
        }
        session.token = token
        session.exp = exp
        session.onRefresh?.invoke(session)
    }

    /* The session ready to present: refreshed first once it has lived REFRESH_AFTER of its
       lifetime.  A refresh that fails for any reason but a refusal leaves a token that has not
       expired to be presented as it is, since it is still good. */
    internal suspend fun fresh(session: Session) {
        if (session.ended) throw AuthError(401, "the session has ended")
        val c = claims(session.token)
        val now = System.currentTimeMillis() / 1000.0
        if (now < c.iat + (c.exp - c.iat) * REFRESH_AFTER) return
        try {
            refresh(session)
        } catch (e: Exception) {
            if (e is AuthError || now >= c.exp) throw e
        }
    }

    // one POST to /auth/token, answered with the token it signs and its expiry; any status but
    // 200 throws
    private suspend fun authToken(body: Map<String, String>, token: String?): Pair<String, Long> {
        val req = Request.Builder().url(url("/auth/token"))
            .post(encodeAny(body).toRequestBody(MSGPACK))
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .build()
        client.newCall(req).await().use { resp ->
            val bytes = withContext(Dispatchers.IO) { resp.body.bytes() }
            if (resp.code != 200) {
                throw StatusError(resp.code, "auth: ${resp.code} ${String(bytes, Charsets.UTF_8).trim()}")
            }
            val reply = decodeAny(bytes) as? Map<*, *> ?: throw IOException("auth: malformed reply")
            val t = reply["token"] as? String
            val exp = (reply["exp"] as? Number)?.toLong()
            if (t == null || exp == null) throw IOException("auth: malformed reply")
            return t to exp
        }
    }

    internal fun authorization(session: Session?): Map<String, String> =
        if (session == null) emptyMap() else mapOf("Authorization" to "Bearer ${session.token}")

    internal fun request(path: String, headers: Map<String, String>, query: List<Pair<String, String>> = emptyList()): Request {
        val u = url(path).newBuilder().apply { for ((k, v) in query) addQueryParameter(k, v) }.build()
        return Request.Builder().url(u).apply { for ((k, v) in headers) header(k, v) }.build()
    }

    internal fun call(req: Request): Call = client.newCall(req)

    internal fun streamCall(req: Request): Call = streamClient.newCall(req)

    // the heartbeat interval a stream's response named, in milliseconds, which the streams
    // opened after it read under
    internal fun heartbeat(interval: Long) {
        val timeout = interval * HEARTBEATS_OF_SILENCE
        if (interval > 0 && streamClient.readTimeoutMillis.toLong() != timeout) {
            streamClient = client.newBuilder().readTimeout(timeout, TimeUnit.MILLISECONDS).build()
        }
    }

    /* Mutations in requests of at most the sender's limit each, one after another so that a
       series' mutations reach the database in order, answered with their outcomes in order.  A
       413 names the limit the database held the request to, which the mutations not yet answered
       are split again under; the database refuses such a request before checking any of it. */
    internal suspend fun inRequests(
        mutations: List<Mutation>,
        anonymous: Boolean,
        send: suspend (List<Mutation>) -> List<MutationResult>,
    ): List<MutationResult> {
        val results = ArrayList<MutationResult>(mutations.size)
        while (results.size < mutations.size) {
            val limit = if (anonymous) limits.anonymous else limits.session
            val request = mutations.subList(results.size, minOf(mutations.size, results.size + limit))
            try {
                results.addAll(send(request))
            } catch (e: TooManyMutations) {
                // a limit that would not split the request is the database's mistake, and stands
                if (e.max >= request.size) throw e
                if (anonymous) limits.anonymous = e.max else limits.session = e.max
            }
        }
        return results
    }

    /* One POST of mutations, answered with their outcomes in order.  Any status but 200 throws,
       since such a response answers no mutation; a 413 naming the database's limit throws
       TooManyMutations. */
    internal suspend fun postMutations(headers: Map<String, String>, mutations: List<Mutation>): List<MutationResult> {
        val w = MsgWriter()
        for (m in mutations) {
            w.array(4)
            if (m.series == null || m.n == null) {
                w.nil()
                w.nil()
            } else {
                w.str(m.series)
                w.int(m.n)
            }
            w.bin(uuidBytes(m.id))
            w.raw(m.data)
        }
        val req = Request.Builder().url(url("/mutations"))
            .apply { for ((k, v) in headers) header(k, v) }
            .post(w.bytes().toRequestBody(MSGPACK))
            .build()
        call(req).await().use { resp ->
            if (resp.code != 200) {
                val message = "mutations: ${resp.code} ${resp.message}"
                val max = resp.headerLong("PhaseLock-Max-Mutations")
                if (resp.code == 413 && max != null && max > 0) throw TooManyMutations(max.toInt(), message)
                val safe = resp.header("PhaseLock-Safe-To-Retry") == "true"
                throw StatusError(resp.code, message, safe, resp.headerLong("Retry-After")?.times(1000))
            }
            val bytes = withContext(Dispatchers.IO) { resp.body.bytes() }
            val r = MsgReader(bytes)
            return List(r.arrayHeader()) { mutationResult(r) }
        }
    }

    /** ends every connection's work this transport started and the refreshes in flight, and shuts
        down the client when the transport made it */
    fun close() {
        scope.cancel()
        if (ownsClient) {
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }
    }
}

// one outcome of /mutations, `[kind, value]`
private fun mutationResult(r: MsgReader): MutationResult {
    val n = r.arrayHeader()
    val kind = r.str()
    val result = when (kind) {
        "ok" -> MutationResult.Ok(r.long())
        "reject" -> MutationResult.Reject(r.str())
        "conflict" -> {
            val m = r.mapHeader()
            MutationResult.Conflict(LinkedHashMap<String, Long>().apply { repeat(m) { put(r.str(), r.long()) } })
        }
        else -> throw IOException("unknown mutation outcome $kind")
    }
    repeat(n - 2) { r.skip() }
    return result
}

// the error a failed auth or mutation request throws: a 401 is the database refusing the session,
// which ends it; any other failure is itself
private fun refusal(e: Exception, session: Session?): Exception {
    if (e !is StatusError || e.status != 401) return e
    session?.ended = true
    return AuthError(401, e.message ?: "refused")
}

/* Whether a failed send may go again.  A 429, and a 503 the database marks safe to retry, refused
   the request before any of it was decided, so it may go again whatever it holds; any other
   failure but a 4xx may have applied some of it, so it goes again only when every mutation is
   numbered, since the database's dedup answers a resent one it applied. */
private fun retryable(e: Exception, numbered: Boolean): Boolean {
    if (e !is StatusError) return numbered
    if (e.status == 429 || e.safe) return true
    return numbered && (e.status < 400 || e.status >= 500)
}

// how long to wait before a send's next attempt: the wait the database names, or the backoff's
private fun retryDelay(e: Exception, attempt: Int): Long {
    val named = (e as? StatusError)?.retryAfter
    if (named != null && named >= 0) return minOf(named, MAX_RETRY_DELAY)
    return SEND_RETRY_DELAY shl attempt
}

/* One connection over HTTP: the live stream, the backfills and mutation sends that ride on it,
   and the session they all present.  Before it opens the stream and before each send it readies
   the session, which refreshes it when due; a 401 from any of them is the database refusing the
   session, which ends the connection fatally. */
private class HttpConnection(
    private val transport: HttpTransport,
    private val session: Session?,
    since: Long,
    view: String?,
    wants: List<String>,
    private val hooks: ConnectionHooks,
) : Connection {
    // every request of the connection; aborting it cancels them all
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    // the stream's call, whose body reads block past the scope's cancellation, so stopping the
    // connection cancels the call itself
    @Volatile private var stream: Call? = null
    @Volatile private var ended = false
    private val endLock = Any()
    // the log's epoch once the stream opens, or a failure when the connection ends before that
    private val epoch = CompletableDeferred<String>()
    // the send queue: one call in flight, and a failure that stands fails every call queued at
    // that moment without sending it and ends the connection
    private val sends = Channel<Pair<List<Mutation>, CompletableDeferred<List<MutationResult>>>>(Channel.UNLIMITED)

    init {
        scope.launch { run(since, view, wants) }
        scope.launch { pump() }
    }

    private suspend fun ready() {
        if (session != null) transport.fresh(session)
    }

    private fun headers(extra: Map<String, String> = emptyMap()) = extra + transport.authorization(session)

    // the one onEnd: server end frames pass their code through; transport-level ends carry the
    // HTTP status, and local ends (abort, closed body) carry 0
    private fun end(code: Int, reason: String, fatal: AuthError? = null) {
        synchronized(endLock) {
            if (ended) return
            ended = true
        }
        epoch.completeExceptionally(IOException("connection ended before its stream opened: $reason"))
        hooks.onEnd(code, reason, fatal)
    }

    // the database refused the session: it ends for good, and so does this connection, fatally
    private fun refuse(message: String): AuthError {
        session?.ended = true
        val err = AuthError(401, message)
        end(401, message, err)
        stop()
        return err
    }

    override fun abort() {
        end(0, "aborted")
        stop()
    }

    // every request of the connection cancelled, the stream's blocked read included
    private fun stop() {
        stream?.cancel()
        scope.cancel()
    }

    private suspend fun run(since: Long, view: String?, wants: List<String>) {
        try {
            ready()
            val q = ArrayList<Pair<String, String>>()
            q.add("since" to since.toString())
            if (view != null) q.add("view" to view)
            for (w in wants) q.add("want" to w)
            val call = transport.streamCall(transport.request("/stream", headers(), q))
            stream = call
            val resp = call.await()
            resp.use {
                if (resp.code == 401) {
                    refuse(resp.body.string())
                    return
                }
                if (resp.code != 200) {
                    end(resp.code, resp.body.string())
                    return
                }
                val e = resp.header("PhaseLock-Epoch")
                if (e.isNullOrEmpty()) {
                    end(resp.code, "stream: no epoch")
                    return
                }
                val head = resp.headerLong("PhaseLock-Position")
                if (head == null) {
                    end(resp.code, "stream: no position")
                    return
                }
                resp.headerLong("PhaseLock-Heartbeat")?.let(transport::heartbeat)
                hooks.onOpen(e, head)
                epoch.complete(e)
                val src = resp.body.source()
                val buf = Buffer()
                while (true) {
                    // a frame read as the connection ended is never delivered
                    buf.clear()
                    if (!readValue(src, buf) || ended) break
                    val f = parseFrame(buf.readByteArray())
                    when (f) {
                        is Frame.Edits -> hooks.onEdits(f.edits)
                        is Frame.Live -> hooks.onLive(f.position)
                        is Frame.Vouch -> hooks.onVouch(f.position)
                        is Frame.View -> hooks.onView(f.token, f.position, f.selectors)
                        is Frame.End -> {
                            end(f.code, f.reason)
                            return
                        }
                    }
                }
                end(0, "stream closed")
            }
        } catch (e: CancellationException) {
            end(0, "aborted")
        } catch (e: Exception) {
            end(if (e is AuthError) e.status else 0, e.message ?: e.toString(), e as? AuthError)
        }
    }

    override suspend fun backfill(b: Backfill): BackfillOutcome {
        if (ended) throw IOException("snapshot ${b.selector}: the connection has ended")
        return withContext(scope.coroutineContext + Job(scope.coroutineContext[Job])) {
            val r = b.resume
            coroutineScope {
                // the snapshot half, unless a previous attempt finished it; when one half fails
                // the other is pointless, which the scope sees to
                var position: Long
                var snapshot: Deferred<Unit>? = null
                if (r != null && r.snapshotDone) {
                    position = r.position
                } else {
                    val (cut, blob) = openSnapshot(b)
                    when (blob) {
                        Blob.Stale -> return@coroutineScope BackfillOutcome.STALE
                        Blob.Complete -> {}
                        is Blob.Reading -> snapshot = async { blobPages(b, blob) }
                    }
                    position = cut
                }

                // the tail half, unless a previous attempt finished it
                val from = maxOf(r?.fromPosition ?: position, position)
                val tail = if (r != null && r.tailDone) null else async { tail(b, from) }
                snapshot?.await()
                tail?.await()
                BackfillOutcome.DONE
            }
        }
    }

    /** What opening a snapshot's blob found. */
    private sealed interface Blob {
        // cut from another log, or a resumed download whose cut moved
        data object Stale : Blob

        // a resumed blob that was already complete
        data object Complete : Blob

        // a body opened past its header: its response and reader at its first operation, the
        // offset there, and the operation count and content hash of every operation before it
        class Reading(
            val resp: Response,
            val src: okio.BufferedSource,
            var offset: Long,
            var count: Long,
            val fnv: Fnv64,
        ) : Blob
    }

    /* The snapshot's first response, and the blob a pointer leads to, opened: its length pushed,
       and for a fresh download its header checked and pushed.  Answers the snapshot's cut
       position and what the blob holds. */
    private suspend fun openSnapshot(b: Backfill): Pair<Long, Blob> {
        val r = b.resume
        val skip = r?.skipBytes ?: 0L
        val range = if (skip > 0) mapOf("Range" to "bytes=$skip-") else emptyMap()
        val first = transport.call(transport.request("/snapshot/${b.selector}", headers(range))).await()
        fun okStatus(resp: Response) = resp.code == 200 || resp.code == 206 || resp.code == 416
        var keep = false
        try {
            if (first.code == 401) throw refuse(first.body.string())
            if (!okStatus(first)) throw IOException("snapshot ${b.selector}: ${first.code} ${first.message}")

            // the origin's response carries the position and the epoch; a blob store owes only the bytes
            val position = first.headerLong("PhaseLock-Position") ?: throw IOException("snapshot ${b.selector}: no position")
            val e = first.header("PhaseLock-Epoch")
            if (e.isNullOrEmpty()) throw IOException("snapshot ${b.selector}: no epoch")

            // a cut from another log is stale, and so is a resumed download whose cut moved; the
            // connection learns its log's epoch when the stream opens, so this waits for that
            if (e != epoch.await()) return position to Blob.Stale
            if (skip > 0 && position != r!!.position) return position to Blob.Stale

            // the blob, inline or where a pointer leads
            var blob = first
            if (first.header("Content-Type")?.startsWith("text/plain") == true) {
                val target = first.body.string()
                val req = Request.Builder().url(target).apply { for ((k, v) in range) header(k, v) }.build()
                blob = transport.call(req).await()
                if (blob.code == 404 || blob.code == 410) {
                    blob.close()
                    return position to Blob.Stale
                }
                if (!okStatus(blob)) {
                    blob.close()
                    throw IOException("snapshot ${b.selector}: ${blob.code} ${blob.message}")
                }
            }
            val opened = blobOpen(b, blob, position, e, skip)
            keep = opened is Blob.Reading
            return position to opened
        } finally {
            if (!keep) first.close()
        }
    }

    /* Open a blob's body: push its length, and for a fresh download check and push its header.
       Answers where its operations start, Complete for a resumed blob that was already complete,
       or Stale for a fresh blob cut from a log other than the one the origin named. */
    private suspend fun blobOpen(b: Backfill, resp: Response, position: Long, epoch: String, skip: Long): Blob {
        if (resp.code == 416) {
            // skip is the end: every page was delivered already
            resp.close()
            b.push(BackfillItem.PagesDone)
            return Blob.Complete
        }

        // the blob's whole length, for the Engine's progress, when the response states one
        val length = blobLength(resp)
        if (length != null) b.push(BackfillItem.Length(length))

        val src = resp.body.source()
        var offset = if (resp.code == 206) skip else 0L
        // a server that ignored the Range sent the whole blob; skip what we already have
        if (resp.code == 200 && skip > 0) {
            withContext(Dispatchers.IO) { src.skip(skip) }
            offset = skip
        }

        // if the download is fresh, check and push its header
        if (skip == 0L) {
            val header = withContext(Dispatchers.IO) {
                val magic = src.readByteArray(4)
                if (String(magic, Charsets.US_ASCII) != "PLSN") throw IOException("snapshot ${b.selector}: bad magic")
                val version = src.readByte().toInt()
                if (version != 1) throw IOException("snapshot ${b.selector}: version $version")
                val hlen = src.readInt().toLong() and 0xffffffffL
                if (hlen > MAX_HEADER) throw IOException("snapshot ${b.selector}: header too long")
                val hdr = src.readByteArray(hlen)
                val crc = src.readInt().toLong() and 0xffffffffL
                if (crc != crc32c(hdr)) throw IOException("snapshot ${b.selector}: header crc")
                offset += 9 + hlen + 4
                decodeAny(hdr) as? Map<*, *> ?: throw IOException("snapshot ${b.selector}: bad header")
            }
            if (header["epoch"] != epoch) return Blob.Stale // a pointer that led to another log's blob
            if ((header["position"] as? Number)?.toLong() != position) {
                throw IOException("snapshot ${b.selector}: position mismatch")
            }
            val visible = (header["visible"] as? Number)?.toLong() ?: throw IOException("snapshot ${b.selector}: header without visible")
            @Suppress("UNCHECKED_CAST")
            val slices = (header["slices"] as? Map<String, Any?>).orEmpty().mapValues { (it.value as Number).toLong() }
            b.push(BackfillItem.Header(position, slices, visible))
            return Blob.Reading(resp, src, offset, 0, Fnv64())
        }

        // otherwise it resumes, so the count and the hash continue from its last parked page
        val m = Regex("^(0|[1-9]\\d*):([0-9a-f]{16})$").find(b.resume!!.checksum)
            ?: throw IOException("snapshot ${b.selector}: bad resume checksum")
        return Blob.Reading(resp, src, offset, m.groupValues[1].toLong(), Fnv64.resume(m.groupValues[2]))
    }

    // a blob response's whole length: a full response's Content-Length, or a range response's
    // Content-Range total; null when it states neither, or is encoded
    private fun blobLength(resp: Response): Long? {
        val encoding = resp.header("Content-Encoding")
        if (encoding != null && encoding != "identity") return null
        return if (resp.code == 206) {
            Regex("/(\\d+)$").find(resp.header("Content-Range") ?: "")?.groupValues?.get(1)?.toLongOrNull()
        } else {
            resp.headerLong("Content-Length")
        }
    }

    /* A blob's set operations, as pages of whole ones, and its footer.  A page is the
       operations' bytes as the blob holds them; its skip is the offset after its last one, which
       a resume starts from, and its checksum the count and the hash through it, which a resume
       continues. */
    private suspend fun blobPages(b: Backfill, reading: Blob.Reading) {
        reading.resp.use {
            val src = reading.src
            val page = Buffer()
            var ops = 0
            val op = Buffer()
            while (true) {
                val next = withContext(Dispatchers.IO) {
                    src.require(1)
                    src.buffer[0].toInt() and 0xff
                }

                // the end marker, then the footer: the operation count, the content hash, and its crc
                if (next == END) {
                    val (marker, footer) = withContext(Dispatchers.IO) { src.readInt() to src.readByteArray(16) }
                    if (marker != -1) throw IOException("snapshot ${b.selector}: corrupt operation")
                    val crc = Buffer().write(footer, 12, 4).readInt().toLong() and 0xffffffffL
                    if (crc != crc32c(footer, 0, 12)) throw IOException("snapshot ${b.selector}: footer crc")
                    val count = Buffer().write(footer, 0, 4).readInt().toLong() and 0xffffffffL
                    if (count != reading.count) throw IOException("snapshot ${b.selector}: operation count")
                    if (!footer.copyOfRange(4, 12).contentEquals(reading.fnv.digest())) {
                        throw IOException("snapshot ${b.selector}: content hash")
                    }
                    break
                }

                // one set operation, whole: its opcode, key, and value
                if (next != SET) throw IOException("snapshot ${b.selector}: corrupt operation")
                op.clear()
                try {
                    withContext(Dispatchers.IO) {
                        repeat(3) { if (!readValue(src, op, MAX_OPERATION)) throw IOException("body ended early") }
                    }
                } catch (e: PastLimit) {
                    throw IOException("snapshot ${b.selector}: corrupt operation")
                }
                val bytes = op.readByteArray()
                reading.fnv.update(bytes)
                page.write(bytes)
                reading.count++
                reading.offset += bytes.size
                ops++
                if (ops >= PAGE_OPS || page.size >= PAGE_BYTES) {
                    b.push(BackfillItem.Page(page.readByteArray(), reading.offset, "${reading.count}:${reading.fnv.state()}"))
                    ops = 0
                }
            }
            if (ops > 0) b.push(BackfillItem.Page(page.readByteArray(), reading.offset, "${reading.count}:${reading.fnv.state()}"))
            b.push(BackfillItem.PagesDone)
        }
    }

    private suspend fun tail(b: Backfill, from: Long) {
        var after = from
        while (true) {
            val q = listOf("after" to after.toString(), "before" to b.until.toString(), "max" to TAIL_MAX.toString())
            val resp = transport.call(transport.request("/edits/${b.selector}", headers(), q)).await()

            // the page's edits, each raw, and the position its scan reached
            var scanned: Long?
            val edits = ArrayList<ByteArray>()
            var last = after
            resp.use {
                if (resp.code == 401) throw refuse(resp.body.string())
                if (resp.code != 200) throw IOException("edits ${b.selector}: ${resp.code} ${resp.message}")
                scanned = resp.headerLong("PhaseLock-Scanned")
                withContext(Dispatchers.IO) {
                    val src = resp.body.source()
                    val buf = Buffer()
                    while (readValue(src, buf)) {
                        val f = parseFrame(buf.readByteArray())
                        if (f !is Frame.Edits) throw IOException("edits ${b.selector}: ${f::class.simpleName} frame")
                        val r = MsgReader(f.edits)
                        repeat(r.arrayHeader()) {
                            val raw = r.raw()
                            last = MsgReader(raw).run { arrayHeader(); arrayHeader(); long() }
                            edits.add(raw)
                        }
                    }
                }
            }
            if (edits.isNotEmpty()) {
                val w = MsgWriter()
                w.array(edits.size)
                edits.forEach { w.raw(it) }
                b.push(BackfillItem.Edits(w.bytes(), scanned ?: last))
            }

            // the scan is done once it reaches until, or when it reports no progress; a page's edit
            // count says nothing, since a page never splits the edits of one position
            val reached = scanned
            if (reached == null || reached >= b.until || reached <= after) {
                b.push(BackfillItem.EditsDone)
                return
            }
            after = reached
        }
    }

    override suspend fun sendMutations(mutations: List<Mutation>): List<MutationResult> {
        if (ended) throw IOException("mutations: the connection has ended")
        val result = CompletableDeferred<List<MutationResult>>()
        sends.send(mutations to result)
        return result.await()
    }

    // the send queue, one call at a time
    private suspend fun pump() {
        for ((mutations, result) in sends) {
            try {
                result.complete(post(mutations))
            } catch (e: CancellationException) {
                result.completeExceptionally(IOException("mutations: the connection has ended"))
                throw e
            } catch (e: Exception) {
                result.completeExceptionally(e)
                while (true) {
                    val behind = sends.tryReceive().getOrNull() ?: break
                    behind.second.completeExceptionally(e)
                }
                failed(e)
            }
        }
    }

    /* One call, as the requests the database's limit calls for, each with its retries.  A retry
       repeats the request under the same ids, which the database's dedup makes safe.  A 4xx
       answer but a 429 is the client's own doing and stands at once; so does any failure once the
       connection has ended, since the next connection resends. */
    private suspend fun post(mutations: List<Mutation>): List<MutationResult> {
        ready()
        return transport.inRequests(mutations, session == null) { request ->
            var attempt = 0
            while (true) {
                try {
                    return@inRequests transport.postMutations(headers(), request)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (attempt == SEND_RETRIES || !retryable(e, true) || ended) throw e
                    delay(retryDelay(e, attempt))
                    if (ended) throw e
                    attempt++
                }
            }
            @Suppress("UNREACHABLE_CODE")
            throw IllegalStateException()
        }
    }

    // a send that failed ends the connection: the one onEnd carries the response's status, or 0
    // when no response arrived, and the stream stops; a refused session ends it fatally
    private fun failed(e: Exception) {
        if (e is AuthError || (e is StatusError && e.status == 401)) {
            refuse(e.message ?: "refused")
            return
        }
        end((e as? StatusError)?.status ?: 0, e.message ?: e.toString())
        stop()
    }
}

/** One frame of /stream or /edits.  Frame elements appended by later protocol versions are
    skipped; an edits frame carries its raw edits undecoded. */
internal sealed interface Frame {
    class Edits(val edits: ByteArray) : Frame
    data class Live(val position: Long) : Frame
    data class Vouch(val position: Long) : Frame
    data class View(val token: String, val position: Long, val selectors: List<String>) : Frame
    data class End(val code: Int, val reason: String) : Frame
}

internal fun parseFrame(bytes: ByteArray): Frame {
    val r = MsgReader(bytes)
    val n = r.arrayHeader()
    if (n < 1) throw IOException("empty frame")
    val tag = r.str()
    val (frame, used) = when (tag) {
        "edits" -> Frame.Edits(r.raw()) to 2
        "live" -> Frame.Live(r.long()) to 2
        "vouch" -> Frame.Vouch(r.long()) to 2
        "view" -> Frame.View(r.str(), r.long(), List(r.arrayHeader()) { r.str() }) to 4
        "end" -> Frame.End(r.int(), r.str()) to 3
        else -> throw IOException("unknown frame $tag")
    }
    if (n < used) throw IOException("short $tag frame")
    repeat(n - used) { r.skip() }
    return frame
}
