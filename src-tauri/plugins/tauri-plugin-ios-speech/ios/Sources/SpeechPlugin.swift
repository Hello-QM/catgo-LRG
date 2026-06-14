// On-device speech-to-text for the iOS chat input — see the crate's lib.rs.
//
// WebKit (and thus the iOS WKWebView) does not implement the Web Speech API the
// desktop chat uses, so dictation here goes through Apple's Speech framework:
// AVAudioEngine taps the mic, SFSpeechRecognizer transcribes, and partial/final
// transcripts are pushed to the webview as `partial` / `final` events. When the
// device supports it we force on-device recognition, so the audio never leaves
// the phone and it works offline with no API key.
//
// THREADING: every AVAudioEngine / AVAudioSession / recognizer mutation runs on
// a single serial background queue. This is load-bearing, not cosmetic:
//   - AVAudioEngine.stop() and AVAudioSession.setActive(false,
//     .notifyOthersOnDeactivation) can BLOCK. Running them on the main thread
//     freezes the whole WKWebView (it renders on main) — which is exactly what
//     happened when minimizing the chat tore the session down on the main thread.
//   - teardown() is reachable from three places (the recognition callback's own
//     thread, stopListening, and a fresh startListening). Serializing them on one
//     queue prevents a concurrent engine.stop()/removeTap race/deadlock.
// Commands resolve immediately; the audio work hops onto `queue` and never makes
// the JS caller (or the main thread) wait.

import AVFoundation
import Foundation
import Speech
import Tauri
import UIKit
import WebKit

struct StartArgs: Decodable {
  // BCP-47 locale, e.g. "en-US". nil → the device's current locale.
  let locale: String?
}

class SpeechPlugin: Plugin {
  private let queue = DispatchQueue(label: "com.catgo.ios-speech")
  private let audioEngine = AVAudioEngine()
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  // True once the user taps the mic off (deliberate stop) and true once any
  // transcript has been delivered. SFSpeechRecognizer emits a trailing
  // kAFAssistantErrorDomain error (1110 "No speech detected", or a cancellation)
  // as the session tears down — benign noise that arrives AFTER a good result.
  // We use these to suppress that false error instead of surfacing it. Only
  // touched on `queue`.
  private var isStopping = false
  private var hasResult = false
  // Tracks whether the input-node tap is installed. We can't key teardown's
  // removeTap on audioEngine.isRunning: if audioEngine.start() throws AFTER
  // installTap, the engine isn't running but the tap IS installed — and a second
  // installTap on the same bus throws an uncatchable NSException ("already has a
  // tap installed"), crashing the app on the next start. Only touched on `queue`.
  private var isTapInstalled = false

  // BCP-47 identifiers this device can actually recognize, so the JS picker
  // never offers a locale that would fail at start (accents = en-GB/en-IN/…,
  // Chinese = zh-CN/zh-TW/zh-HK, etc.). Order is Apple's; JS sorts/labels.
  @objc public func supportedLocales(_ invoke: Invoke) {
    let ids = SFSpeechRecognizer.supportedLocales().map { $0.identifier }
    invoke.resolve(["locales": ids])
  }

  // Request BOTH permissions the Speech framework needs. Mic and speech are
  // separate authorizations on iOS; dictation only works when both are granted.
  @objc public func requestPermission(_ invoke: Invoke) {
    SFSpeechRecognizer.requestAuthorization { speechStatus in
      let speechOK = speechStatus == .authorized
      AVAudioSession.sharedInstance().requestRecordPermission { micOK in
        invoke.resolve(["granted": speechOK && micOK])
      }
    }
  }

  @objc public func startListening(_ invoke: Invoke) {
    let args: StartArgs
    do {
      args = try invoke.parseArgs(StartArgs.self)
    } catch {
      invoke.reject("bad arguments: \(error.localizedDescription)")
      return
    }
    queue.async { [weak self] in
      self?.startInternal(localeId: args.locale, invoke: invoke)
    }
  }

  // End the session deliberately (mic button tapped off / chat unmounted). The
  // teardown is async on `queue`, so the JS caller and main thread never wait.
  @objc public func stopListening(_ invoke: Invoke) {
    queue.async { [weak self] in
      guard let self = self else { return }
      self.isStopping = true
      self.request?.endAudio()
      self.teardown()
    }
    invoke.resolve()
  }

  // MUST run on `queue`.
  private func startInternal(localeId: String?, invoke: Invoke) {
    teardown() // re-entrancy guard (serial queue makes this safe)
    isStopping = false
    hasResult = false

    let locale = localeId.map { Locale(identifier: $0) } ?? Locale.current
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
      invoke.reject("speech recognition unavailable for locale \(locale.identifier)")
      return
    }
    self.recognizer = recognizer

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    // Privacy/offline: keep audio on-device when the model is present. Cloud
    // recognition (the fallback) would ship audio to Apple and need network.
    if recognizer.supportsOnDeviceRecognition {
      request.requiresOnDeviceRecognition = true
    }
    self.request = request

    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: .duckOthers)
      try session.setActive(true, options: .notifyOthersOnDeactivation)

      let inputNode = audioEngine.inputNode
      let format = inputNode.outputFormat(forBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        self?.request?.append(buffer)
      }
      isTapInstalled = true
      audioEngine.prepare()
      try audioEngine.start()
    } catch {
      teardown()
      invoke.reject("could not start audio: \(error.localizedDescription)")
      return
    }

    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      guard let self = self else { return }
      // The callback runs on SFSpeech's own thread; hop to `queue` so reading
      // results and tearing down can't race startListening/stopListening.
      if let result = result {
        let text = result.bestTranscription.formattedString
        let isFinal = result.isFinal
        self.queue.async {
          self.hasResult = true
          if isFinal {
            self.trigger("final", data: ["text": text])
            self.teardown()
          } else {
            self.trigger("partial", data: ["text": text])
          }
        }
      }
      if let error = error {
        let message = error.localizedDescription
        self.queue.async {
          // Suppress the benign teardown error (e.g. "No speech detected") that
          // fires on a deliberate stop or after a transcript already arrived.
          if !self.isStopping && !self.hasResult {
            self.trigger("error", data: ["message": message])
          }
          self.teardown()
        }
      }
    }

    invoke.resolve()
  }

  // Stop the engine, cancel the task, release the session. MUST run on `queue`;
  // idempotent. Runs off the main thread so a blocking stop/deactivate can never
  // freeze the WebView.
  private func teardown() {
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    // Remove the tap based on whether it was installed, NOT on isRunning — a
    // failed start() leaves the engine stopped but the tap installed (see M1).
    if isTapInstalled {
      audioEngine.inputNode.removeTap(onBus: 0)
      isTapInstalled = false
    }
    task?.cancel()
    request = nil
    task = nil
    recognizer = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

@_cdecl("init_plugin_ios_speech")
func initPluginIosSpeech() -> Plugin {
  return SpeechPlugin()
}
