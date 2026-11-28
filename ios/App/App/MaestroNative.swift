import AVFoundation
import Capacitor
import CoreAudioKit
import CoreMIDI
import QuartzCore
import UIKit
import WebKit

enum MaestroAudioSession {
    private static var appliedRecording: Bool?
    private(set) static var isRecording: Bool = false

    static func apply(recording: Bool, force: Bool = false) throws {
        if !force, appliedRecording == recording { return }
        let session = AVAudioSession.sharedInstance()
        if recording {
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.defaultToSpeaker, .allowBluetoothA2DP, .mixWithOthers]
            )
        } else {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        }
        // A short hardware buffer keeps the piano close to the finger.
        // A device that rejects it still keeps the playback category.
        // Only the first activation asks for it. Repeating setActive on a
        // tap blocks the main thread and freezes every button.
        if appliedRecording == nil {
            do {
                try session.setPreferredSampleRate(48_000)
                try session.setPreferredIOBufferDuration(0.005)
            } catch {}
        }
        try session.setActive(true)
        appliedRecording = recording
        isRecording = recording
    }
}

final class NativeMicEngine {
    private let analysisQueue = DispatchQueue(label: "com.rico.maestroai.pitch", qos: .userInteractive)
    private var engine: AVAudioEngine?
    private var rollingBuffer: [Float] = []
    private var lastEmitTime: CFTimeInterval = 0
    private var configObserver: NSObjectProtocol?
    private var active = false
    var isActive: Bool { active }
    var onFrame: ((Double, Double, Double) -> Void)?

    func start(completion: @escaping (Error?) -> Void) {
        let onPermission: (Bool) -> Void = { [weak self] granted in
            guard granted else {
                let error = NSError(
                    domain: "MaestroAudio",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Microphone permission denied"]
                )
                DispatchQueue.main.async {
                    completion(error)
                }
                return
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.stopEngineOnly()
                self.removeConfigObserver()
                self.active = true
                do {
                    try MaestroAudioSession.apply(recording: true, force: true)
                    try self.startAudioEngine()
                    completion(nil)
                } catch {
                    self.active = false
                    self.removeConfigObserver()
                    self.stopEngineOnly()
                    try? MaestroAudioSession.apply(recording: false, force: true)
                    completion(error)
                }
            }
        }

        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: onPermission)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(onPermission)
        }
    }

    func stop() {
        active = false
        removeConfigObserver()
        stopEngineOnly()
        try? MaestroAudioSession.apply(recording: false, force: true)
    }

    private func startAudioEngine() throws {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0 && format.channelCount > 0 else {
            throw NSError(
                domain: "MaestroAudio",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Audio input unavailable"]
            )
        }

        analysisQueue.async { [weak self] in
            self?.rollingBuffer.removeAll(keepingCapacity: true)
            self?.lastEmitTime = 0
        }

        let sampleRate = Double(format.sampleRate)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let frameCount = Int(buffer.frameLength)
            guard frameCount > 0, let channelData = buffer.floatChannelData else { return }
            let channelCount = Int(buffer.format.channelCount)
            var samples = [Float](repeating: 0, count: frameCount)
            if channelCount <= 1 {
                let src = channelData[0]
                for i in 0..<frameCount {
                    samples[i] = src[i]
                }
            } else {
                let scale = 1.0 / Float(channelCount)
                for c in 0..<channelCount {
                    let src = channelData[c]
                    for i in 0..<frameCount {
                        samples[i] += src[i] * scale
                    }
                }
            }
            self.analysisQueue.async { [weak self] in
                self?.processSamples(samples, sampleRate: sampleRate)
            }
        }

        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            guard let self, self.active else { return }
            self.stopEngineOnly()
            self.removeConfigObserver()
            do {
                try MaestroAudioSession.apply(recording: true, force: true)
                try self.startAudioEngine()
            } catch {
                self.active = false
                self.stopEngineOnly()
            }
        }

        self.engine = engine
        engine.prepare()
        try engine.start()
    }

    private func processSamples(_ samples: [Float], sampleRate: Double) {
        rollingBuffer.append(contentsOf: samples)
        if rollingBuffer.count > 4096 {
            rollingBuffer.removeFirst(rollingBuffer.count - 4096)
        }
        guard rollingBuffer.count >= 2048 else { return }
        let now = CACurrentMediaTime()
        guard now - lastEmitTime >= 0.032 else { return }
        lastEmitTime = now
        let (rms, freq, clarity) = analyzePitchYinSwift(samples: rollingBuffer, sampleRate: sampleRate)
        DispatchQueue.main.async { [weak self] in
            guard let self, self.active else { return }
            self.onFrame?(rms, freq, clarity)
        }
    }

    private func stopEngineOnly() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        engine.reset()
        self.engine = nil
    }

    private func removeConfigObserver() {
        if let observer = configObserver {
            NotificationCenter.default.removeObserver(observer)
            configObserver = nil
        }
    }
}

