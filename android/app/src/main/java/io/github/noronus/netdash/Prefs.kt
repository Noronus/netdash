package io.github.noronus.netdash

import android.content.Context
import android.net.Uri
import androidx.core.content.edit

/** server address and the certificates the user trusted (one SHA-256 fingerprint per host:port) */
class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("netdash", Context.MODE_PRIVATE)

    /** origin like https://192.168.1.1:8098, without trailing slash; null until set up */
    var server: String?
        get() = sp.getString("server", null)
        set(v) = sp.edit { putString("server", v) }

    fun pin(hostPort: String): String? = sp.getString("pin:$hostPort", null)

    fun setPin(hostPort: String, sha256: String) = sp.edit { putString("pin:$hostPort", sha256) }

    companion object {
        const val DEFAULT_PORT = 8098

        /** "host:port" with the scheme's default port filled in */
        fun hostPort(uri: Uri): String {
            val port = if (uri.port != -1) uri.port else if (uri.scheme == "http") 80 else 443
            val host = uri.host ?: ""
            return (if (host.contains(':')) "[$host]" else host) + ":" + port
        }

        fun hostPort(url: String): String = hostPort(Uri.parse(url))

        /** scheme://host[:port] of a URL, or null if it is not http(s) */
        fun origin(url: String): String? {
            val u = Uri.parse(url)
            val scheme = u.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            val host = u.host ?: return null
            val h = if (host.contains(':')) "[$host]" else host
            return "$scheme://$h" + (if (u.port != -1) ":${u.port}" else "")
        }

        /**
         * Turns what the user typed into candidate origins, best guess first.
         * "192.168.1.1" -> https://192.168.1.1:8098, https://192.168.1.1
         * "https://net.example.com" -> just that
         */
        fun candidates(input: String): List<String> {
            var s = input.trim().trimEnd('/')
            if (s.isEmpty()) return emptyList()
            val hasScheme = s.contains("://")
            if (!hasScheme) s = "https://$s"
            val origin = origin(s) ?: return emptyList()
            val u = Uri.parse(origin)
            if (hasScheme || u.port != -1) return listOf(origin)
            return listOf("$origin:$DEFAULT_PORT", origin)
        }
    }
}
