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

struct SetIdleArgs: Decodable {
  // true => keep the screen awake (UIApplication.isIdleTimerDisabled = true).
  let disabled: Bool
}

class BgGracePlugin: Plugin {
  private var bgTask: UIBackgroundTaskIdentifier = .invalid

  // Keep the screen awake while the user is in the terminal, so an auto-lock
  // can't background the app and drop the SSH connection. isIdleTimerDisabled is
  // a UIApplication property and must be set on the main thread.
  @objc public func setIdleTimer(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(SetIdleArgs.self)
      DispatchQueue.main.async {
        UIApplication.shared.isIdleTimerDisabled = args.disabled
      }
      invoke.resolve()
    } catch {
      invoke.reject("bad arguments: \(error.localizedDescription)")
    }
  }

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