private func analyzePitchYinSwift(samples: [Float], sampleRate: Double) -> (Double, Double, Double) {
    let minFreq = 27.0
    let maxFreq = 4250.0
    let rmsGate = 0.005
    let threshold = 0.18
    let fallback = 0.28

    let count = samples.count
    guard count > 0, sampleRate > 0 else { return (0, 0, 0) }

    var sumSq = 0.0
    for i in 0..<count {
        let s = Double(samples[i])
        sumSq += s * s
    }
    let rms = (sumSq / Double(count)).squareRoot()
    guard rms.isFinite, rms >= rmsGate else {
        return (rms.isFinite ? rms : 0, 0, 0)
    }

    let minLag = max(2, Int(floor(sampleRate / maxFreq)))
    let maxLag = min(count / 2, Int(ceil(sampleRate / minFreq)))
    guard maxLag > minLag + 2 else { return (rms, 0, 0) }

    let windowSize = min(count / 2, count - maxLag)
    guard windowSize > 0 else { return (rms, 0, 0) }

    var diff = [Double](repeating: 0, count: maxLag + 1)
    for tau in 1...maxLag {
        var sum = 0.0
        var j = 0
        while j < windowSize {
            let delta = Double(samples[j]) - Double(samples[j + tau])
            sum += delta * delta
            j += 2
        }
        diff[tau] = sum
    }

    var cmndf = [Double](repeating: 1, count: maxLag + 1)
    var runningSum = 0.0
    for tau in 1...maxLag {
        runningSum += diff[tau]
        cmndf[tau] = runningSum > 0 ? (diff[tau] * Double(tau)) / runningSum : 1
    }

    var bestTau = -1
    var tau = minLag
    while tau <= maxLag {
        if cmndf[tau] < threshold {
            while tau + 1 <= maxLag && cmndf[tau + 1] < cmndf[tau] {
                tau += 1
            }
            bestTau = tau
            break
        }
        tau += 1
    }

    if bestTau == -1 {
        var minTau = minLag
        var minVal = cmndf[minLag]
        if minLag + 1 <= maxLag {
            for t in (minLag + 1)...maxLag {
                if cmndf[t] < minVal {
                    minVal = cmndf[t]
                    minTau = t
                }
            }
        }
        if minVal >= fallback {
            return (rms, 0, 0)
        }
        bestTau = minTau
    }

    let bestVal = cmndf[bestTau]
    var refinedTau = Double(bestTau)
    if bestTau > 0 && bestTau < maxLag {
        let s0 = cmndf[bestTau - 1]
        let s1 = cmndf[bestTau]
        let s2 = cmndf[bestTau + 1]
        let denom = 2 * (s0 - 2 * s1 + s2)
        if abs(denom) > 1e-12 {
            let shift = (s0 - s2) / denom
            if shift >= -1 && shift <= 1 {
                refinedTau = Double(bestTau) + shift
            }
        }
    }

    guard refinedTau > 0 else { return (rms, 0, 0) }
    let freq = sampleRate / refinedTau
    let clarity = max(0, min(1, 1 - bestVal))
    return (rms, freq, clarity)
}

