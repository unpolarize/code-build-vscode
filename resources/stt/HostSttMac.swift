// Host-side continuous speech-to-text for Code Build (macOS).
// Uses Apple Speech framework (on-device when available) so mic access goes
// through the VS Code / Cursor process — not the sandboxed webview iframe.
//
// Protocol (NDJSON on stdout, one object per line):
//   {"type":"status","status":"listening"|"idle"|"error"|"unsupported","detail":"..."}
//   {"type":"result","transcript":"...","isFinal":true|false}
//
// Control (stdin lines):
//   STOP  — end session
//   PING  — ignore (keepalive)

import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
        let line = String(data: data, encoding: .utf8)
  else { return }
  fputs(line + "\n", stdout)
  fflush(stdout)
}

func fail(_ detail: String, code: Int32 = 1) -> Never {
  emit(["type": "status", "status": "error", "detail": detail])
  exit(code)
}

let args = CommandLine.arguments
var localeId = "en-US"
if let idx = args.firstIndex(of: "--lang"), idx + 1 < args.count {
  localeId = args[idx + 1]
}

let auth = SFSpeechRecognizer.authorizationStatus()
if auth == .denied || auth == .restricted {
  fail(
    "Speech recognition denied for this app. Enable it in System Settings → Privacy & Security → Speech Recognition (and Microphone) for VS Code / Cursor.",
    code: 2
  )
}

let authGroup = DispatchGroup()
if auth == .notDetermined {
  authGroup.enter()
  SFSpeechRecognizer.requestAuthorization { status in
    if status != .authorized {
      emit([
        "type": "status",
        "status": "error",
        "detail":
          "Speech recognition not authorized (status \(status.rawValue)). Allow Speech Recognition + Microphone for VS Code / Cursor in System Settings."
      ])
      exit(2)
    }
    authGroup.leave()
  }
  _ = authGroup.wait(timeout: .now() + 30)
}

guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
  fail("Speech recognition not authorized.")
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
  fail("No speech recognizer for locale \(localeId)", code: 3)
}
guard recognizer.isAvailable else {
  fail("Speech recognizer unavailable for locale \(localeId)", code: 3)
}

// Prefer on-device when the engine supports it (no network).
if recognizer.supportsOnDeviceRecognition {
  // property is read-only on request; set on the request below
}

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
if format.sampleRate == 0 || format.channelCount == 0 {
  fail(
    "No microphone input format (sampleRate=\(format.sampleRate)). Check Microphone permission for VS Code / Cursor.",
    code: 4
  )
}

var request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
if #available(macOS 13.0, *) {
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }
}
if #available(macOS 14.0, *) {
  request.addsPunctuation = true
}

var task: SFSpeechRecognitionTask?
var stopping = false
let lock = NSLock()

func restartRecognition() {
  lock.lock()
  defer { lock.unlock() }
  if stopping { return }
  task?.cancel()
  task = nil
  request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  if #available(macOS 13.0, *) {
    if recognizer.supportsOnDeviceRecognition {
      request.requiresOnDeviceRecognition = true
    }
  }
  if #available(macOS 14.0, *) {
    request.addsPunctuation = true
  }
  task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      let text = result.bestTranscription.formattedString
      if !text.isEmpty {
        emit([
          "type": "result",
          "transcript": text,
          "isFinal": result.isFinal
        ])
      }
      if result.isFinal {
        // Continuous mode: start a new task after a final result.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
          restartRecognition()
        }
      }
    }
    if let error = error {
      let ns = error as NSError
      // Cancellation is expected on stop / restart.
      if ns.domain == "kAFAssistantErrorDomain" && ns.code == 216 { return }
      if ns.domain == NSURLErrorDomain { return }
      lock.lock()
      let done = stopping
      lock.unlock()
      if done { return }
      // 1110 = no speech; benign in continuous mode
      if ns.domain == "kAFAssistantErrorDomain" && (ns.code == 1110 || ns.code == 203) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
          restartRecognition()
        }
        return
      }
      emit([
        "type": "status",
        "status": "error",
        "detail": "Speech error: \(error.localizedDescription) (\(ns.domain)/\(ns.code))"
      ])
    }
  }
}

input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
  request.append(buffer)
}

do {
  engine.prepare()
  try engine.start()
} catch {
  fail("Failed to start audio engine: \(error.localizedDescription)", code: 5)
}

restartRecognition()
emit(["type": "status", "status": "listening", "detail": "host-stt macOS locale=\(localeId)"])

// stdin control loop on a background queue
DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine() {
    let cmd = line.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    if cmd == "STOP" || cmd == "QUIT" || cmd == "EXIT" {
      lock.lock()
      stopping = true
      lock.unlock()
      request.endAudio()
      task?.cancel()
      engine.stop()
      input.removeTap(onBus: 0)
      emit(["type": "status", "status": "idle"])
      exit(0)
    }
  }
  // EOF on stdin → stop
  lock.lock()
  stopping = true
  lock.unlock()
  request.endAudio()
  task?.cancel()
  engine.stop()
  input.removeTap(onBus: 0)
  emit(["type": "status", "status": "idle"])
  exit(0)
}

RunLoop.main.run()
