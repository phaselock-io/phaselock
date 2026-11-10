// A room of the demo on this device: the database it is in, and the three windows signed in to
// it, each its own Engine over its own way to the database, all run by one native host off the
// main thread.  Each Engine keeps its store on disk, so a room opened again starts from what it
// held, offline as well as on.

package io.phaselock.examples.library.android

import android.app.Application
import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.phaselock.client.Backfill
import io.phaselock.client.BackfillOutcome
import io.phaselock.client.Connection
import io.phaselock.client.ConnectionHooks
import io.phaselock.client.Credentials
import io.phaselock.client.EngineEnded
import io.phaselock.client.EngineHost
import io.phaselock.client.HttpTransport
import io.phaselock.client.Mutation
import io.phaselock.client.MutationResult
import io.phaselock.client.Session
import io.phaselock.client.Transport
import io.phaselock.client.generateUuid
import io.phaselock.examples.library.AdminEngine
import io.phaselock.examples.library.CreateRoom
import io.phaselock.examples.library.UserEngine
import io.phaselock.examples.library.postLibraryMutation
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

// what the app keeps between runs: the server and room it was last in, and each login's token
private val Context.keptData by preferencesDataStore("room")
private val SERVER = stringPreferencesKey("server")
private val ROOM = stringPreferencesKey("room")
private fun tokenKey(room: String, login: String) = stringPreferencesKey("token:$room:$login")

/** A window's own way to the database, with a switch that takes it offline as a dropped network
    would: the live connection ends, every attempt after it fails at once, and the Engine queues
    its mutations and retries until the switch is on again. */
class SwitchedTransport(private val http: HttpTransport) : Transport {
    // the connection the switch ends; an Engine has one at a time
    @Volatile private var current: Connection? = null

    val online = MutableStateFlow(true)

    fun setOnline(on: Boolean) {
        online.value = on
        if (!on) current?.abort()
    }

    override fun connect(
        since: Long,
        view: String?,
        wants: List<String>,
        session: Session?,
        hooks: ConnectionHooks,
    ): Connection {
        // offline, the attempt ends as soon as it starts
        if (!online.value) {
            hooks.onEnd(0, "offline", null)
            return Offline
        }

        // online, the connection lasts until the Engine ends it or the switch goes off
        return http.connect(since, view, wants, session, hooks).also { current = it }
    }

    override suspend fun post(mutations: List<Mutation>, session: Session?): List<MutationResult> {
        if (!online.value) throw IOException("offline")
        return http.post(mutations, session)
    }

    private object Offline : Connection {
        override suspend fun backfill(b: Backfill): BackfillOutcome = throw IOException("offline")
        override suspend fun sendMutations(mutations: List<Mutation>): List<MutationResult> =
            throw IOException("offline")
        override fun abort() {}
    }
}

/** one window: its Engine, its switch, and the id of the user it is signed in as */
class Window<E>(val engine: E, val transport: SwitchedTransport, val user: String)

/** the three windows the demo shows, each signed in as its own user, as three phones would be */
class Windows(
    val room: String,
    val desk: Window<AdminEngine>,
    val alice: Window<UserEngine>,
    val bob: Window<UserEngine>,
)

/** the server and room the app was last in */
class Last(val server: String, val room: String)

/** The room the app is in, and getting into one. */
class RoomViewModel(app: Application) : AndroidViewModel(app) {
    sealed interface State {
        data object Choosing : State
        data object Opening : State
        class Open(val windows: Windows) : State
        class Failed(val reason: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Choosing)
    val state: StateFlow<State> = _state

    private val kept = app.keptData
    // the one HTTP client of every room the app opens, whose connections outlast a room's
    private val client = OkHttpClient()
    private var host: EngineHost? = null
    // what tells the host of the app's returns to the foreground and of network changes
    private var follower: AppFollower? = null
    private var http: HttpTransport? = null
    // the last room's host, whose close the next room awaits, since it opens the same stores
    private var left: EngineHost? = null

