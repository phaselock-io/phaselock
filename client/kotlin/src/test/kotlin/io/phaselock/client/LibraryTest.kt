package io.phaselock.client

import io.phaselock.examples.library.*
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

/** The database, run from its release binary with a bundle, in a data directory of its own, on a
    free loopback port; the test's transport speaks to it. */
class Database(bundle: File) : AutoCloseable {
    val port: Int = ServerSocket(0).use { it.localPort }
    private val data: File = Files.createTempDirectory("phaselockdb").toFile()
    private val process: Process
    val url = "http://127.0.0.1:$port/phaselock"

    init {
        val bin = File(repo, "db/target/release/phaselockdb")
        check(bin.canExecute()) { "build the database first: make -C db" }
        process = ProcessBuilder(
            bin.path, "--bundle", bundle.path, "--data", data.path, "--listen", "127.0.0.1:$port",
        ).redirectErrorStream(true).redirectOutput(File(data, "log")).start()

        // up once its port takes a connection
        val deadline = System.currentTimeMillis() + 10_000
        while (true) {
            try {
                Socket("127.0.0.1", port).close()
                break
            } catch (e: Exception) {
                check(process.isAlive) { "the database exited: ${File(data, "log").readText()}" }
                check(System.currentTimeMillis() < deadline) { "the database never listened" }
                Thread.sleep(20)
            }
        }
    }

    override fun close() {
        process.destroy()
        process.waitFor()
        data.deleteRecursively()
    }

    companion object {
        val repo = File(System.getProperty("phaselock.repo"))
    }
}

class LibraryTest {
    private val model = File(Database.repo, "examples/library/model")
    private val db = Database(File(model, "bundle.js"))
    private val transport = HttpTransport(db.url)
    private val host = runBlocking { openHost() }
    private val stores = Files.createTempDirectory("stores").toFile()

    @AfterTest
    fun close() {
        runBlocking { host.closeAndJoin() }
        transport.close()
        db.close()
        stores.deleteRecursively()
    }

    private suspend fun openHost(): EngineHost =
        EngineHost.open(File(model, "native.dev.bundle.js").readBytes(), "native.dev.bundle.js", transport)

    // a room the database seeded
    private suspend fun room(): String {
        val room = generateUuid()
        val created = postLibraryMutation(transport, CreateRoom(room))
        assertTrue(created is MutationResult.Ok, "$created")
        return room
    }

    private suspend fun signIn(room: String, login: String): Session =
        transport.login(Credentials.Password("$room:$login", "password"))

    @Test
    fun aPatronsEngineSyncsTheCatalogAndPredictsAHold() = runBlocking {
        withTimeout(30_000) {
            val room = room()
            val session = signIn(room, "alice")
            val alice = UserEngine.open(host, session, File(stores, "alice"))
            var ended: EngineEnded? = null
            alice.onEnded { ended = it }
            val queries = UserQueries(alice)

            // live, with the seeded catalog: four editions
            alice.status.first { it.connection.state == ConnectionStatus.State.LIVE }
            val books = queries.allBooks().first { it.size == 4 }
            assertEquals(
                listOf("A Tale of Two Cities", "Great Expectations", "One Hundred Years of Solitude", "War and Peace"),
                books.map { it.title },
            )

            // a hold on an edition shows pending at once, then decided
            val patron = session.user.substringAfter('.')
            val isbn = "978-0-14-143956-3"
            alice.sendMutation(TryHold(room, generateUuid(), patron, HoldTarget.Edition(isbn), false, Instant.now()))
            val pending = queries.myPatron().first { it.holds.isNotEmpty() }
            assertEquals(true, pending.holds[0].pending)
            val decided = queries.myPatron().first { it.holds.isNotEmpty() && it.holds[0].pending == null }
            assertEquals(HoldTarget.Edition(isbn), decided.holds[0].target)
            assertEquals(isbn, queries.allBooks().first().first { it.title == "Great Expectations" }.hold?.let { (it.target as HoldTarget.Edition).edition })
            alice.status.first { it.outbox.unacknowledged == 0 }

            // an @online mutation answers with the database's outcome
            val changed = alice.sendOnlineMutation(ChangePassword(room, MutationAuth.Password("password"), "another password"))
            assertTrue(changed is MutationResult.Ok, "$changed")
            assertTrue(ended == null, "the engine ended: $ended")
        }
    }

    @Test
    fun aLibrariansCheckoutReachesThePatron() = runBlocking {
        withTimeout(30_000) {
            val room = room()
            val bobSession = signIn(room, "bob")
            val bob = UserEngine.open(host, bobSession, File(stores, "bob"))
            val admin = AdminEngine.open(host, signIn(room, "admin"), null)
            val adminQueries = AdminQueries(admin)

            // the librarian sees both patrons, and checks out an unrestricted copy to Bob
            val patrons = adminQueries.allPatrons().first { it.size == 2 }
            val bobId = patrons.first { it.name == "Bob" }.id
            val editions = adminQueries.allEditions().first { it.isNotEmpty() }
            val copy = editions.first { it.title == "War and Peace" }.books.first { it.state == AdminBookInfoState.OPEN }
            admin.sendMutation(TryCheckout(room, generateUuid(), bobId, copy.id, Instant.now()))

            // the copy is out for the librarian at once, predicted, and Bob's profile shows it once
            // it is decided
            val out = adminQueries.allEditions().first { eds ->
                eds.flatMap { it.books }.first { it.id == copy.id }.state == AdminBookInfoState.OUT
            }
            assertEquals(bobId, out.flatMap { it.books }.first { it.id == copy.id }.patronId)
            val checkouts = UserQueries(bob).myPatron().first { it.checkouts.isNotEmpty() }.checkouts
            assertEquals("War and Peace", checkouts[0].title)
            assertTrue(adminQueries.roomCreated().first() != null)
        }
    }

    @Test
    fun aStoreOpensAgainInAnotherHostOnceItsHostHasClosed() = runBlocking<Unit> {
        withTimeout(30_000) {
            val room = room()
            val session = signIn(room, "alice")
            val store = File(stores, "alice")

            // the catalog, synced into the store
            val first = UserEngine.open(host, session, store)
            UserQueries(first).allBooks().first { it.size == 4 }
            host.closeAndJoin()

            // a closed host fails what it is asked
            assertFailsWith<HostError> { UserEngine.open(host, session, null) }
            assertFailsWith<HostError> { first.sendMutation(CancelHold(room, generateUuid(), session.user.substringAfter('.'))) }

            // another host opens the same directory, since the first host's close has completed
            val next = openHost()
            try {
                val again = UserEngine.open(next, session, store)
                UserQueries(again).allBooks().first { it.size == 4 }
            } finally {
                next.closeAndJoin()
            }
        }
    }
}
