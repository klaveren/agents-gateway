// O app do Agents Gateway no Mac: uma janela própria (WebKit) com a tela do gateway, e o servidor em segundo plano.
//
// ⚖️ A janela é só a tela: quem sobe e mantém o servidor é o LaunchAgent (ver `service.sh`). Fechar a janela não para o
// servidor; abrir o app de novo só reabre a tela.
//
// Compilado pelo `build-app.sh`: swiftc -O -target arm64-apple-macos12.0 App.swift -o "Agents Gateway"
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
  private var window: NSWindow!
  private var web: WKWebView!
  private var home: URL?
  private let resources = Bundle.main.resourceURL!
  private let config = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Agents Gateway/config.env")

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    let settings = WKWebViewConfiguration()
    settings.websiteDataStore = .default()
    web = WKWebView(frame: .zero, configuration: settings)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsBackForwardNavigationGestures = true

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Agents Gateway"
    window.minSize = NSSize(width: 720, height: 520)
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("AgentsGatewayMain")
    window.isReleasedWhenClosed = false
    web.loadHTMLString(Self.waiting, baseURL: nil)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    // ⌥ Option segurado ao abrir, ou sem pasta ainda: pergunta a pasta de trabalho.
    let wantsFolder = NSEvent.modifierFlags.contains(.option) || !hasFolder()
    if wantsFolder {
      guard let folder = chooseFolder() else {
        if !hasFolder() { NSApp.terminate(nil) }
        startService(folder: nil)
        return
      }
      startService(folder: folder)
    } else {
      startService(folder: nil)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  // MARK: o servidor

  private func hasFolder() -> Bool {
    guard let text = try? String(contentsOf: config, encoding: .utf8) else { return false }
    return text.split(separator: "\n").contains { $0.hasPrefix("GATEWAY_DATA=") && $0.count > "GATEWAY_DATA=".count }
  }

  private func chooseFolder() -> String? {
    let panel = NSOpenPanel()
    panel.title = "Pasta de trabalho do Agents Gateway"
    panel.message = "Escolha a pasta de trabalho: os projetos, o banco e o cofre ficam nela."
    panel.prompt = "Usar esta pasta"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    return panel.runModal() == .OK ? panel.url?.path : nil
  }

  /// Roda o `service.sh` (grava a configuração, garante o LaunchAgent, espera o servidor) e abre o endereço que ele devolve.
  private func startService(folder: String?) {
    web.loadHTMLString(Self.waiting, baseURL: nil)
    DispatchQueue.global(qos: .userInitiated).async {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/bin/zsh")
      process.arguments = [self.resources.appendingPathComponent("service.sh").path]
      var env = ProcessInfo.processInfo.environment
      if let folder { env["AG_DATA"] = folder }
      process.environment = env
      let out = Pipe(), err = Pipe()
      process.standardOutput = out
      process.standardError = err
      do { try process.run() } catch {
        DispatchQueue.main.async { self.fail("Não consegui iniciar o servidor: \(error.localizedDescription)") }
        return
      }
      process.waitUntilExit()
      let address = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let reason = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      DispatchQueue.main.async {
        guard process.terminationStatus == 0, let url = URL(string: address) else { return self.fail(reason.isEmpty ? "O servidor não subiu." : reason) }
        self.home = URL(string: "\(url.scheme ?? "http")://\(url.host ?? "localhost"):\(url.port ?? 3210)/")
        self.web.load(URLRequest(url: url))
      }
    }
  }

  private func fail(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Agents Gateway"
    alert.informativeText = message
    alert.addButton(withTitle: "Tentar de novo")
    alert.addButton(withTitle: "Fechar")
    if alert.runModal() == .alertFirstButtonReturn { startService(folder: nil) } else { NSApp.terminate(nil) }
  }

  @objc private func changeFolder(_ sender: Any?) {
    guard let folder = chooseFolder() else { return }
    startService(folder: folder)
  }

  @objc private func goHome(_ sender: Any?) {
    if let home { web.load(URLRequest(url: home)) }
  }

  @objc private func reload(_ sender: Any?) { web.reload() }

  // MARK: navegação: o gateway aqui; o resto no navegador

  private func isLocal(_ url: URL?) -> Bool {
    guard let host = url?.host else { return url?.scheme == "about" || url?.scheme == "blob" || url?.scheme == "data" }
    return host == "localhost" || host == "127.0.0.1"
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    if let url = action.request.url, !isLocal(url), action.targetFrame?.isMainFrame != false {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    decisionHandler(disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType ? .download : .allow)
  }

  /// `window.open` e `target=_blank`: o do gateway na mesma janela; o de fora, no navegador.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url {
      if isLocal(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
    }
    return nil
  }

  // MARK: downloads (o arquivo que o agente entrega, o export do catálogo)

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    var target = folder.appendingPathComponent(suggestedFilename)
    let base = target.deletingPathExtension().lastPathComponent, ext = target.pathExtension
    var index = 1
    while FileManager.default.fileExists(atPath: target.path) {
      target = folder.appendingPathComponent(ext.isEmpty ? "\(base) (\(index))" : "\(base) (\(index)).\(ext)")
      index += 1
    }
    completionHandler(target)
    downloads[ObjectIdentifier(download)] = target
  }

  private var downloads: [ObjectIdentifier: URL] = [:]

  func downloadDidFinish(_ download: WKDownload) {
    if let target = downloads.removeValue(forKey: ObjectIdentifier(download)) { NSWorkspace.shared.activateFileViewerSelecting([target]) }
  }

  // MARK: anexos e diálogos da página

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    completionHandler(panel.runModal() == .OK ? panel.urls : nil)
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.runModal()
    completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancelar")
    completionHandler(alert.runModal() == .alertFirstButtonReturn)
  }

  // MARK: menus (sem o menu Editar, ⌘C/⌘V não funcionam na página)

  private func buildMenu() {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) {
      let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      holder.submenu = menu
      main.addItem(holder)
    }
    func item(_ title: String, _ action: Selector?, _ key: String, _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
      let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
      entry.keyEquivalentModifierMask = modifiers
      entry.target = target
      return entry
    }
    submenu("Agents Gateway", [
      item("Sobre o Agents Gateway", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      .separator(),
      item("Trocar a pasta de trabalho…", #selector(changeFolder(_:)), "", target: self),
      .separator(),
      item("Ocultar o Agents Gateway", #selector(NSApplication.hide(_:)), "h"),
      item("Ocultar os outros", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      .separator(),
      item("Sair do Agents Gateway", #selector(NSApplication.terminate(_:)), "q"),
    ])
    submenu("Editar", [
      item("Desfazer", Selector(("undo:")), "z"),
      item("Refazer", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Recortar", #selector(NSText.cut(_:)), "x"),
      item("Copiar", #selector(NSText.copy(_:)), "c"),
      item("Colar", #selector(NSText.paste(_:)), "v"),
      item("Selecionar tudo", #selector(NSText.selectAll(_:)), "a"),
    ])
    submenu("Visualizar", [
      item("Início", #selector(goHome(_:)), "1", target: self),
      item("Recarregar", #selector(reload(_:)), "r", target: self),
      .separator(),
      item("Voltar", #selector(WKWebView.goBack(_:)), "["),
      item("Avançar", #selector(WKWebView.goForward(_:)), "]"),
    ])
    submenu("Janela", [
      item("Minimizar", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Fechar", #selector(NSWindow.performClose(_:)), "w"),
    ])
    NSApp.mainMenu = main
  }

  private static let waiting = """
  <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#09090b;color:#a1a1aa;font:15px -apple-system">
  <div style="text-align:center"><div style="font-size:28px;color:#6ee7b7;margin-bottom:8px">◉</div>Iniciando o Agents Gateway…</div>
  </body></html>
  """
}

// `--server`: o LaunchAgent roda o PRÓPRIO executável do app (não o `zsh`), para os Itens de Início do macOS mostrarem o
// nome e o ícone do app; daqui, vira o `run-server.sh` (o processo é substituído, sem janela).
if CommandLine.arguments.contains("--server") {
  let script = Bundle.main.resourceURL!.appendingPathComponent("run-server.sh").path
  let parts: [String] = ["/bin/zsh", script]
  var args: [UnsafeMutablePointer<CChar>?] = parts.map { strdup($0) }
  args.append(nil)
  execv("/bin/zsh", args)
  perror("execv")
  exit(1)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
