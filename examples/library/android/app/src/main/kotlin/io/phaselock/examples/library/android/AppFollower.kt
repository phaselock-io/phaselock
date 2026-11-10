// What a host follows of the app it runs in: the app returning to the foreground, and the
// device's network changing.  The host's own client library is a plain JVM library, so the
// Android half of following the app lives here, beside the app.

package io.phaselock.examples.library.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import io.phaselock.client.EngineHost

/** Tells a host when the app returns to the foreground and when the device's default network
    changes, until closed.  Made and closed on the main thread. */
class AppFollower(context: Context, private val host: EngineHost) : AutoCloseable {
    private val lifecycle = ProcessLifecycleOwner.get().lifecycle
    private val foreground = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) = host.enterForeground()
    }

    /* The default network: the first one heard is the network the host starts on, and after it
       a network that differs from the last one, or that comes after the last was lost, is a
       change.  The callbacks run on one thread of the system's. */
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val network = object : ConnectivityManager.NetworkCallback() {
        private var heard = false
        private var current: Network? = null

        override fun onAvailable(network: Network) {
            if (heard && network != current) host.networkChanged()
            heard = true
            current = network
        }

        override fun onLost(network: Network) {
            if (network == current) current = null
        }
    }

    init {
        lifecycle.addObserver(foreground)
        connectivity.registerDefaultNetworkCallback(network)
    }

    override fun close() {
        lifecycle.removeObserver(foreground)
        connectivity.unregisterNetworkCallback(network)
    }
}
