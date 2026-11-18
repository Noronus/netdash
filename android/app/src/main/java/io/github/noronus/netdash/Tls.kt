package io.github.noronus.netdash

import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.text.DateFormat
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * TLS for the app's own connections (connection test, downloads). Same rule as in the WebView:
 * a certificate is fine if Android trusts it, or if its SHA-256 fingerprint is the one the user trusted for this host:port.
 */
object Tls {
    fun sha256(cert: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") { "%02X".format(it) }

    fun describe(cert: X509Certificate): CertInfo = CertInfo(
        subject = cert.subjectX500Principal.name.cnOrAll(),
        issuer = cert.issuerX500Principal.name.cnOrAll(),
        validUntil = DateFormat.getDateInstance(DateFormat.MEDIUM).format(cert.notAfter),
        sha256 = sha256(cert),
    )

    private fun String.cnOrAll(): String =
        split(",").map { it.trim() }.firstOrNull { it.startsWith("CN=") }?.removePrefix("CN=") ?: this

    private val systemTm: X509TrustManager by lazy {
        val f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        f.init(null as KeyStore?)
        f.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    /** thrown when the server's certificate is neither system-trusted nor pinned; carries the certificate for the dialog */
    class Untrusted(val cert: X509Certificate, val pinned: String?) : CertificateException("untrusted certificate")

    private class PinningTm(private val pinned: String?) : X509TrustManager {
        var leaf: X509Certificate? = null
        var systemTrusted = false

        override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
            leaf = chain.firstOrNull()
            try {
                systemTm.checkServerTrusted(chain, authType)
                systemTrusted = true
                return
            } catch (_: CertificateException) {
            }
            val l = leaf ?: throw CertificateException("no certificate")
            if (pinned != null && sha256(l) == pinned) return
            throw Untrusted(l, pinned)
        }

        override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) =
            throw CertificateException("not a server")

        override fun getAcceptedIssuers(): Array<X509Certificate> = systemTm.acceptedIssuers
    }

    /**
     * Opens and connects with the pinning rule. A pinned certificate is accepted for any host name
     * (the firewall's self-signed certificate rarely names its IP); a system-trusted one must match the host
     * unless the user pinned it. Throws [Untrusted] (possibly wrapped) when the user has to decide.
     */
    fun connect(url: String, prefs: Prefs, timeoutMs: Int = 10000, setup: (HttpURLConnection) -> Unit = {}): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        c.instanceFollowRedirects = false
        setup(c)
        if (c !is HttpsURLConnection) {
            c.connect()
            return c
        }
        val pinned = prefs.pin(Prefs.hostPort(url))
        val tm = PinningTm(pinned)
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(tm), null)
        c.sslSocketFactory = ctx.socketFactory
        val default = HttpsURLConnection.getDefaultHostnameVerifier()
        c.setHostnameVerifier { host, session ->
            !tm.systemTrusted || default.verify(host, session) || tm.leaf?.let { sha256(it) == pinned } == true
        }
        try {
            c.connect()
        } catch (e: SSLPeerUnverifiedException) {
            // trusted CA, but issued for another name (e.g. a Let's Encrypt certificate opened by IP)
            throw tm.leaf?.let { Untrusted(it, pinned) } ?: e
        }
        return c
    }

    /** finds the Untrusted exception anywhere in the cause chain (it arrives wrapped in an SSLHandshakeException) */
    fun untrusted(e: Throwable?): Untrusted? {
        var t = e
        while (t != null) {
            if (t is Untrusted) return t
            t = t.cause
        }
        return null
    }
}

data class CertInfo(val subject: String, val issuer: String, val validUntil: String, val sha256: String)
