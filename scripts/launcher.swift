import Cocoa
import Foundation

final class Launcher: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let status = NSTextField(labelWithString: "Checking server…")
    var stopButton: NSButton!
    var copyButton: NSButton!
    var child: Process?
    var timer: Timer?
    var log: FileHandle?
    var stopping = false
    var stopped = false
    var checking = false
    var networkTimer: Timer?
    var networkChecking = false
    let phoneStatus = NSTextField(labelWithString: "Phone: checking…")
    let phoneLink = NSTextField(labelWithString: "")
    // Finder supplies no project argument; the app bundle lives beside the source.
    let root = CommandLine.arguments.count > 1
        ? URL(fileURLWithPath: CommandLine.arguments[1])
        : Bundle.main.bundleURL.deletingLastPathComponent()
    var env = ProcessInfo.processInfo.environment
    var address: String { "http://127.0.0.1:\(env["HARNESS_PORT"] ?? "8787")" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")

        if let config = try? String(contentsOf: root.appendingPathComponent(".orchestrator-node.env"), encoding: .utf8) {
            for line in config.components(separatedBy: .newlines) {
                if line.trimmingCharacters(in: .whitespaces).hasPrefix("#") { continue }
                let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
                if parts.count == 2 && env[parts[0]] == nil {
                    env[parts[0]] = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
                }
            }
        }
        buildWindow()
        refreshConnections()
        networkTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: true) { _ in self.refreshConnections() }
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        check { found in
            if self.stopping || self.stopped { return }
            if found {
                self.status.stringValue = "Active — closing this window stops the server"
            } else { self.start() }
        }
    }

    // One vertical layout owns spacing; status changes never move controls into
    // neighbouring rows. Semantic AppKit colours follow the forced dark theme.
    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 480),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Distributed Orchestrator"
        window.delegate = self
        window.appearance = NSAppearance(named: .darkAqua)
        let content = window.contentView!
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
        ])
        func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular) -> NSTextField {
            let field = NSTextField(wrappingLabelWithString: text)
            field.font = .systemFont(ofSize: size, weight: weight)
            field.textColor = .secondaryLabelColor
            return field
        }
        func add(_ view: NSView) {
            stack.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        func button(_ title: String, action: Selector) -> NSButton {
            let control = NSButton(title: title, target: self, action: action)
            control.bezelStyle = .rounded
            control.controlSize = .large
            control.heightAnchor.constraint(equalToConstant: 44).isActive = true
            return control
        }
        let title = label("Distributed Orchestrator", size: 22, weight: .semibold)
        title.textColor = .labelColor
        add(title)
        add(label("Your workspace, on this computer and your phone."))
        stack.setCustomSpacing(24, after: stack.arrangedSubviews.last!)
        add(label("THIS COMPUTER", size: 11, weight: .semibold))
        status.font = .systemFont(ofSize: 13, weight: .medium)
        status.cell?.wraps = true
        status.cell?.isScrollable = false
        status.maximumNumberOfLines = 2
        status.heightAnchor.constraint(equalToConstant: 34).isActive = true
        add(status)
        let local = label(address)
        local.isSelectable = true
        add(local)
        let open = button("Open workspace", action: #selector(openBrowser))
        add(open)
        stack.setCustomSpacing(24, after: open)
        add(label("PHONE & OTHER DEVICES", size: 11, weight: .semibold))
        phoneStatus.font = .systemFont(ofSize: 12)
        phoneStatus.textColor = .secondaryLabelColor
        phoneStatus.cell?.wraps = true
        phoneStatus.cell?.isScrollable = false
        phoneStatus.maximumNumberOfLines = 3
        phoneStatus.heightAnchor.constraint(equalToConstant: 48).isActive = true
        add(phoneStatus)
        phoneLink.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        phoneLink.isSelectable = true
        phoneLink.cell?.wraps = true
        phoneLink.cell?.isScrollable = false
        phoneLink.lineBreakMode = .byCharWrapping
        phoneLink.maximumNumberOfLines = 2
        phoneLink.heightAnchor.constraint(equalToConstant: 34).isActive = true
        add(phoneLink)
        copyButton = button("Copy phone link", action: #selector(copyPhone))
        copyButton.isEnabled = false
        stopButton = button("Stop server", action: #selector(stop))
        let actions = NSStackView(views: [copyButton, stopButton])
        actions.orientation = .horizontal
        actions.distribution = .fillEqually
        actions.spacing = 12
        add(actions)
        add(label("Keep this computer awake. Closing this window stops its server.", size: 11))
        content.layoutSubtreeIfNeeded()
        // Size to the arranged content instead of maintaining a second set of
        // hand-positioned heights when labels or system font metrics change.
        window.setContentSize(NSSize(width: 560, height: stack.fittingSize.height + 48))
    }

    @objc func copyPhone() {
        if phoneLink.stringValue.hasPrefix("https://") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(phoneLink.stringValue, forType: .string)
        }
    }
    func refreshConnections() {
        if networkChecking { return }
        networkChecking = true
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["python3", root.appendingPathComponent("scripts/connection-status.py").path]
        task.environment = env
        let output = Pipe()
        task.standardOutput = output
        task.terminationHandler = { process in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let info = (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
            DispatchQueue.main.async {
                self.networkChecking = false
                if !self.stopping && !self.stopped {
                    self.status.stringValue = "This machine: " + (info?["localStatus"] ?? "Status unavailable")
                }
                self.phoneStatus.stringValue = "Phone: " + (info?["phoneStatus"] ?? "Status unavailable")
                self.copyButton.isEnabled = info?["phoneUrl"]?.hasPrefix("https://") == true
                if let url = info?["phoneUrl"], !url.isEmpty { self.phoneLink.stringValue = url }
                else { self.phoneLink.stringValue = "Open Settings → Phone access to set up HTTPS" }
            }
        }
        do { try task.run() }
        catch { networkChecking = false; phoneStatus.stringValue = "Phone: could not check Tailscale" }
    }

    func check(_ completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: URL(string: address)!)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { data, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            DispatchQueue.main.async {
                completion(code == 401 || (error == nil && text.contains("Distributed Orchestrator")))
            }
        }.resume()
    }

    func start() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "scripts/start.mjs", "--no-browser"]
        process.currentDirectoryURL = root
        process.environment = env
        let path = root.appendingPathComponent(".launcher.log").path
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        log = FileHandle(forWritingAtPath: path)
        log?.seekToEndOfFile()
        process.standardOutput = log
        process.standardError = log
        do {
            try process.run()
            child = process
            status.stringValue = "Checking GitHub before starting…"
            timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in
                guard process.isRunning else {
                    self.status.stringValue = "Stopped — details in .launcher.log"
                    self.stopButton.title = "Close launcher"
                    self.stopButton.isEnabled = true
                    self.timer?.invalidate()
                    return
                }
                if self.checking { return }
                self.checking = true
                self.check { found in
                    self.checking = false
                    self.status.stringValue = found ? "Active" : "Waiting for server — see .launcher.log"
                }
            }
        } catch {
            status.stringValue = "Could not start Node.js: \(error.localizedDescription)"
            stopButton.title = "Close launcher"
        }
    }

    @objc func openBrowser() {
        var components = URLComponents(string: address)!
        var token = env["HARNESS_TOKEN"] ?? ""
        if token == "auto" {
            let data = env["HARNESS_DATA_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/harness"
            token = (try? String(contentsOfFile: data + "/server-token", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        if !token.isEmpty { components.queryItems = [URLQueryItem(name: "t", value: token)] }
        NSWorkspace.shared.open(components.url!)
    }
    func stopServer(close: Bool) {
        if stopping { return }
        stopping = true
        timer?.invalidate()
        status.stringValue = "Stopping…"
        stopButton.isEnabled = false
        if let process = child, process.isRunning { process.terminate() }
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        helper.arguments = ["node", root.appendingPathComponent("scripts/stop-server.mjs").path,
                            root.path, env["HARNESS_PORT"] ?? "8787"]
        helper.environment = env
        let errors = Pipe()
        helper.standardError = errors
        helper.terminationHandler = { process in
            let data = errors.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                self.stopping = false
                self.stopButton.isEnabled = true
                if process.terminationStatus == 0 {
                    self.stopped = true
                    self.status.stringValue = "Stopped"
                    self.stopButton.title = "Close launcher"
                    if close { NSApp.terminate(nil) }
                } else {
                    self.status.stringValue = String(data: data, encoding: .utf8) ?? "Could not stop server."
                    self.window.makeKeyAndOrderFront(nil)
                }
            }
        }
        do { try helper.run() }
        catch {
            stopping = false
            status.stringValue = "Could not stop server: \(error.localizedDescription)"
            stopButton.isEnabled = true
        }
    }
    @objc func stop() {
        if stopped { NSApp.terminate(nil) }
        else { stopServer(close: false) }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if stopped { return true }
        stopServer(close: true)
        return false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if stopped { return .terminateNow }
        stopServer(close: true)
        return .terminateCancel
    }

}
let app = NSApplication.shared
let delegate = Launcher()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