@objc(MaestroAudioPlugin)
public class MaestroAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MaestroAudioPlugin"
    public let jsName = "MaestroAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMic", returnType: CAPPluginReturnPromise)
    ]

    private let micEngine = NativeMicEngine()

    @objc override public func load() {
        super.load()
        micEngine.onFrame = { [weak self] rms, freq, clarity in
            self?.notifyListeners("pitch", data: [
                "rms": rms,
                "freq": freq,
                "clarity": clarity
            ])
        }
    }

    @objc func setSession(_ call: CAPPluginCall) {
        let requested = call.getBool("recording") ?? false
        DispatchQueue.main.async {
            let recording = requested || self.micEngine.isActive
            do {
                try MaestroAudioSession.apply(recording: recording)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func startMic(_ call: CAPPluginCall) {
        micEngine.start { error in
            if let error {
                call.reject(error.localizedDescription)
            } else {
                call.resolve([:])
            }
        }
    }

    @objc func stopMic(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.micEngine.stop()
            call.resolve([:])
        }
    }
}

final class MidiEngine {
    private let queue = DispatchQueue(label: "com.rico.maestroai.midi")
    private var client = MIDIClientRef()
    private var port = MIDIPortRef()
    private var started = false
    private var connected: [Int32: MIDIEndpointRef] = [:]
    var onInputs: (([[String: Any]]) -> Void)?
    var onMessage: (([String: Any]) -> Void)?

    func start() {
        queue.sync {
            if !started {
                started = true
                MIDIClientCreateWithBlock("MaestroAI" as CFString, &client) { [weak self] _ in
                    self?.refresh()
                }
                MIDIInputPortCreateWithBlock(client, "MaestroAIIn" as CFString, &port) { [weak self] packetList, refCon in
                    self?.handle(packetList, refCon: refCon)
                }
            }
            refreshLocked()
        }
    }

    func refresh() {
        queue.async { [weak self] in
            self?.refreshLocked()
        }
    }

    func currentInputs() -> [[String: Any]] {
        (0..<MIDIGetNumberOfSources()).compactMap { index in
            let source = MIDIGetSource(index)
            guard isOnline(source) else { return nil }
            return describe(source)
        }
    }

    private func isOnline(_ endpoint: MIDIEndpointRef) -> Bool {
        var offline: Int32 = 0
        let status = MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyOffline, &offline)
        return !(status == noErr && offline != 0)
    }

    private func refreshLocked() {
        guard port != 0 else { return }
        var live: [Int32: MIDIEndpointRef] = [:]
        let count = MIDIGetNumberOfSources()
        for index in 0..<count {
            let source = MIDIGetSource(index)
            guard isOnline(source) else { continue }
            let unique = uniqueId(source)
            live[unique] = source
            if connected[unique] == nil {
                MIDIPortConnectSource(port, source, UnsafeMutableRawPointer(bitPattern: Int(unique)))
            }
        }
        for (unique, source) in connected where live[unique] == nil {
            MIDIPortDisconnectSource(port, source)
        }
        connected = live
        let inputs = currentInputs()
        DispatchQueue.main.async { [weak self] in
            self?.onInputs?(inputs)
        }
    }

    private func handle(_ packetList: UnsafePointer<MIDIPacketList>, refCon: UnsafeMutableRawPointer?) {
        let sourceId = String(Int32(truncatingIfNeeded: Int(bitPattern: refCon)))
        guard let dataOffset = MemoryLayout<MIDIPacket>.offset(of: \MIDIPacket.data) else { return }
        for packetPtr in packetList.unsafeSequence() {
            let length = Int(packetPtr.pointee.length)
            guard length > 0 else { continue }
            let dataPtr = UnsafeRawPointer(packetPtr).advanced(by: dataOffset)
            let bytes = Array(UnsafeRawBufferPointer(start: dataPtr, count: length))
            for message in splitMidi(bytes) {
                let payload: [String: Any] = [
                    "id": sourceId,
                    "data": message.map { Int($0) }
                ]
                DispatchQueue.main.async { [weak self] in
                    self?.onMessage?(payload)
                }
            }
        }
    }

    private func uniqueId(_ endpoint: MIDIEndpointRef) -> Int32 {
        var unique: Int32 = 0
        MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyUniqueID, &unique)
        if unique == 0 {
            unique = Int32(bitPattern: endpoint)
        }
        return unique
    }

    private func stringProperty(_ endpoint: MIDIEndpointRef, _ key: CFString) -> String? {
        var value: Unmanaged<CFString>?
        let status = MIDIObjectGetStringProperty(endpoint, key, &value)
        guard status == noErr, let value else { return nil }
        let text = (value.takeRetainedValue() as String).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private func describe(_ endpoint: MIDIEndpointRef) -> [String: Any] {
        let name = stringProperty(endpoint, kMIDIPropertyDisplayName)
            ?? stringProperty(endpoint, kMIDIPropertyName)
            ?? "MIDI keyboard"
        let manufacturer = stringProperty(endpoint, kMIDIPropertyManufacturer) ?? "Generic MIDI"
        return [
            "id": String(uniqueId(endpoint)),
            "name": name,
            "manufacturer": manufacturer,
            "state": "connected"
        ]
    }
}

