package io.github.noronus.netdash

import android.content.Intent
import android.net.ConnectivityManager
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.progressindicator.CircularProgressIndicator
import com.google.android.material.textfield.TextInputEditText
import java.io.IOException
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import kotlin.concurrent.thread

class SetupActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var address: TextInputEditText
    private lateinit var found: Chip
    private lateinit var status: TextView
    private lateinit var connect: MaterialButton
    private lateinit var busy: CircularProgressIndicator
    private var running = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        prefs = Prefs(this)
        address = findViewById(R.id.address)
        found = findViewById(R.id.found)
        status = findViewById(R.id.status)
        connect = findViewById(R.id.connect)
        busy = findViewById(R.id.busy)
        val scroll = findViewById<View>(R.id.scroll)
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        findViewById<TextView>(R.id.version).text = getString(R.string.version, BuildConfig.VERSION_NAME)

        val current = prefs.server
        if (current != null) {
            findViewById<TextView>(R.id.current).apply {
                text = getString(R.string.setup_current, current)
                visibility = View.VISIBLE
            }
            if (savedInstanceState == null) address.setText(current)
            findViewById<View>(R.id.cancel).apply {
                visibility = View.VISIBLE
                setOnClickListener { close() }
            }
        } else {
            discover()
        }

        connect.setOnClickListener { start() }
        address.setOnEditorActionListener { _, id, _ ->
            if (id == EditorInfo.IME_ACTION_GO) {
                start()
                true
            } else {
                false
            }
        }
    }

    private fun close() {
        if (isTaskRoot && prefs.server != null) startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    /** the firewall is usually the default gateway: if it answers on the netdash port, offer it */
    private fun discover() {
        val cm = getSystemService(ConnectivityManager::class.java)
        val lp = cm.getLinkProperties(cm.activeNetwork) ?: return
        val gw = lp.routes.firstOrNull { it.isDefaultRoute && it.gateway is Inet4Address }?.gateway?.hostAddress ?: return
        thread {
            val open = try {
                Socket().use { it.connect(InetSocketAddress(gw, Prefs.DEFAULT_PORT), 1500) }
                true
            } catch (_: IOException) {
                false
            }
            if (!open) return@thread
            val url = "https://$gw:${Prefs.DEFAULT_PORT}"
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                found.text = getString(R.string.setup_found, url)
                found.visibility = View.VISIBLE
                found.setOnClickListener {
                    address.setText(url)
                    start()
                }
                if (address.text.isNullOrBlank()) address.setText(url)
            }
        }
    }

    private fun start() {
        if (running) return
        val list = Prefs.candidates(address.text?.toString() ?: "")
        if (list.isEmpty()) {
            showStatus(getString(R.string.setup_empty), error = true)
            return
        }
        setBusy(true)
        test(list, 0, null)
    }

    private sealed class Result {
        data class Ok(val origin: String) : Result()
        data class Redirect(val origin: String) : Result()
        data class NotNetdash(val origin: String) : Result()
        data class Failed(val origin: String, val message: String) : Result()
        data class Cert(val origin: String, val e: Tls.Untrusted) : Result()
    }

    /** tries the candidates in order; asks about certificates on the way */
    private fun test(list: List<String>, i: Int, last: Result?) {
        if (i >= list.size) {
            setBusy(false)
            when (last) {
                is Result.NotNetdash -> showStatus(getString(R.string.setup_not_netdash, last.origin), error = true)
                is Result.Failed -> showStatus(getString(R.string.setup_unreachable, last.origin, last.message), error = true)
                else -> showStatus(getString(R.string.setup_not_netdash, list.last()), error = true)
            }
            return
        }
        val origin = list[i]
        showStatus(getString(R.string.setup_testing, origin), error = false)
        thread {
            val r = probe(origin)
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                when (r) {
                    is Result.Ok -> done(r.origin)
                    is Result.Redirect ->
                        if (r.origin in list) test(list, i + 1, Result.NotNetdash(origin))
                        else test(list.subList(0, i + 1) + r.origin + list.drop(i + 1), i + 1, r)
                    is Result.Cert -> askTrust(r.origin, Tls.describe(r.e.cert), changed = r.e.pinned != null,
                        onTrust = { test(list, i, last) },
                        onReject = {
                            setBusy(false)
                            showStatus(getString(R.string.error_cert_rejected, Prefs.hostPort(r.origin)), error = true)
                        })
                    else -> test(list, i + 1, if (last is Result.Failed && r is Result.Failed) last else r)
                }
            }
        }
    }

    /** GET /api/me: netdash answers {"user": …} or 401 {"error": "auth"} */
    private fun probe(origin: String): Result {
        return try {
            val c = Tls.connect("$origin/api/me", prefs, 6000) { it.setRequestProperty("Accept", "application/json") }
            try {
                val code = c.responseCode
                if (code in 300..399) {
                    val loc = c.getHeaderField("Location")?.let { URL(URL("$origin/"), it).toString() }
                    val o = loc?.let { Prefs.origin(it) }
                    return if (o != null && o != origin) Result.Redirect(o) else Result.NotNetdash(origin)
                }
                val body = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText().take(4096) } ?: ""
                val netdash = (code == 200 && body.contains("\"user\"")) || (code == 401 && body.contains("\"auth\""))
                if (netdash) Result.Ok(origin) else Result.NotNetdash(origin)
            } finally {
                c.disconnect()
            }
        } catch (e: Exception) {
            Tls.untrusted(e)?.let { return Result.Cert(origin, it) }
            Result.Failed(origin, e.message ?: e.javaClass.simpleName)
        }
    }

    private fun done(origin: String) {
        if (origin.startsWith("http://")) {
            MaterialAlertDialogBuilder(this)
                .setMessage(R.string.setup_http_warning)
                .setPositiveButton(R.string.setup_connect) { _, _ -> save(origin) }
                .setNegativeButton(R.string.setup_cancel) { _, _ -> setBusy(false) }
                .setCancelable(false)
                .show()
            return
        }
        save(origin)
    }

    private fun save(origin: String) {
        prefs.server = origin
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }

    private fun setBusy(b: Boolean) {
        running = b
        connect.isEnabled = !b
        busy.visibility = if (b) View.VISIBLE else View.GONE
        if (!b && status.currentTextColor != getColor(R.color.nd_bad)) status.visibility = View.GONE
    }

    private fun showStatus(text: String, error: Boolean) {
        status.text = text
        status.setTextColor(getColor(if (error) R.color.nd_bad else R.color.nd_text_2))
        status.visibility = View.VISIBLE
    }
}
