package dev.coredump119.tavern

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/**
 * Edge-to-edge is mandatory on Android 15+, but Chromium's WebView only exposes the display
 * cutout through CSS env(safe-area-inset-*). We forward system bars + keyboard insets to the
 * page (CSS px) via `window.__TM_ANDROID_INSETS.get()` and a `tm-insets` event; the web side
 * writes them into the --tm-safe-* tokens (apps/app/src/lib/insets.ts, DESIGN.md §2.5).
 */
class MainActivity : TauriActivity() {
  companion object {
    private const val REQUEST_NOTIFICATIONS = 1001
  }

  private var webView: WebView? = null
  @Volatile private var current: Insets = Insets.NONE

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      current = Insets.of(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      pushInsets()
      insets
    }
    requestNotificationPermission()
  }

  /**
   * Android 13+ gates notifications behind a runtime permission. GenerationService (started
   * from Rust while a reply streams) is a dataSync foreground service: it keeps running without
   * the permission, but its "正在生成回复…" notification only shows once this is granted.
   */
  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val perm = Manifest.permission.POST_NOTIFICATIONS
    if (ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED) return
    ActivityCompat.requestPermissions(this, arrayOf(perm), REQUEST_NOTIFICATIONS)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(InsetsBridge(), "__TM_ANDROID_INSETS")
  }

  private fun insetsJson(): String {
    val d = resources.displayMetrics.density
    return JSONObject()
      .put("top", current.top / d)
      .put("right", current.right / d)
      .put("bottom", current.bottom / d)
      .put("left", current.left / d)
      .toString()
  }

  private fun pushInsets() {
    val wv = webView ?: return
    val json = insetsJson()
    wv.post {
      wv.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('tm-insets',{detail:$json}))", null
      )
    }
  }

  inner class InsetsBridge {
    @JavascriptInterface
    fun get(): String = insetsJson()
  }
}