private func midiPayloadLength(for status: UInt8) -> Int {
    switch status & 0xF0 {
    case 0xC0, 0xD0:
        return 1
    default:
        return 2
    }
}

private func splitMidi(_ bytes: [UInt8]) -> [[UInt8]] {
    var messages: [[UInt8]] = []
    var runningStatus: UInt8 = 0
    var index = 0
    while index < bytes.count {
        let byte = bytes[index]
        if byte >= 0xF8 {
            index += 1
            continue
        }
        if byte >= 0xF0 {
            runningStatus = 0
            if byte == 0xF0 {
                var end = index + 1
                while end < bytes.count && bytes[end] != 0xF7 {
                    end += 1
                }
                index = min(bytes.count, end + 1)
                continue
            }
            let size = (byte == 0xF1 || byte == 0xF3) ? 2 : (byte == 0xF2 ? 3 : 1)
            if index + size > bytes.count { break }
            index += size
            continue
        }
        if byte >= 0x80 {
            runningStatus = byte
            let payloadLength = midiPayloadLength(for: byte)
            if index + 1 + payloadLength > bytes.count { break }
            if payloadLength == 1 {
                let d1 = bytes[index + 1]
                if d1 < 0x80 {
                    messages.append([byte, d1])
                    index += 2
                } else {
                    index += 1
                }
            } else {
                let d1 = bytes[index + 1]
                let d2 = bytes[index + 2]
                if d1 < 0x80 && d2 < 0x80 {
                    messages.append([byte, d1, d2])
                    index += 3
                } else {
                    index += 1
                }
            }
            continue
        }
        if runningStatus == 0 {
            index += 1
            continue
        }
        let payloadLength = midiPayloadLength(for: runningStatus)
        if payloadLength == 1 {
            messages.append([runningStatus, byte])
            index += 1
        } else {
            if index + 1 >= bytes.count { break }
            let d2 = bytes[index + 1]
            if d2 >= 0x80 {
                index += 1
                continue
            }
            messages.append([runningStatus, byte, d2])
            index += 2
        }
    }
    return messages
}

