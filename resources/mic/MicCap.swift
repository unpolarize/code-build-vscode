// Mic capture helper for Code Build voice — a headless port of Quill's
// Recorder.swift (xfreeze2/quill, MIT). Emits 16 kHz mono PCM16 on stdout,
// diagnostics on stderr, and exits when stdin closes or on SIGTERM/SIGINT.
//
// Spawned by the VS Code extension host. macOS attributes the microphone TCC
// grant of a child process to the responsible process (VS Code), whose
// Info.plist carries NSMicrophoneUsageDescription — so no extra permission
// dance beyond the one VS Code itself already did.

import AVFoundation
import Foundation

func warn(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

let engine = AVAudioEngine()
let input = engine.inputNode
let inputFormat = input.inputFormat(forBus: 0)

guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
    warn("miccap: no usable input device")
    exit(2)
}

let target = AVAudioFormat(commonFormat: .pcmFormatInt16,
                           sampleRate: 16_000,
                           channels: 1,
                           interleaved: true)!

guard let converter = AVAudioConverter(from: inputFormat, to: target) else {
    warn("miccap: cannot convert \(inputFormat.sampleRate)Hz x\(inputFormat.channelCount) to 16kHz mono")
    exit(3)
}

let out = FileHandle.standardOutput
var framesCaptured = 0
var peak: Float = 0
var lastReport = Date()

input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
    framesCaptured += Int(buffer.frameLength)
    if let ch = buffer.floatChannelData {
        var p: Float = 0
        for i in 0..<Int(buffer.frameLength) { p = max(p, abs(ch[0][i])) }
        peak = max(peak, p)
    }

    let ratio = target.sampleRate / inputFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 16)
    guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var err: NSError?
    var fed = false
    converter.convert(to: converted, error: &err) { _, status in
        if fed { status.pointee = .noDataNow; return nil }
        fed = true
        status.pointee = .haveData
        return buffer
    }
    guard err == nil, converted.frameLength > 0, let ch16 = converted.int16ChannelData else { return }
    out.write(Data(bytes: ch16[0], count: Int(converted.frameLength) * 2))

    // Once a second: enough to say WHY nothing was heard instead of guessing.
    if Date().timeIntervalSince(lastReport) >= 1.0 {
        warn(String(format: "miccap: frames=%d peak=%.3f rate=%.0f", framesCaptured, peak, inputFormat.sampleRate))
        lastReport = Date()
        peak = 0
    }
}

do {
    try engine.start()
    warn("miccap: recording @ \(Int(inputFormat.sampleRate))Hz x\(inputFormat.channelCount)")
} catch {
    warn("miccap: engine start failed: \(error.localizedDescription)")
    exit(4)
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
signal(SIGPIPE) { _ in exit(0) }

// Exit when the parent closes our stdin (or dies).
FileHandle.standardInput.readabilityHandler = { h in
    if h.availableData.isEmpty {
        engine.stop()
        exit(0)
    }
}

RunLoop.main.run()
