package io.github.noronus.netdash

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.progressindicator.LinearProgressIndicator
import org.json.JSONObject
import java.io.ByteArrayInputStream
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var server: String
    private lateinit var root: View
    private lateinit var topInset: View
    private lateinit var bottomInset: View
    private lateinit var webHolder: ViewGroup
    private lateinit var progress: LinearProgressIndicator
    private lateinit var errorView: View
    private lateinit var errorMessage: TextView
    private var web: WebView? = null
    private var script = ""
    private var injectLate = false // WebView without document-start scripts: inject after load
    private var mainFrameFailed = false
    private var certDialog = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val s = prefs.server
        if (s == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        server = s
        script = assets.open("inject.js").bufferedReader().use { it.readText() }
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        topInset = findViewById(R.id.topInset)
        bottomInset = findViewById(R.id.bottomInset)
        webHolder = findViewById(R.id.webHolder)
        progress = findViewById(R.id.progress)
        errorView = findViewById(R.id.errorView)
        errorMessage = findViewById(R.id.errorMessage)
        findViewById<View>(R.id.retry).setOnClickListener { retry() }
        findViewById<View>(R.id.changeServer).setOnClickListener { openSetup() }

        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, 0, bars.right, 0)
            topInset.layoutParams.height = bars.top
            bottomInset.layoutParams.height = maxOf(bars.bottom, ime.bottom)
            topInset.requestLayout()
            bottomInset.requestLayout()
            WindowInsetsCompat.CONSUMED
        }
        val bg = getColor(R.color.nd_bg)
        setBarColors(bg, bg)

        createWebView()
        val restored = savedInstanceState?.let { web?.restoreState(it) } != null
        if (!restored) web?.loadUrl("$server/")

        onBackPressedDispatcher.addCallback(this) {
            val w = web
            if (w == null || errorView.visibility == View.VISIBLE) {
                moveTaskToBack(true)
                return@addCallback
            }
            // first let the page close an open dialog or panel, then go back in netdash, then leave the app
            w.evaluateJavascript("window.__ndBack ? window.__ndBack() : false") { r ->
                if (r == "true") return@evaluateJavascript
                if (w.canGoBack()) w.goBack() else moveTaskToBack(true)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        val w = WebView(this)
        w.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        w.setBackgroundColor(getColor(R.color.nd_bg))
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            builtInZoomControls = true
            displayZoomControls = false
            userAgentString = "$userAgentString netdash-android/${BuildConfig.VERSION_NAME}"
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(w.settings, false)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        w.webViewClient = Client()
        w.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, p: Int) {
                progress.setProgressCompat(p, true)
                progress.visibility = if (p < 100) View.VISIBLE else View.GONE
            }
        }
        w.setDownloadListener { url, _, disposition, mime, _ -> onDownload(url, disposition, mime) }
        val origins = setOf(server)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, "NetdashApp", origins) { _, message, _, isMainFrame, _ ->
                if (isMainFrame) message.data?.let { onMessage(it) }
            }
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(w, script, origins)
            } else {
                injectLate = true
            }
        }
        webHolder.addView(w)
        web = w
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (Prefs.origin(url) == server) return false
            if (url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("about:")) return false
            openExternal(url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            mainFrameFailed = false
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (!mainFrameFailed) errorView.visibility = View.GONE
            if (injectLate && Prefs.origin(url) == server) view.evaluateJavascript(script, null)
            CookieManager.getInstance().flush()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            mainFrameFailed = true
            showError(describe(error.errorCode, error.description?.toString()))
        }

        @SuppressLint("WebViewClientOnReceivedSslError") // proceeds only for the certificate the user explicitly trusted
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val cert = error.certificate?.x509Certificate
            if (Prefs.origin(error.url) != server || cert == null) {
                handler.cancel()
                return
            }
            val fp = Tls.sha256(cert)
            val pinned = prefs.pin(Prefs.hostPort(server))
            if (fp == pinned) {
                handler.proceed()
                return
            }
            handler.cancel()
            mainFrameFailed = true // keep WebView's own error page hidden behind the dialog
            if (certDialog) return
            certDialog = true
            showError(getString(R.string.cert_checking, Prefs.hostPort(server)))
            askTrust(server, Tls.describe(cert), changed = pinned != null, onTrust = {
                certDialog = false
                retry()
            }, onReject = {
                certDialog = false
                mainFrameFailed = true
                showError(getString(R.string.error_cert_rejected, Prefs.hostPort(server)))
            })
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "renderer gone, crash=${detail.didCrash()}")
            webHolder.removeView(view)
            view.destroy()
            if (web === view) web = null
            createWebView()
            web?.loadUrl("$server/")
            return true
        }
    }

    private fun describe(code: Int, raw: String?): String {
        val host = Prefs.hostPort(server)
        return when (code) {
            WebViewClient.ERROR_HOST_LOOKUP -> "Die Adresse $host wurde nicht gefunden. Bist du im Heimnetz oder per VPN verbunden?"
            WebViewClient.ERROR_CONNECT, WebViewClient.ERROR_TIMEOUT ->
                "$host antwortet nicht. Bist du im Heimnetz oder per VPN verbunden?"
            WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> "TLS-Verbindung zu $host fehlgeschlagen."
            else -> "$host: ${raw ?: "Fehler $code"}"
        }
    }

    private fun showError(message: String) {
        errorMessage.text = message
        errorView.visibility = View.VISIBLE
        progress.visibility = View.GONE
        val bg = getColor(R.color.nd_bg)
        setBarColors(bg, bg)
    }

    private fun retry() {
        val w = web ?: return
        // the error view stays until the page has loaded (onPageFinished), so WebView's own error page never shows
        progress.visibility = View.VISIBLE
        val url = w.url
        if (url != null && Prefs.origin(url) == server) w.reload() else w.loadUrl("$server/")
    }

    private fun openSetup() {
        startActivity(Intent(this, SetupActivity::class.java))
    }

    // ------------------------------------------------------------ messages from inject.js

    private fun onMessage(data: String) {
        val m = try {
            JSONObject(data)
        } catch (_: Exception) {
            return
        }
        when (m.optString("t")) {
            "save" -> {
                val name = m.optString("name").ifEmpty { "download" }
                val mime = m.optString("mime")
                val bytes = try {
                    Base64.decode(m.optString("b64"), Base64.DEFAULT)
                } catch (_: Exception) {
                    return
                }
                save(name, mime) { ByteArrayInputStream(bytes) }
            }
            "dl" -> download(m.optString("url"), m.optString("name").ifEmpty { null }, null, null)
            "copy" -> {
                val cm = getSystemService(ClipboardManager::class.java)
                cm.setPrimaryClip(ClipData.newPlainText("netdash", m.optString("text")))
                if (Build.VERSION.SDK_INT < 33) Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show()
            }
            "setup" -> openSetup()
            "theme" -> {
                val top = parseRgb(m.optString("top")) ?: return
                val bottom = parseRgb(m.optString("bottom")) ?: top
                if (errorView.visibility != View.VISIBLE) setBarColors(top, bottom)
            }
        }
    }

    private fun parseRgb(s: String): Int? {
        val n = Regex("[\\d.]+").findAll(s).map { it.value.toFloat() }.toList()
        if (n.size < 3) return null
        if (n.size >= 4 && n[3] < 0.5f) return null // transparent: not a netdash page
        return Color.rgb(n[0].toInt(), n[1].toInt(), n[2].toInt())
    }

    private fun setBarColors(top: Int, bottom: Int) {
        topInset.setBackgroundColor(top)
        bottomInset.setBackgroundColor(bottom)
        root.setBackgroundColor(top)
        val c = WindowCompat.getInsetsController(window, root)
        c.isAppearanceLightStatusBars = ColorUtils.calculateLuminance(top) > 0.5
        c.isAppearanceLightNavigationBars = ColorUtils.calculateLuminance(bottom) > 0.5
    }

    // ------------------------------------------------------------ downloads

    private fun onDownload(url: String, disposition: String?, mime: String?) {
        when {
            url.startsWith("blob:") || url.startsWith("data:") -> {
                val name = URLUtil.guessFileName(url, disposition, mime)
                web?.evaluateJavascript("window.__ndSave && window.__ndSave(${JSONObject.quote(url)}, ${JSONObject.quote(name)})", null)
            }
            Prefs.origin(url) == server -> download(url, null, disposition, mime)
            else -> openExternal(url)
        }
    }

    /** downloads a server URL with the WebView's session cookie */
    private fun download(url: String, name: String?, disposition: String?, mime: String?) {
        if (Prefs.origin(url) != server) return
        val cookie = CookieManager.getInstance().getCookie(url)
        val ua = web?.settings?.userAgentString
        thread {
            try {
                val c = Tls.connect(url, prefs, 30000) { c ->
                    if (cookie != null) c.setRequestProperty("Cookie", cookie)
                    if (ua != null) c.setRequestProperty("User-Agent", ua)
                }
                try {
                    if (c.responseCode !in 200..299) throw IllegalStateException("HTTP ${c.responseCode}")
                    val type = c.contentType ?: mime
                    val file = name ?: URLUtil.guessFileName(url, c.getHeaderField("Content-Disposition") ?: disposition, type)
                    val uri = saveDownload(file, type, c.inputStream)
                    runOnUiThread { showSaved(root, uri, file, type) }
                } finally {
                    c.disconnect()
                }
            } catch (e: Exception) {
                Log.w(TAG, "download failed", e)
                runOnUiThread { Toast.makeText(this, getString(R.string.download_failed, e.message ?: e.javaClass.simpleName), Toast.LENGTH_LONG).show() }
            }
        }
    }

    private fun save(name: String, mime: String?, input: () -> java.io.InputStream) {
        thread {
            try {
                val uri = saveDownload(name, mime, input())
                runOnUiThread { showSaved(root, uri, name, mime) }
            } catch (e: Exception) {
                Log.w(TAG, "save failed", e)
                runOnUiThread { Toast.makeText(this, getString(R.string.download_failed, e.message ?: e.javaClass.simpleName), Toast.LENGTH_LONG).show() }
            }
        }
    }

    // ------------------------------------------------------------ lifecycle

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web?.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web?.onResume()
    }

    override fun onPause() {
        web?.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        web?.let {
            webHolder.removeView(it)
            it.destroy()
        }
        web = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "netdash"
    }
}
