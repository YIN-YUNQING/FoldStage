// Native macOS Desktop Window wrapper for FoldStage Companion.
// Launches the bundled Node Companion core server and hosts the Studio GUI inside WKWebView,
// giving macOS users a double-clickable .app with clean System Audio Recording permission identity.

import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var serverProc: Process?
  let port = ProcessInfo.processInfo.environment["FOLDSTAGE_PORT"] ?? "8772"

  func findNode() -> String? {
    let cands = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    for c in cands where FileManager.default.isExecutableFile(atPath: c) { return c }
    return nil
  }

  func findProjectRoot() -> String {
    let bundleURL = Bundle.main.bundleURL
    // Expected at <root>/desktop/native/macos/FoldStage Companion.app
    let up3 = bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    if FileManager.default.fileExists(atPath: up3.appendingPathComponent("desktop/core/server.mjs").path) {
      return up3.path
    }
    return FileManager.default.currentDirectoryPath
  }

  func startServer() {
    guard let node = findNode() else { return }
    let root = findProjectRoot()
    let script = (root as NSString).appendingPathComponent("desktop/core/server.mjs")
    guard FileManager.default.fileExists(atPath: script) else { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [script]
    var env = ProcessInfo.processInfo.environment
    env["FOLDSTAGE_PORT"] = port
    if let res = Bundle.main.resourcePath {
      let helper = (res as NSString).appendingPathComponent("foldstage-audio-mac")
      if FileManager.default.isExecutableFile(atPath: helper) {
        env["FOLDSTAGE_AUDIO_HELPER"] = helper
      }
    }
    p.environment = env
    do {
      try p.run()
      serverProc = p
    } catch {}
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    startServer()

    let rect = NSRect(x: 0, y: 0, width: 1100, height: 760)
    window = NSWindow(
      contentRect: rect,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "FoldStage Companion"
    window.center()
    window.delegate = self

    let cfg = WKWebViewConfiguration()
    webView = WKWebView(frame: rect, configuration: cfg)
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
      guard let self else { return }
      if let url = URL(string: "http://127.0.0.1:\(self.port)/") {
        self.webView.load(URLRequest(url: url))
      }
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    serverProc?.terminate()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
