import Cocoa
import WebKit

// DO's status window on a Mac. It only shows the page scripts/launcher.mjs serves.
// Closing it ends this process, and that is how the launcher knows to stop DO.
final class WindowHost: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let address: URL
    var window: NSWindow!
    var web: WKWebView!
    var titleWatch: NSKeyValueObservation?

    init(address: URL) { self.address = address }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 660),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "DO"
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 20 / 255, green: 22 / 255, blue: 26 / 255, alpha: 1)
        window.minSize = NSSize(width: 340, height: 420)
        web = WKWebView(frame: window.contentView!.bounds)
        web.autoresizingMask = [.width, .height]
        // Hidden until the page has drawn, so a dark window never flashes white.
        web.isHidden = true
        web.navigationDelegate = self
        window.contentView!.addSubview(web)
        titleWatch = web.observe(\.title) { [weak self] view, _ in
            if let title = view.title, !title.isEmpty { self?.window.title = title }
        }
        web.load(URLRequest(url: address))
        if !window.setFrameUsingName("DO status") { window.center() }
        window.setFrameAutosaveName("DO status")
        bringForward()
        listenToLauncher()
    }

    func bringForward() {
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    // The launcher asks for the window through stdin. Its end means nothing is left to show.
    func listenToLauncher() {
        FileHandle.standardInput.readabilityHandler = { handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                if data.isEmpty { NSApp.terminate(nil) } else { self.bringForward() }
            }
        }
    }

    func buildMenu() {
        let main = NSMenu()
        func menu(_ title: String, _ items: [(String, Selector, String)]) {
            let holder = NSMenuItem()
            let list = NSMenu(title: title)
            for (name, action, key) in items { list.addItem(withTitle: name, action: action, keyEquivalent: key) }
            holder.submenu = list
            main.addItem(holder)
        }
        menu("DO", [("Quit DO", #selector(NSApplication.terminate(_:)), "q")])
        menu("File", [("Close Window", #selector(NSWindow.performClose(_:)), "w")])
        menu("Edit", [("Copy", #selector(NSText.copy(_:)), "c"), ("Select All", #selector(NSText.selectAll(_:)), "a")])
        NSApp.mainMenu = main
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { webView.isHidden = false }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { webView.isHidden = false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

guard CommandLine.arguments.count > 1, CommandLine.arguments[1].hasPrefix("http://127.0.0.1:"),
      let address = URL(string: CommandLine.arguments[1]) else {
    // Kept in the Dock and clicked later: there is no page yet, so start DO the normal way.
    let project = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
    NSWorkspace.shared.open(project.appendingPathComponent("Start DO.app"))
    exit(0)
}
let app = NSApplication.shared
let host = WindowHost(address: address)
app.delegate = host
app.setActivationPolicy(.regular)
app.run()
