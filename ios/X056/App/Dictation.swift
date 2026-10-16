import AVFoundation
import Speech

/// Speech to text for the Bot's input: on the device when it can be, with the
/// microphone's level for the orb and the waveform.
@MainActor @Observable
final class Dictation {
    enum State: Equatable { case idle, starting, listening, unavailable(String) }

    private(set) var state: State = .idle
    /// What was heard so far, refined as it goes.
    private(set) var transcript = ""
    /// The microphone's loudness, 0-1, smoothed for drawing.
    private(set) var level: Double = 0
    /// The last few levels, newest last, for a waveform.
    private(set) var levels: [Double] = Array(repeating: 0, count: 28)

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?

    var isListening: Bool { state == .listening || state == .starting }

    func toggle() async {
        if isListening { stop() } else { await start() }
    }

    func start() async {
        guard !isListening else { return }
        state = .starting
        transcript = ""
        guard await Self.speechAllowed() else {
            state = .unavailable("Speech recognition is off for x056. Turn it on in Settings.")
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            state = .unavailable("The microphone is off for x056. Turn it on in Settings.")
            return
        }
        // The device's own language first; Indonesian and English both work.
        guard let recognizer = SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable else {
            state = .unavailable("Speech recognition is not available right now.")
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
            self.request = request

            let input = engine.inputNode
            Self.tap(input, format: input.outputFormat(forBus: 0), into: request) { [weak self] value in
                Task { @MainActor in self?.hear(value) }
            }
            engine.prepare()
            try engine.start()
            task = Self.recognize(recognizer, request) { [weak self] text, done in
                Task { @MainActor in self?.heard(text, done: done) }
            }
            state = .listening
        } catch {
            stop()
            state = .unavailable("The microphone could not start: \(error.localizedDescription)")
        }
    }

    func stop() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        request = nil
        task?.finish()
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if isListening { state = .idle }
        level = 0
        levels = Array(repeating: 0, count: levels.count)
    }

    private func hear(_ value: Float) {
        // Quick to rise, slower to fall, so it reads as a voice, not noise.
        let v = min(1, Double(value) * 9)
        level = v > level ? v : level * 0.82 + v * 0.18
        levels.removeFirst()
        levels.append(level)
    }

    private func heard(_ text: String?, done: Bool) {
        if let text, !text.isEmpty { transcript = text }
        if done { stop() }
    }

    // MARK: off the main actor

    /// Audio arrives on the audio thread: this closure must not be main-actor
    /// isolated, or Swift 6 traps when the system calls it.
    private nonisolated static func tap(_ input: AVAudioInputNode, format: AVAudioFormat, into request: SFSpeechAudioBufferRecognitionRequest,
                                        level: @escaping @Sendable (Float) -> Void) {
        nonisolated(unsafe) let request = request
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            level(rms(buffer))
        }
    }

    private nonisolated static func recognize(_ recognizer: SFSpeechRecognizer, _ request: SFSpeechAudioBufferRecognitionRequest,
                                              result: @escaping @Sendable (String?, Bool) -> Void) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { r, error in
            result(r?.bestTranscription.formattedString, error != nil || r?.isFinal == true)
        }
    }

    private nonisolated static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
        return (sum / Float(buffer.frameLength)).squareRoot()
    }

    private nonisolated static func speechAllowed() async -> Bool {
        await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
    }
}
