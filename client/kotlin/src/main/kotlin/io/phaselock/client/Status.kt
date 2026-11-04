// The Engine's status, as the skeleton's EngineStatus reports it, read from the plain value the
// native host's status query delivers.

package io.phaselock.client

import java.time.Instant

data class ConnectionStatus(
    val state: State,
    val nextAttemptAt: Instant?,
    val hasBase: Boolean,
    val frozen: Boolean,
) {
    enum class State { CONNECTING, SYNCING, LIVE, OFFLINE }
}

/** One backfill in flight: its snapshot in bytes, and its tail in log positions once the blob's
    header gives the cut. */
data class BackfillStatus(
    val selector: String,
    val snapshotBytes: Long,
    val snapshotLength: Long?,
    val snapshotDone: Boolean,
    val tail: Tail?,
    val retryAt: Instant?,
) {
    data class Tail(val cut: Long, val scanned: Long, val until: Long, val done: Boolean)
}

/** How far syncing has come; estimate runs from 0 to 1 over the work in progress, and is null
    when nothing is in progress. */
data class ProgressStatus(
    val estimate: Double?,
    val since: Long,
    val head: Long?,
    val committed: Long,
    val applied: Long,
    val backfills: List<BackfillStatus>,
)

/** the outbox: mutations the database has not acknowledged */
data class OutboxStatus(val unacknowledged: Int)

data class EngineStatus(
    val connection: ConnectionStatus,
    val progress: ProgressStatus,
    val outbox: OutboxStatus,
)

private fun Any?.map(): Map<*, *> = this as Map<*, *>
private fun Any?.long(): Long = (this as Number).toLong()
private fun Any?.instant(): Instant? = (this as? Number)?.let { Instant.ofEpochMilli(it.toLong()) }

internal fun engineStatus(v: Any?): EngineStatus {
    val m = v.map()
    val c = m["connection"].map()
    val p = m["progress"].map()
    val log = p["log"].map()
    return EngineStatus(
        connection = ConnectionStatus(
            state = ConnectionStatus.State.valueOf((c["state"] as String).uppercase()),
            nextAttemptAt = c["nextAttemptAt"].instant(),
            hasBase = c["hasBase"] as Boolean,
            frozen = c["frozen"] as Boolean,
        ),
        progress = ProgressStatus(
            estimate = (p["estimate"] as? Number)?.toDouble(),
            since = log["since"].long(),
            head = (log["head"] as? Number)?.toLong(),
            committed = log["committed"].long(),
            applied = log["applied"].long(),
            backfills = (p["backfills"] as List<*>).map { b ->
                val bm = b.map()
                val snap = bm["snapshot"].map()
                val tail = bm["tail"] as? Map<*, *>
                BackfillStatus(
                    selector = bm["selector"] as String,
                    snapshotBytes = snap["bytes"].long(),
                    snapshotLength = (snap["length"] as? Number)?.toLong(),
                    snapshotDone = snap["done"] as Boolean,
                    tail = tail?.let {
                        BackfillStatus.Tail(it["cut"].long(), it["scanned"].long(), it["until"].long(), it["done"] as Boolean)
                    },
                    retryAt = bm["retryAt"].instant(),
                )
            },
        ),
        outbox = OutboxStatus(m["outbox"].map()["unacknowledged"].long().toInt()),
    )
}
