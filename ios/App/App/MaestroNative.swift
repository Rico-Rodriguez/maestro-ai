import AVFoundation
import Capacitor
import CoreAudioKit
import CoreMIDI
import UIKit
import WebKit

enum MaestroAudioSession {
    private static var appliedRecording: Bool?

    static func apply(recording: Bool, force: Bool = false) throws {
        if !force, appliedRecording == recording { return }
        let session = AVAudioSession.sharedInstance()
        if recording {
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.defaultToSpeaker, .allowBluetoothA2DP]
            )
        } else {
            try session.setCategory(.playback, mode: .default, options: [])
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
    }
}

@objc(MaestroAudioPlugin)
public class MaestroAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MaestroAudioPlugin"
    public let jsName = "MaestroAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSession", returnType: CAPPluginReturnPromise)
    ]

    @objc func setSession(_ call: CAPPluginCall) {
        let recording = call.getBool("recording") ?? false
        DispatchQueue.main.async {
            do {
                try MaestroAudioSession.apply(recording: recording)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
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

    private func refresh() {
        queue.async { [weak self] in
            self?.refreshLocked()
        }
    }

    func currentInputs() -> [[String: Any]] {
        (0..<MIDIGetNumberOfSources()).map { index in
            describe(MIDIGetSource(index))
        }
    }

    private func refreshLocked() {
        guard port != 0 else { return }
        var live: [Int32: MIDIEndpointRef] = [:]
        let count = MIDIGetNumberOfSources()
        for index in 0..<count {
            let source = MIDIGetSource(index)
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
        var packet = packetList.pointee.packet
        for _ in 0..<packetList.pointee.numPackets {
            let bytes = midiBytes(packet)
            for message in splitMidi(bytes) {
                let payload: [String: Any] = [
                    "id": sourceId,
                    "data": message.map { Int($0) }
                ]
                DispatchQueue.main.async { [weak self] in
                    self?.onMessage?(payload)
                }
            }
            packet = MIDIPacketNext(&packet).pointee
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

    private func stringProperty(_ endpoint: MIDIEndpointRef, _ key: CFString, fallback: String) -> String {
        var value: Unmanaged<CFString>?
        let status = MIDIObjectGetStringProperty(endpoint, key, &value)
        guard status == noErr, let value = value else { return fallback }
        return value.takeRetainedValue() as String
    }

    private func describe(_ endpoint: MIDIEndpointRef) -> [String: Any] {
        [
            "id": String(uniqueId(endpoint)),
            "name": stringProperty(endpoint, kMIDIPropertyDisplayName, fallback: "MIDI keyboard"),
            "manufacturer": stringProperty(endpoint, kMIDIPropertyManufacturer, fallback: "Generic MIDI"),
            "state": "connected"
        ]
    }
}

private func midiBytes(_ packet: MIDIPacket) -> [UInt8] {
    let length = Int(packet.length)
    guard length > 0 else { return [] }
    return withUnsafeBytes(of: packet.data) { raw in
        Array(raw.prefix(length))
    }
}

private func splitMidi(_ bytes: [UInt8]) -> [[UInt8]] {
    var messages: [[UInt8]] = []
    var index = 0
    while index < bytes.count {
        let status = bytes[index]
        if status < 0x80 {
            index += 1
            continue
        }
        if status == 0xF0 {
            var end = index + 1
            while end < bytes.count && bytes[end] != 0xF7 {
                end += 1
            }
            index = min(bytes.count, end + 1)
            continue
        }
        let size: Int
        switch status & 0xF0 {
        case 0xC0, 0xD0:
            size = 2
        case 0xF0:
            size = 1
        default:
            size = 3
        }
        if index + size > bytes.count { break }
        messages.append(Array(bytes[index..<(index + size)]))
        index += size
    }
    return messages
}

@objc(MaestroMidiPlugin)
public class MaestroMidiPlugin: CAPPlugin, CAPBridgedPlugin {
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
        let navigation = UINavigationController(rootViewController: browser)
        navigation.modalPresentationStyle = .pageSheet
        controller.present(navigation, animated: true)
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
            try? MaestroAudioSession.apply(recording: false, force: true)
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
