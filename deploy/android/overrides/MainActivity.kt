package com.catgo.app

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// CANONICAL copy. `tauri android init` regenerates src-tauri/gen/android/ from
// stock templates and overwrites MainActivity.kt with a bare
// `class MainActivity : TauriActivity()`, DROPPING the inset handling below.
// `deploy/android/apply-native-patches.sh` copies this file back into the
// generated project after every init (run by .github/workflows/android-build.yml
// and documented for local builds in deploy/android/README.md). Edit THIS file,
// not the generated one — the generated one is gitignored and ephemeral.
//
// NOTE on camera: do NOT call requestPermissions() here. wry's
// RustWebChromeClient.onPermissionRequest already requests + grants the CAMERA
// permission when the page calls getUserMedia() (gesture mode); requesting it
// ourselves too makes the result get delivered to wry's handler as well, which
// then calls grant()/deny() twice and crashes ("Either grant() or deny() has
// been already called"). The manifest CAMERA permission is all that's needed.
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // `windowSoftInputMode="adjustResize"` (manifest) is the official Tauri fix
    // for the soft keyboard (tauri-apps/tauri PR #13277), but `enableEdgeToEdge()`
    // calls `setDecorFitsSystemWindows(false)`, so the window no longer resizes
    // for the IME — the keyboard is drawn OVER the WebView and covers the
    // terminal's input line (tauri-apps/tauri #7868 / #10631). Consume the IME
    // inset (or the nav-bar inset when the keyboard is hidden) as bottom padding
    // on the content view so the WebView shrinks above the keyboard;
    // `visualViewport` then updates and MobileTerminal re-fits xterm above it.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      // Pad TOP by the status bar (so the app header is not drawn under the
      // clock/battery) and BOTTOM by the larger of the IME or nav-bar inset (so
      // the keyboard does not cover the terminal keybar / chat composer). This
      // native padding is what actually keeps the keyboard from covering content
      // on this WebView (its window.visualViewport does NOT shrink for the IME).
      // The frontend must NOT also shrink to visualViewport or it double-counts
      // and leaves a black gap.
      v.setPadding(0, bars.top, 0, maxOf(ime, bars.bottom))
      insets
    }
  }
}