    /** the server and room the app was last in, once they have loaded */
    val last: StateFlow<Last?> = kept.data
        .map { Last(it[SERVER] ?: DEFAULT_SERVER, it[ROOM].orEmpty()) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    /** Opens a room on the server, a new one when room is blank.  For a room that exists,
        CreateRoom writes nothing.  The app is in one room at a time, so an open while a room
        opens or is open does nothing. */
    fun open(server: String, room: String) {
        if (_state.value == State.Opening || _state.value is State.Open) return
        _state.value = State.Opening
        viewModelScope.launch {
            // the last room's stores are closed before any of them opens again
            left?.closeAndJoin()

            try {
                _state.value = State.Open(windows(server.trim(), room.trim().ifEmpty { generateUuid() }))
            } catch (e: Exception) {
                close()
                _state.value = State.Failed(e.message ?: e.toString())
            }
        }
    }

    /** leaves the room, ending its Engines; their stores stay for the next time */
    fun leave() {
        close()
        _state.value = State.Choosing
    }

    private suspend fun windows(server: String, room: String): Windows {
        kept.edit {
            it[SERVER] = server
            it[ROOM] = room
        }
        val http = HttpTransport(server, client).also { this.http = it }

        // the room exists before anyone signs in to it; offline, a room opened before still opens
        try {
            val created = postLibraryMutation(http, CreateRoom(room))
            if (created !is MutationResult.Ok) throw IOException("the room was not created: $created")
        } catch (e: IOException) {
            if (kept.data.first()[tokenKey(room, "admin")] == null) throw e
        }

        // the host, with the model's native bundle
        val bundle = withContext(Dispatchers.IO) {
            getApplication<Application>().assets.open("native.bundle.js").use { it.readBytes() }
        }
        val host = EngineHost.open(bundle, "native.bundle.js", http).also { this.host = it }
        follower = AppFollower(getApplication(), host)

        // each window signs itself in, as the web demo's do
        fun store(login: String) = File(getApplication<Application>().filesDir, "stores/$room/$login")
        suspend fun window(login: String): Pair<Session, SwitchedTransport> =
            signIn(http, room, login) to SwitchedTransport(http)
        val (deskSession, deskWay) = window("admin")
        val (aliceSession, aliceWay) = window("alice")
        val (bobSession, bobWay) = window("bob")
        val windows = Windows(
            room,
            Window(AdminEngine.open(host, deskSession, store("admin"), deskWay), deskWay, userOf(deskSession)),
            Window(UserEngine.open(host, aliceSession, store("alice"), aliceWay), aliceWay, userOf(aliceSession)),
            Window(UserEngine.open(host, bobSession, store("bob"), bobWay), bobWay, userOf(bobSession)),
        )

        /* A window whose Engine ends takes the room with it, and the app goes back to choosing.  A
           room an hour old is erased, which refuses its tokens; any other end names its own
           reason.  The ends are heard on the engine thread and acted on here. */
        val app = getApplication<Application>()
        fun ended(e: EngineEnded) {
            val reason = if (e.auth) app.getString(R.string.room_reset) else app.getString(R.string.room_ended, e.reason)
            viewModelScope.launch { end(windows, reason) }
        }
        windows.desk.engine.onEnded(::ended)
        windows.alice.engine.onEnded(::ended)
        windows.bob.engine.onEnded(::ended)
        return windows
    }

    // leaves a room whose Engine ended; the first of its windows to end leaves it, and the
    // others find it already left
    private fun end(windows: Windows, reason: String) {
        if ((_state.value as? State.Open)?.windows !== windows) return
        close()
        _state.value = State.Failed(reason)
    }

    /* Signs a login in with the demo's shared password (see the seed in the model's bundle), and
       keeps the token, so the room opens again offline with the session it had. */
    private suspend fun signIn(http: HttpTransport, room: String, login: String): Session {
        val key = tokenKey(room, login)
        val session = try {
            http.login(Credentials.Password("$room:$login", "password"))
        } catch (e: IOException) {
            kept.data.first()[key]?.let { Session.restore(it) } ?: throw e
        }
        keep(key, session.token)
        session.onRefresh = { viewModelScope.launch { keep(key, it.token) } }
        return session
    }

    private suspend fun keep(key: Preferences.Key<String>, token: String) = kept.edit { it[key] = token }

    // the user id's own half, the patron's id for a patron
    private fun userOf(session: Session): String = session.user.substringAfter('.')

    private fun close() {
        (state.value as? State.Open)?.windows?.let {
            it.desk.engine.close()
            it.alice.engine.close()
            it.bob.engine.close()
        }
        follower?.close()
        host?.close()
        http?.close()
        follower = null
        left = host
        host = null
        http = null
    }

    override fun onCleared() {
        close()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    companion object {
        /** the hosted demo's database, which the web demo at demo.phaselock.io uses */
        const val DEFAULT_SERVER = "https://demo.phaselock.io/phaselock"
    }
}