@objc(MaestroMidiPlugin)
public class MaestroMidiPlugin: CAPPlugin, CAPBridgedPlugin, UIAdaptivePresentationControllerDelegate {
    public let identifier = "MaestroMidiPlugin"
    public let jsName = "MaestroMidi"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise)
    ]

    private let engine = MidiEngine()

    @objc override public func load() {
        super.load()
        engine.onInputs = { [weak self] inputs in
            self?.notifyListeners("state", data: ["inputs": inputs])
        }
        engine.onMessage = { [weak self] payload in
            self?.notifyListeners("message", data: payload)
        }
    }

    @objc func requestAccess(_ call: CAPPluginCall) {
        let presentBluetooth = call.getBool("presentBluetooth") ?? false
        engine.start()
        call.resolve(["inputs": engine.currentInputs()])
        if presentBluetooth {
            DispatchQueue.main.async { [weak self] in
                self?.presentBluetoothPicker()
            }
        }
    }

    private func presentBluetoothPicker() {
        guard let controller = bridge?.viewController, controller.presentedViewController == nil else { return }
        let browser = CABTMIDICentralViewController()
        browser.navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done,
            target: self,
            action: #selector(dismissBluetoothPicker)
        )
        let navigation = UINavigationController(rootViewController: browser)
        navigation.modalPresentationStyle = .pageSheet
        navigation.presentationController?.delegate = self
        controller.present(navigation, animated: true)
    }

    @objc private func dismissBluetoothPicker() {
        bridge?.viewController?.dismiss(animated: true) { [weak self] in
            self?.engine.refresh()
        }
    }

    @objc public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        engine.refresh()
    }
}

@objc(MaestroAppPlugin)
public class MaestroAppPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MaestroAppPlugin"
    public let jsName = "MaestroApp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setIdleDisabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise)
    ]

    @objc func setIdleDisabled(_ call: CAPPluginCall) {
        let disabled = call.getBool("disabled") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = disabled
            call.resolve()
        }
    }

    @objc func shareFile(_ call: CAPPluginCall) {
        let filename = call.getString("filename") ?? "Maestro.pdf"
        let base64 = call.getString("base64") ?? ""
        guard let data = Data(base64Encoded: base64), !data.isEmpty else {
            call.reject("Nothing to share")
            return
        }
        let safeName = filename.replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safeName)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            call.reject(error.localizedDescription)
            return
        }
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController else {
                call.reject("No view")
                return
            }
            let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let popover = activity.popoverPresentationController {
                popover.sourceView = controller.view
                popover.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
            }
            controller.present(activity, animated: true)
            call.resolve()
        }
    }
}

@objc(MaestroBridgeViewController)
class MaestroBridgeViewController: CAPBridgeViewController {
    private var interruptionObserver: NSObjectProtocol?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MaestroAudioPlugin())
        bridge?.registerPluginInstance(MaestroMidiPlugin())
        bridge?.registerPluginInstance(MaestroAppPlugin())
        observeAudioInterruptions()
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // WKWebsiteDataStore.default() is persistent, so localStorage survives relaunch.
        configuration.websiteDataStore = WKWebsiteDataStore.default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        return configuration
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        configureWebViewChrome()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        configureWebViewChrome()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        publishSafeArea()
    }

    private func configureWebViewChrome() {
        guard let webView else { return }
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = true
        webView.backgroundColor = UIColor(red: 246.0 / 255.0, green: 243.0 / 255.0, blue: 236.0 / 255.0, alpha: 1)
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
    }

    private func observeAudioInterruptions() {
        if interruptionObserver != nil { return }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let type = raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            guard type == .ended else { return }
            try? MaestroAudioSession.apply(recording: MaestroAudioSession.isRecording, force: true)
            self?.webView?.evaluateJavaScript("window.__maestroResumeAudio && window.__maestroResumeAudio()", completionHandler: nil)
        }
    }

    private func publishSafeArea() {
        let insets = view.safeAreaInsets
        let script = """
        (function(){
          var root = document.documentElement;
          if (!root) return;
          root.style.setProperty('--maestro-safe-top', '\(insets.top)px');
          root.style.setProperty('--maestro-safe-right', '\(insets.right)px');
          root.style.setProperty('--maestro-safe-bottom', '\(insets.bottom)px');
          root.style.setProperty('--maestro-safe-left', '\(insets.left)px');
        })();
        """
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }
}
