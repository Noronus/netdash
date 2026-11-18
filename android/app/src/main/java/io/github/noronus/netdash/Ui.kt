package io.github.noronus.netdash

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.view.View
import android.webkit.MimeTypeMap
import android.widget.Toast
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import java.io.InputStream

/** asks whether to trust a certificate; [onTrust] runs after the fingerprint has been stored */
fun Activity.askTrust(origin: String, info: CertInfo, changed: Boolean, onTrust: () -> Unit, onReject: () -> Unit = {}) {
    if (isFinishing || isDestroyed) return
    val host = Prefs.hostPort(origin)
    val body = getString(if (changed) R.string.cert_changed_body else R.string.cert_body, host) + "\n\n" +
        getString(R.string.cert_details, info.subject, info.issuer, info.validUntil, info.sha256)
    MaterialAlertDialogBuilder(this)
        .setTitle(if (changed) R.string.cert_changed_title else R.string.cert_title)
        .setMessage(body)
        .setCancelable(false)
        .setPositiveButton(R.string.cert_trust) { _, _ ->
            Prefs(this).setPin(host, info.sha256)
            onTrust()
        }
        .setNegativeButton(R.string.cert_reject) { _, _ -> onReject() }
        .show()
}

/** saves into the public Downloads folder; returns the content URI */
fun Context.saveDownload(name: String, mime: String?, input: InputStream): Uri {
    val clean = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().ifEmpty { "download" }
    // MediaStore rewrites the extension when it does not match the MIME type (x.conf as text/plain -> x.conf.txt),
    // so store with the type that belongs to the extension and use the real type only for "open"
    val ext = clean.substringAfterLast('.', "").lowercase()
    val storeMime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, clean)
        put(MediaStore.Downloads.MIME_TYPE, storeMime)
        put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("MediaStore insert failed")
    try {
        contentResolver.openOutputStream(uri)!!.use { out -> input.copyTo(out) }
    } catch (e: Exception) {
        contentResolver.delete(uri, null, null)
        throw e
    }
    values.clear()
    values.put(MediaStore.Downloads.IS_PENDING, 0)
    contentResolver.update(uri, values, null, null)
    return uri
}

fun Activity.showSaved(anchor: View, uri: Uri, name: String, mime: String?) {
    val type = mime?.takeIf { it.isNotBlank() && it != "application/octet-stream" }
        ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
        ?: "*/*"
    Snackbar.make(anchor, getString(R.string.saved, name), Snackbar.LENGTH_LONG)
        .setAction(R.string.open) {
            val i = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            try {
                startActivity(Intent.createChooser(i, name))
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(this, R.string.no_app, Toast.LENGTH_SHORT).show()
            }
        }
        .show()
}

fun Context.openExternal(url: String) {
    try {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(this, R.string.no_browser, Toast.LENGTH_SHORT).show()
    }
}
