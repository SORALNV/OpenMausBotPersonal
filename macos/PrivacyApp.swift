import AppKit
import WebKit

final class LocalSessionPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class PrivacyApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var status: NSTextField!
    private var spinner: NSProgressIndicator!
    private var server: Process?
    private var logHandle: FileHandle?
    private var quitting = false
    private var contentReloads = 0
    private var diagnosticsURL: URL?
    private let token = UUID().uuidString
    private let pageURL = URL(string: "http://127.0.0.1:5299/")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let appMenu = NSMenu()
        let appItem = NSMenuItem()
        let mainMenu = NSMenu()
        mainMenu.addItem(appItem)
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "OpenMausBot Privacy を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(title: "編集", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "編集")
        for (name, selector, key) in [("取り消す", "undo:", "z"), ("カット", "cut:", "x"), ("コピー", "copy:", "c"), ("ペースト", "paste:", "v"), ("すべてを選択", "selectAll:", "a")] {
            edit.addItem(withTitle: name, action: Selector(selector), keyEquivalent: key)
        }
        editItem.submenu = edit
        mainMenu.addItem(editItem)
        NSApp.mainMenu = mainMenu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "OpenMausBot Privacy"
        window.minSize = NSSize(width: 760, height: 560)
        window.isReleasedWhenClosed = false
        window.center()
        let content = window.contentView!
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isHidden = true
        content.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        status = NSTextField(wrappingLabelWithString: "GPUプライバシーフィルターを準備しています…")
        status.alignment = .center
        status.font = .systemFont(ofSize: 18)
        status.translatesAutoresizingMaskIntoConstraints = false
        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(status)
        content.addSubview(spinner)
        NSLayoutConstraint.activate([
            status.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            status.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -80),
            spinner.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            spinner.bottomAnchor.constraint(equalTo: status.topAnchor, constant: -22),
        ])
        spinner.startAnimation(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { await start() }
    }

    private func start() async {
        do {
            guard let repository = Bundle.main.object(forInfoDictionaryKey: "PrivacyRepositoryPath") as? String,
                  let node = Bundle.main.object(forInfoDictionaryKey: "PrivacyNodePath") as? String,
                  FileManager.default.isExecutableFile(atPath: node),
                  FileManager.default.fileExists(atPath: repository + "/scripts/privacy-dev.mjs") else {
                throw startupError("開発用ソースまたはNode.jsが見つかりません。アプリを作り直してください。")
            }
            let root = URL(fileURLWithPath: repository).appendingPathComponent(".privacy-dev", isDirectory: true)
            guard root.resolvingSymlinksInPath().path == root.path,
                  FileManager.default.fileExists(atPath: root.appendingPathComponent("venv/bin/python").path),
                  FileManager.default.fileExists(atPath: root.appendingPathComponent("checkpoint/original/model.safetensors").path) else {
                throw startupError("ローカルのフィルターモデルが見つかりません。privacy:setup を実行してください。")
            }
            let logURL = root.appendingPathComponent("native-app.log")
            diagnosticsURL = root.appendingPathComponent("native-ui-status.json")
            recordPhase("starting")
            if FileManager.default.fileExists(atPath: logURL.path) {
                guard logURL.resolvingSymlinksInPath().path == logURL.path else { throw startupError("ログの保存先が不正です。") }
            } else {
                guard FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                    throw startupError("ローカルログを作成できません。")
                }
            }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
            let log = try FileHandle(forWritingTo: logURL)
            try log.seekToEnd()
            logHandle = log
            let child = Process()
            child.executableURL = URL(fileURLWithPath: node)
            child.arguments = ["scripts/privacy-dev.mjs"]
            child.currentDirectoryURL = URL(fileURLWithPath: repository)
            child.environment = [
                "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                "TMPDIR": NSTemporaryDirectory(), "OMB_PRIVACY_DEVICE": "mps", "OMB_PRIVACY_APP_TOKEN": token,
            ]
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = log
            child.standardError = log
            child.terminationHandler = { [weak self] _ in
                Task { @MainActor in
                    guard let self, !self.quitting else { return }
                    self.showFailure("保護版サーバーが停止しました。起動済みの開発版で専用ポートが使用中の場合は、その開発版を終了してから開き直してください。")
                }
            }
            server = child
            try child.run()
            let sessionConfiguration = URLSessionConfiguration.ephemeral
            sessionConfiguration.timeoutIntervalForRequest = 2
            sessionConfiguration.connectionProxyDictionary = [:]
            let session = URLSession(configuration: sessionConfiguration, delegate: LocalSessionPolicy(), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            for _ in 0..<180 {
                guard !quitting else { return }
                guard child.isRunning else { throw startupError("GPUフィルターまたはサーバーを起動できませんでした。") }
                if await ready(session) {
                    spinner.stopAnimation(nil)
                    spinner.isHidden = true
                    status.isHidden = true
                    webView.isHidden = false
                    recordPhase("loading")
                    webView.load(URLRequest(url: pageURL))
                    return
                }
                try await Task.sleep(nanoseconds: 500_000_000)
            }
            child.terminate()
            throw startupError("GPUフィルターの準備がタイムアウトしました。原文を送信する起動方法には切り替えていません。")
        } catch {
            showFailure((error as NSError).localizedDescription)
        }
    }

    private func ready(_ session: URLSession) async -> Bool {
        do {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:8899/api/privacy/status")!)
            request.setValue(token, forHTTPHeaderField: "X-OMB-Privacy-Instance")
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  response.value(forHTTPHeaderField: "X-OMB-Privacy-Instance") == token,
                  let status = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  status["mode"] as? String == "strict", status["device"] as? String == "mps", status["ready"] as? Bool == true else { return false }
            var uiRequest = URLRequest(url: pageURL)
            uiRequest.setValue(token, forHTTPHeaderField: "X-OMB-Privacy-Instance")
            let (_, uiResponse) = try await session.data(for: uiRequest)
            guard let ui = uiResponse as? HTTPURLResponse else { return false }
            return ui.statusCode == 200 && ui.value(forHTTPHeaderField: "X-OMB-Privacy-Instance") == token
                && ui.value(forHTTPHeaderField: "Content-Security-Policy")?.contains("connect-src 'self'") == true
        } catch { return false }
    }

    private func startupError(_ message: String) -> NSError {
        NSError(domain: "OpenMausBotPrivacy", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func recordPhase(_ phase: String, count: Int? = nil, code: Int? = nil) {
        guard let diagnosticsURL else { return }
        var status: [String: Any] = ["phase": phase, "webWidth": webView.frame.width, "webHeight": webView.frame.height,
                                   "hidden": webView.isHidden, "contentReloads": contentReloads]
        if let count { status["rootChildren"] = count }
        if let code { status["code"] = code }
        guard let data = try? JSONSerialization.data(withJSONObject: status) else { return }
        try? data.write(to: diagnosticsURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: diagnosticsURL.path)
    }

    private func showFailure(_ message: String) {
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        webView.isHidden = true
        status.isHidden = false
        status.stringValue = message + "\n\n詳細は開発データ内の native-app.log を確認してください。"
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        if let server, server.isRunning {
            server.terminate()
            let deadline = Date().addingTimeInterval(4)
            while server.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        }
        try? logHandle?.close()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              url.scheme == "http", url.host == "127.0.0.1", url.port == 5299,
              (url.user ?? "").isEmpty, (url.password ?? "").isEmpty else { recordPhase("navigation-blocked"); decisionHandler(.cancel); return }
        recordPhase("navigation-allowed")
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        recordPhase("navigation-failed", code: (error as NSError).code)
        if (error as NSError).code != NSURLErrorCancelled { showFailure("画面の読み込みに失敗しました（WebKit \((error as NSError).code)）。") }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        recordPhase("navigation-failed", code: (error as NSError).code)
        if (error as NSError).code != NSURLErrorCancelled { showFailure("画面の読み込みに失敗しました（WebKit \((error as NSError).code)）。") }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        recordPhase("web-process-terminated")
        guard contentReloads < 1, server?.isRunning == true else { showFailure("画面の描画プロセスが停止しました。アプリを開き直してください。"); return }
        contentReloads += 1
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task {
            for _ in 0..<60 {
                guard !quitting else { return }
                let count = (try? await webView.evaluateJavaScript("document.getElementById('root')?.childElementCount ?? -1")) as? Int ?? -1
                recordPhase(count > 0 ? "rendered" : "waiting-for-render", count: count)
                if count > 0 { return }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            showFailure("画面の初期化が完了しませんでした。アプリを開き直してください。")
        }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
}

@main
struct PrivacyMain {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = PrivacyApp()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}
