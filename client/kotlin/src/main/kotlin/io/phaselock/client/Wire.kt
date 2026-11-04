// The transport contract, as the skeleton states it, in Kotlin: what a connection delivers to the
// Engine, what it fetches for a backfill, and what it sends.  A Promise there is a suspend
// function here, and a cancelled coroutine is an aborted call.

package io.phaselock.client

/** A mutation as it travels: the id it carries through the log, the series and number the
    database dedups it by (both null for an unnumbered one), and its wire bytes. */
class Mutation(val id: String, val series: String?, val n: Long?, val data: ByteArray)

/** What the database answers for a mutation.  Ok means it was decided at or before position, so
    a client that has applied that far can read the outcome from its state. */
sealed interface MutationResult {
    data class Ok(val position: Long) : MutationResult
    data class Reject(val reason: String) : MutationResult
    data class Conflict(val current: Map<String, Long>) : MutationResult
}

/** What an earlier attempt at a backfill got through, as the skeleton's Backfill.resume. */
data class Resume(
    val position: Long,
    val visible: Long,
    val skipBytes: Long,
    val checksum: String,
    val fromPosition: Long,
    val snapshotDone: Boolean,
    val tailDone: Boolean,
)

/** One delivery of a backfill, as the skeleton's BackfillItem.  Edits are a msgpack array of raw
    edits, as a frame carries them. */
sealed interface BackfillItem {
    data class Length(val length: Long) : BackfillItem
    data class Header(val position: Long, val seqs: Map<String, Long>, val visible: Long) : BackfillItem
    class Page(val page: ByteArray, val skip: Long, val checksum: String) : BackfillItem
    data object PagesDone : BackfillItem
    class Edits(val edits: ByteArray, val scanned: Long) : BackfillItem
    data object EditsDone : BackfillItem
}

enum class BackfillOutcome { DONE, STALE }

/** One backfill call: the selector, the tail's exclusive upper bound, what an earlier attempt got
    through, and push, which returns once the Engine has committed the delivery. */
class Backfill(
    val selector: String,
    val until: Long,
    val resume: Resume?,
    val push: suspend (BackfillItem) -> Unit,
)

/** What a connection delivers to the Engine, in order, from any thread. */
interface ConnectionHooks {
    fun onOpen(epoch: String, head: Long)
    fun onView(token: String, position: Long, selectors: List<String>)

    /** a frame's edits: the msgpack array of raw edits it carries */
    fun onEdits(edits: ByteArray)
    fun onLive(position: Long)
    fun onVouch(position: Long)

    /** the one end of the connection; fatal is a refused session, which ends the Engine */
    fun onEnd(code: Int, reason: String, fatal: AuthError?)
}

/** One connection: the live stream, and the backfills and sends that ride on it.  Calls to
    sendMutations apply in call order; one that fails also fails every call behind it, unsent,
    and ends the connection. */
interface Connection {
    suspend fun backfill(b: Backfill): BackfillOutcome
    suspend fun sendMutations(mutations: List<Mutation>): List<MutationResult>

    /** ends the connection, which ends with onEnd if it has not ended already */
    fun abort()
}

/** How an Engine reaches its database. */
interface Transport {
    fun connect(
        since: Long,
        view: String?,
        wants: List<String>,
        session: Session?,
        hooks: ConnectionHooks,
    ): Connection

    /** mutations outside any connection, as the session or as anonymous */
    suspend fun post(mutations: List<Mutation>, session: Session?): List<MutationResult>
}
