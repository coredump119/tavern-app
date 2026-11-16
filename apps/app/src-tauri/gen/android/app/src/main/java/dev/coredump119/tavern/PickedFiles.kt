package dev.coredump119.tavern

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream

/**
 * The system picker hands files over as `content://` addresses: no path Rust could open, and no
 * file name in the address. Rust calls [copyTo] over JNI to get a plain file it can read.
 */
object PickedFiles {
  /** Copies the picked file into [dir] under its display name and returns the copy's path. */
  @JvmStatic
  fun copyTo(context: Context, uri: String, dir: String): String {
    val source = Uri.parse(uri)
    val dest = File(dir, fileName(context, source))
    val input = context.contentResolver.openInputStream(source) ?: throw FileNotFoundException(uri)
    input.use { from -> FileOutputStream(dest).use { to -> from.copyTo(to) } }
    return dest.absolutePath
  }

  /** The name the picker showed, with an extension from the MIME type when the name has none. */
  private fun fileName(context: Context, uri: Uri): String {
    val shown = displayName(context, uri) ?: uri.lastPathSegment ?: ""
    val name = shown.substringAfterLast('/').substringAfterLast('\\').trim()
    val safe = if (name.isEmpty() || name == "." || name == "..") "file" else name
    if (safe.contains('.')) return safe
    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(context.contentResolver.getType(uri))
    return if (ext.isNullOrEmpty()) safe else "$safe.$ext"
  }

  private fun displayName(context: Context, uri: Uri): String? =
    context.contentResolver
      .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { row -> if (row.moveToFirst() && !row.isNull(0)) row.getString(0) else null }
}
