// iOS background grace period — see the crate's lib.rs for the why.
//
// On didEnterBackground, ask iOS for extended execution (~30 s) so live SSH
// sockets and pending OTP handshakes survive a quick switch to another app
// (reading a 2FA code). On willEnterForeground (or expiry) the task ends.
// beginBackgroundTask needs no entitlement and no UIBackgroundModes key.

import Foundation
import Tauri
import UIKit
import WebKit

class BgGracePlugin: Plugin {
  private var bgTask: UIBackgroundTaskIdentifier = .invalid

  @objc public override func load(webview: WKWebView) {
    let center = NotificationCenter.default
    center.addObserver(
      self,
      selector: #selector(self.onDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification,
      object: nil
    )
    center.addObserver(
      self,
      selector: #selector(self.onWillEnterForeground),
      name: UIApplication.willEnterForegroundNotification,
      object: nil
    )
  }

  @objc private func onDidEnterBackground() {
    endTask() // never stack two tasks
    bgTask = UIApplication.shared.beginBackgroundTask(withName: "catgo-ssh-grace") {
      // Expiration handler: iOS is about to suspend us for real — release the
      // task promptly or the app gets killed instead of suspended.
      self.endTask()
    }
  }

  @objc private func onWillEnterForeground() {
    endTask()
  }

  private func endTask() {
    if bgTask != .invalid {
      UIApplication.shared.endBackgroundTask(bgTask)
      bgTask = .invalid
    }
  }
}

@_cdecl("init_plugin_bg_grace")
func initPluginBgGrace() -> Plugin {
  return BgGracePlugin()
}
