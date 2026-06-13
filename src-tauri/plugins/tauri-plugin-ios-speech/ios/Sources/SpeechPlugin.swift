// On-device speech-to-text for the iOS chat input — see the crate's lib.rs.
//
// WebKit (and thus the iOS WKWebView) does not implement the Web Speech API the
// desktop chat uses, so dictation here goes through Apple's Speech framework:
// AVAudioEngine taps the mic, SFSpeechRecognizer transcribes, and partial/final
// transcripts are pushed to the webview as `partial` / `final` events. When the
// device supports it we force on-device recognition, so the audio never leaves
// the phone and it works offline with no API key.

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
  private let audioEngine = AVAudioEngine()
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  // True once the user taps the mic off (deliberate stop) and true once any
  // transcript has been delivered. SFSpeechRecognizer emits a trailing
  // kAFAssistantErrorDomain error (1110 "No speech detected", or a cancellation)
  // as the session tears down — benign noise that arrives AFTER a good result.
  // We use these to suppress that false error instead of surfacing it.
  private var isStopping = false
  private var hasResult = false

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

    // Re-entrancy guard: a second start without a stop would stack taps/tasks.
    stopInternal()
    isStopping = false
    hasResult = false

    let locale = args.locale.map { Locale(identifier: $0) } ?? Locale.current
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
      audioEngine.prepare()
      try audioEngine.start()
    } catch {
      stopInternal()
      invoke.reject("could not start audio: \(error.localizedDescription)")
      return
    }

    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      guard let self = self else { return }
      if let result = result {
        self.hasResult = true
        let text = result.bestTranscription.formattedString
        if result.isFinal {
          self.trigger("final", data: ["text": text])
          self.stopInternal()
        } else {
          self.trigger("partial", data: ["text": text])
        }
      }
      if let error = error {
        // Suppress the benign teardown error (e.g. "No speech detected") that
        // fires when we deliberately stop OR after a transcript already arrived.
        // Only surface an error if recognition genuinely produced nothing.
        if !self.isStopping && !self.hasResult {
          self.trigger("error", data: ["message": error.localizedDescription])
        }
        self.stopInternal()
      }
    }

    invoke.resolve()
  }

  // End the session deliberately (mic button tapped off). Emit whatever the
  // recognizer has so far as the final transcript, then tear down.
  @objc public func stopListening(_ invoke: Invoke) {
    isStopping = true // suppress the trailing "no speech" error on teardown
    request?.endAudio()
    stopInternal()
    invoke.resolve()
  }

  private func stopInternal() {
    if audioEngine.isRunning {
      audioEngine.stop()
      audioEngine.inputNode.removeTap(onBus: 0)
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
