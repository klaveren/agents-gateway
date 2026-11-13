// O app do Agents Gateway no Mac: uma janela própria (WebKit) com a tela do gateway, e o servidor em segundo plano.
//
// ⚖️ A janela é só a tela: quem sobe e mantém o servidor é o LaunchAgent (ver `service.sh`). Fechar a janela não para o
// servidor; abrir o app de novo só reabre a tela. Quem para, inicia e reinicia o servidor é o menu Servidor.
// ⚖️ A mesma janela abre a tela de OUTROS gateways (menu Servidor): cada um com o próprio login, sem passar pelo daqui.
//
// Compilado pelo `build-app.sh`: swiftc -O -target arm64-apple-macos12.0 App.swift -o "Agents Gateway"
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation, NSMenuDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandlerWithReply {
  private var window: NSWindow!
  private var web: WKWebView!
  private var home: URL?
  /// O servidor deste Mac está parado: a janela não tenta abrir a tela dele.
  private var stopped = false
  /// O que está em andamento com o servidor deste Mac ("iniciando", "parando"…); `nil`: nada.
  private var activity: String? { didSet { refreshStatusLine() } }
  /// A porta do servidor deste Mac, dita pelo `service.sh`.
  private var port: Int?
  /// O acesso pela rede está ligado (o servidor ouve em todas as interfaces), e o endereço deste Mac na rede.
  private var network = false
  private var lanAddress: String?
  /// O item "Acesso pela rede" do menu Servidor (a marca diz se está ligado).
  private let networkItem = NSMenuItem(title: "Acesso pela rede", action: nil, keyEquivalent: "")
  /// A linha de estado do menu Servidor ("Este Mac: rodando na porta 3210").
  private let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let resources = Bundle.main.resourceURL!
  private let config = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Agents Gateway/config.env")

  func applicationDidFinishLaunching(_ notification: Notification) {
    loadServers()
    buildMenu()
    let settings = WKWebViewConfiguration()
    settings.websiteDataStore = .default()
    settings.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "gatewayServers")
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

  /// O `service.sh` no modo pedido (`nil`: garantir o servidor no ar): o que ele imprimiu e, quando falha, o motivo.
  private func service(_ mode: String?, folder: String? = nil, extra: [String] = []) -> (ok: Bool, printed: String, reason: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = [resources.appendingPathComponent("service.sh").path] + (mode.map { [$0] } ?? []) + extra
    var env = ProcessInfo.processInfo.environment
    if let folder { env["AG_DATA"] = folder }
    process.environment = env
    let out = Pipe(), err = Pipe()
    process.standardOutput = out
    process.standardError = err
    do { try process.run() } catch { return (false, "", "Não consegui rodar o serviço: \(error.localizedDescription)") }
    process.waitUntilExit()
    let printed = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let reason = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return (process.terminationStatus == 0, printed, reason)
  }

  /// Garante o servidor no ar (grava a configuração, garante o LaunchAgent, espera responder) e abre o endereço dele.
  /// `restart`: reinicia mesmo sem nada ter mudado. `reveal: false`: a janela fica onde está (na tela de outro servidor).
  /// `fromMenu`: a falha só avisa (na abertura do app, ela oferece tentar de novo ou fechar).
  private func startService(folder: String?, restart: Bool = false, reveal: Bool = true, fromMenu: Bool = false) {
    activity = restart ? "reiniciando" : "iniciando"
    // Reiniciar devolve a pessoa à página em que ela estava.
    let back = restart && reveal ? web.url.flatMap { isHome($0) ? $0 : nil } : nil
    if reveal { web.loadHTMLString(Self.waiting, baseURL: nil) }
    DispatchQueue.global(qos: .userInitiated).async {
      let result = self.service(restart ? "restart" : nil, folder: folder)
      DispatchQueue.main.async {
        self.activity = nil
        self.refreshStatus()
        guard result.ok, let url = URL(string: result.printed) else {
          let reason = result.reason.isEmpty ? "O servidor não subiu." : result.reason
          // Na abertura do app não há o que mostrar sem o servidor; pelo menu, a janela segue onde está.
          if fromMenu, reveal { self.show(Self.localId) }
          return fromMenu ? self.warn("Não consegui \(restart ? "reiniciar" : "iniciar") o servidor deste Mac", reason) : self.fail(reason)
        }
        self.stopped = false
        self.home = URL(string: "\(url.scheme ?? "http")://\(url.host ?? "localhost"):\(url.port ?? 3210)/")
        if reveal { self.web.load(URLRequest(url: back ?? url)) }
      }
    }
  }

  /// Para o servidor deste Mac. ⚖️ É o que libera o app para ser trocado por uma versão nova: com o servidor rodando de
  /// dentro dele, o Finder não consegue substituir o app.
  private func stopService() {
    activity = "parando"
    DispatchQueue.global(qos: .userInitiated).async {
      let result = self.service("stop")
      DispatchQueue.main.async {
        self.activity = nil
        self.refreshStatus()
        guard result.ok else { return self.warn("Não consegui parar o servidor deste Mac", result.reason) }
        self.stopped = true
        if self.current == Self.localId { self.show(Self.localId) }
      }
    }
  }

  private func warn(_ title: String, _ text: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = text
    alert.addButton(withTitle: "OK")
    _ = alert.runModal()
  }

  /// Pergunta ao `service.sh` se o servidor deste Mac está no ar e em que porta, e põe isso no menu. ⚖️ Quem responde é o
  /// launchd, não a memória do app: o servidor pode ter sido parado ou iniciado por fora (o Terminal, o login).
  private func refreshStatus() {
    DispatchQueue.global(qos: .userInitiated).async {
      let parts = self.service("status").printed.split(separator: " ")
      DispatchQueue.main.async {
        guard parts.count >= 2, let port = Int(parts[1]) else { return }
        self.port = port
        self.network = parts.count >= 3 && parts[2] == "1"
        self.lanAddress = parts.count >= 4 ? String(parts[3]) : nil
        if self.activity == nil { self.stopped = parts[0] == "stopped" }
        self.refreshStatusLine()
      }
    }
  }

  private func refreshStatusLine() {
    let at = port.map { " na porta \($0)" } ?? ""
    // Com o acesso pela rede, o endereço que os outros aparelhos usam.
    let lan = network && !stopped ? lanAddress.map { " · na rede: http://\($0):\(port ?? 3210)" } ?? " · na rede" : ""
    statusLine.title = "\(Self.localName): " + (activity.map { "\($0)…" } ?? (stopped ? "parado" : "rodando\(at)\(lan)"))
    networkItem.state = network ? .on : .off
    serverMenu.update()
  }

  /// O menu Servidor confere o estado de verdade a cada vez que abre.
  func menuWillOpen(_ menu: NSMenu) { refreshStatus() }

  /// Quantas conversas rodam agora no servidor deste Mac (`nil`: ele não respondeu). Só a própria máquina recebe o número.
  private func runningTurns(_ done: @escaping (Int?) -> Void) {
    guard let port = port ?? home.map(Self.port), let url = URL(string: "http://127.0.0.1:\(port)/v1/health?turns=1") else { return done(nil) }
    var request = URLRequest(url: url)
    request.timeoutInterval = 3
    URLSession.shared.dataTask(with: request) { data, _, _ in
      let reply = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
      let running = (reply?["result"] as? [String: Any])?["running"] as? Int
      DispatchQueue.main.async { done(running) }
    }.resume()
  }

  /// ⛔ Parar e reiniciar cortam o que estiver rodando: a pessoa confirma sabendo quantas conversas são.
  private func confirmCut(_ title: String, button: String, note: String = "", then act: @escaping () -> Void) {
    activity = "conferindo"
    runningTurns { running in
      self.activity = nil
      let cut: String
      switch running {
      case .some(0): cut = "Nenhuma conversa está rodando agora."
      case .some(1): cut = "⚠️ Há 1 conversa rodando agora neste Mac: ela é interrompida."
      case .some(let count): cut = "⚠️ Há \(count) conversas rodando agora neste Mac: elas são interrompidas."
      case .none: cut = "As conversas que estiverem rodando neste Mac são interrompidas."
      }
      let alert = NSAlert()
      alert.messageText = title
      alert.informativeText = [cut, note].filter { !$0.isEmpty }.joined(separator: "\n\n")
      alert.addButton(withTitle: button)
      alert.addButton(withTitle: "Cancelar")
      if alert.runModal() == .alertFirstButtonReturn { act() }
    }
  }

  @objc private func startLocal(_ sender: Any?) { startService(folder: nil, reveal: current == Self.localId, fromMenu: true) }

  @objc private func stopLocal(_ sender: Any?) {
    let note = "Os agendamentos e os gatilhos não rodam enquanto ele estiver parado. Ele volta em Servidor → Iniciar o servidor deste Mac, ao abrir o app de novo ou no próximo login."
    confirmCut("Parar o servidor deste Mac?", button: "Parar", note: note) { self.stopService() }
  }

  /**
   * ⚖️ O ACESSO PELA REDE: ligado, o servidor deste Mac ouve em todas as interfaces e os outros aparelhos da rede abrem a tela
   * dele pelo endereço do Mac. ⛔ A pessoa confirma sabendo do risco (a senha passa sem HTTPS) e de que o servidor reinicia.
   */
  @objc private func toggleNetwork(_ sender: Any?) {
    let turningOn = !network
    let note = turningOn
      ? "Outros aparelhos desta rede passam a abrir o gateway pelo endereço do Mac. A senha continua exigida, mas sem HTTPS ela trafega sem criptografia: use só em rede confiável. O macOS pode pedir para permitir conexões de entrada."
      : "O servidor volta a atender só este Mac."
    confirmCut(turningOn ? "Liberar o acesso pela rede?" : "Fechar o acesso pela rede?", button: turningOn ? "Liberar e reiniciar" : "Fechar e reiniciar", note: note) {
      self.activity = "reiniciando"
      DispatchQueue.global(qos: .userInitiated).async {
        let result = self.service("network", extra: [turningOn ? "on" : "off"])
        DispatchQueue.main.async {
          self.activity = nil
          self.refreshStatus()
          if !result.ok { self.warn("Não consegui \(turningOn ? "liberar" : "fechar") o acesso pela rede", result.reason.isEmpty ? "O servidor não subiu." : result.reason) }
        }
      }
    }
  }

  @objc private func restartLocal(_ sender: Any?) {
    confirmCut("Reiniciar o servidor deste Mac?", button: "Reiniciar") { self.startService(folder: nil, restart: true, reveal: self.current == Self.localId, fromMenu: true) }
  }

  /// Iniciar só com o servidor parado; parar e reiniciar só com ele no ar; nenhum dos três no meio de uma dessas operações.
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(startLocal(_:)): return activity == nil && stopped
    case #selector(stopLocal(_:)), #selector(restartLocal(_:)): return activity == nil && !stopped
    case #selector(toggleNetwork(_:)): return activity == nil
    default: return true
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

  /// O início do servidor que está na janela.
  @objc private func goHome(_ sender: Any?) { show(current) }

  @objc private func reload(_ sender: Any?) { web.reload() }

  // MARK: servidores: outros gateways na mesma janela

  /// ⚖️ TROCAR DE SERVIDOR é carregar, na mesma janela, a tela do outro gateway, com o login dele: nada é sincronizado e
  /// nada passa pelo gateway daqui. ⛔ O app guarda só o nome e o endereço (nas preferências), nunca senha nem token.
  private struct Server {
    let id: String
    let name: String
    let url: URL
  }

  private static let localId = "local"
  private static let localName = "Este Mac"
  private var servers: [Server] = []
  private var current = AppDelegate.localId
  private let serverMenu = NSMenu(title: "Servidor")

  private func loadServers() {
    let stored = UserDefaults.standard.array(forKey: "servers") as? [[String: String]] ?? []
    servers = stored.compactMap { entry in
      guard let id = entry["id"], let name = entry["name"], let url = entry["url"].flatMap({ URL(string: $0) }), url.host != nil else { return nil }
      return Server(id: id, name: name, url: url)
    }
  }

  private func storeServers() {
    UserDefaults.standard.set(servers.map { ["id": $0.id, "name": $0.name, "url": $0.url.absoluteString] }, forKey: "servers")
    rebuildServerMenu()
  }

  private static func port(_ url: URL) -> Int { url.port ?? (url.scheme == "https" ? 443 : 80) }

  /// O servidor cadastrado dono do endereço: mesmo esquema, host e porta. O cadastrado em `http` que sobe para `https` conta.
  /// ⛔ O contrário não: o cadastrado em `https` nunca vale em `http` (seria a tela dele, em texto puro, com o nome dele).
  private func server(of url: URL?) -> Server? {
    guard let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = url.host?.lowercased() else { return nil }
    return servers.first { server in
      guard server.url.host?.lowercased() == host else { return false }
      if server.url.scheme == scheme { return Self.port(server.url) == Self.port(url) }
      return server.url.scheme == "http" && server.url.port == nil && url.port == nil
    }
  }

  /// A tela DESTE Mac (o gateway que o app sobe): só ela cadastra, remove e vê o endereço dos servidores.
  private func isHome(_ url: URL) -> Bool {
    guard let home, isLocal(url), url.host != nil, server(of: url) == nil else { return false }
    return Self.port(url) == Self.port(home)
  }

  /// A rede local (IP privado, nome sem ponto, `.local`): é onde o app abre `http` (`NSAllowsLocalNetworking`, no `Info.plist`).
  /// ⛔ IP público não conta: o macOS deixaria (IP não passa pela trava de `http`), e o login iria em texto puro pela internet.
  private static func isLocalNetwork(_ typed: String) -> Bool {
    let host = typed.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    guard !host.isEmpty, host.allSatisfy(\.isASCII) else { return false }
    if host.contains(":") {
      // IPv6: o próprio Mac, link-local (fe80::/10) e rede privada (fc00::/7).
      let first = host.prefix { $0 != ":" }
      return host == "::1" || (first.count == 4 && ["fe8", "fe9", "fea", "feb", "fc", "fd"].contains { first.hasPrefix($0) })
    }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    // ⛔ Rótulo final numérico é IP para o WebKit, que lê `010.0.0.1` em octal e `134744072` como 8.8.8.8: só vale o IPv4
    // escrito por extenso, em decimal.
    guard let last = labels.last, isNumber(last) else { return host == "localhost" || host.hasSuffix(".local") || !host.contains(".") }
    let parts = labels.compactMap { label in UInt8(label).flatMap { String($0) == label ? $0 : nil } }
    guard labels.count == 4, parts.count == 4 else { return false }
    let a = parts[0], b = parts[1]
    // 10/8, 172.16/12, 192.168/16, o próprio Mac (127/8), link-local (169.254/16) e a faixa das VPNs (100.64/10).
    return a == 10 || a == 127 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 169 && b == 254) || (a == 100 && (64...127).contains(b))
  }

  /// Número como o WebKit lê num endereço: só dígitos, ou hexadecimal (`0x7f`).
  private static func isNumber(_ label: Substring) -> Bool {
    if label.hasPrefix("0x") { return label.dropFirst(2).allSatisfy(\.isHexDigit) }
    return !label.isEmpty && label.allSatisfy { ("0"..."9").contains($0) }
  }

  /// Um nome de host de verdade: com alguma coisa, e sem espaço nem caractere de controle (o `%00` que o endereço esconde).
  private static func isHostName(_ host: String) -> Bool {
    !host.isEmpty && !host.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) || CharacterSet.whitespacesAndNewlines.contains($0) }
  }

  /// O endereço digitado vira só a origem (`https://host[:porta]`): sem caminho e sem usuário e senha.
  private static func origin(of typed: String) -> (url: URL?, problem: String?) {
    let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    let invalid: (URL?, String?) = (nil, "Endereço inválido. Exemplo: https://servidor.exemplo.com")
    guard !text.isEmpty, !text.contains(" ") else { return invalid }
    // Sem esquema: `http` na rede local, `https` no resto.
    let full = text.contains("://") ? text : (isLocalNetwork(URLComponents(string: "x://\(text)")?.host?.lowercased() ?? "") ? "http://" : "https://") + text
    guard var parts = URLComponents(string: full), let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = parts.host?.lowercased(), isHostName(host), (1...65535).contains(parts.port ?? 80) else { return invalid }
    guard parts.user == nil, parts.password == nil else { return (nil, "O endereço não leva usuário nem senha: o login é na tela do servidor.") }
    guard scheme == "https" || isLocalNetwork(host) else { return (nil, "Fora da rede local o app só abre https. Use https://\(host)\(parts.port.map { ":\($0)" } ?? "")") }
    parts.scheme = scheme
    if parts.host != host { parts.host = host }
    parts.path = ""
    parts.query = nil
    parts.fragment = nil
    guard let url = parts.url, url.host != nil else { return invalid }
    return (url, nil)
  }

  /// Devolve o motivo quando não cadastra.
  private func addServer(name typed: String, address: String) -> String? {
    let name = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.count <= 40 else { return "Dê um nome de até 40 caracteres." }
    guard servers.count < 20 else { return "O app guarda até 20 servidores." }
    let taken = ([Self.localName] + servers.map(\.name)).contains { $0.caseInsensitiveCompare(name) == .orderedSame }
    guard !taken else { return "Já existe um servidor com esse nome." }
    let parsed = Self.origin(of: address)
    guard let url = parsed.url else { return parsed.problem }
    guard server(of: url) == nil else { return "Esse endereço já está cadastrado." }
    if let home, isLocal(url), Self.port(url) == Self.port(home) { return "Esse endereço é o deste Mac." }
    servers.append(Server(id: UUID().uuidString.lowercased(), name: name, url: url))
    storeServers()
    return nil
  }

  /// Carrega o início do servidor na janela. `false`: não existe (ou o daqui ainda não subiu).
  @discardableResult
  private func show(_ id: String) -> Bool {
    if id == Self.localId, stopped {
      web.loadHTMLString(Self.stoppedPage, baseURL: nil)
      // A página parada não tem endereço: o `didCommit` não a reconhece, quem marca a janela como "Este Mac" é aqui.
      current = Self.localId
      window.title = "Agents Gateway"
      rebuildServerMenu()
      return true
    }
    guard let url = id == Self.localId ? home : servers.first(where: { $0.id == id })?.url else { return false }
    web.load(URLRequest(url: url))
    return true
  }

  @objc private func chooseServer(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String { show(id) }
  }

  /// O cadastro mora na tela deste Mac (menu da conta → Servidores).
  @objc private func manageServers(_ sender: Any?) {
    if stopped { show(Self.localId) } else if let home { web.load(URLRequest(url: home.appendingPathComponent("servers"))) }
  }

  private func rebuildServerMenu() {
    serverMenu.removeAllItems()
    let rows = [(Self.localId, Self.localName)] + servers.map { ($0.id, $0.name) }
    for (index, row) in rows.enumerated() {
      let entry = NSMenuItem(title: row.1, action: #selector(chooseServer(_:)), keyEquivalent: index < 9 ? "\(index + 1)" : "")
      entry.target = self
      entry.representedObject = row.0
      entry.state = row.0 == current ? .on : .off
      serverMenu.addItem(entry)
    }
    serverMenu.addItem(.separator())
    let manage = NSMenuItem(title: "Gerenciar servidores…", action: #selector(manageServers(_:)), keyEquivalent: "")
    manage.target = self
    serverMenu.addItem(manage)
    serverMenu.addItem(.separator())
    serverMenu.addItem(statusLine)
    for (title, action) in [("Iniciar o servidor deste Mac", #selector(startLocal(_:))), ("Parar o servidor deste Mac…", #selector(stopLocal(_:))), ("Reiniciar o servidor deste Mac…", #selector(restartLocal(_:)))] {
      let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
      entry.target = self
      serverMenu.addItem(entry)
    }
    serverMenu.addItem(.separator())
    networkItem.action = #selector(toggleNetwork(_:))
    networkItem.target = self
    serverMenu.addItem(networkItem)
    refreshStatusLine()
  }

  /// O servidor da janela é o do endereço carregado: o título e a marca do menu seguem ele, venha a troca de onde vier.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    // ⛔ Só endereço da web troca o servidor da janela: o `blob:` e o `about:` são da tela que os abriu, e sem isto a tela de
    // outro servidor passaria por "Este Mac" no título.
    guard let scheme = webView.url?.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
    let shown = server(of: webView.url)
    current = shown?.id ?? Self.localId
    window.title = shown.map { "Agents Gateway — \($0.name)" } ?? "Agents Gateway"
    rebuildServerMenu()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    let failure = error as NSError
    // -999: outra navegação tomou o lugar; 102 do WebKit: virou download, ou foi para o navegador.
    guard failure.code != NSURLErrorCancelled, !(failure.domain == "WebKitErrorDomain" && failure.code == 102) else { return }
    guard let url = failure.userInfo[NSURLErrorFailingURLErrorKey] as? URL, let server = server(of: url) else { return }
    let alert = NSAlert()
    alert.messageText = "Não consegui abrir “\(server.name)”"
    alert.informativeText = "\(server.url.absoluteString)\n\(failure.localizedDescription)"
    alert.addButton(withTitle: "Tentar de novo")
    alert.addButton(withTitle: "Cancelar")
    if alert.runModal() == .alertFirstButtonReturn { web.load(URLRequest(url: url)) }
  }

  /// A ponte da tela (`window.webkit.messageHandlers.gatewayServers`): listar, trocar, cadastrar, remover.
  /// ⛔ Só o quadro principal de uma tela nossa fala com ela; a de outro servidor só lista os nomes e troca pelo id —
  /// cadastrar, remover e ver endereço é da tela deste Mac.
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
    let origin = message.frameInfo.securityOrigin
    let host = origin.host.contains(":") && !origin.host.hasPrefix("[") ? "[\(origin.host)]" : origin.host
    guard message.frameInfo.isMainFrame, !host.isEmpty,
          let page = URL(string: "\(origin.protocol)://\(host)\(origin.port == 0 ? "" : ":\(origin.port)")"), isOurs(page) else { return replyHandler(nil, "recusado") }
    let manages = isHome(page)
    let body = message.body as? [String: Any] ?? [:]
    switch body["op"] as? String {
    case "list":
      break
    case "switch":
      guard let id = body["id"] as? String, show(id) else { return replyHandler(nil, "Servidor não encontrado.") }
    case "add":
      guard manages else { return replyHandler(nil, "O cadastro é feito na tela deste Mac.") }
      if let problem = addServer(name: body["name"] as? String ?? "", address: body["url"] as? String ?? "") { return replyHandler(nil, problem) }
    case "remove":
      guard manages else { return replyHandler(nil, "O cadastro é feito na tela deste Mac.") }
      servers.removeAll { $0.id == body["id"] as? String }
      storeServers()
    default:
      return replyHandler(nil, "operação desconhecida")
    }
    var rows: [[String: Any]] = [["id": Self.localId, "name": Self.localName, "local": true]]
    rows += servers.map { manages ? ["id": $0.id, "name": $0.name, "url": $0.url.absoluteString] : ["id": $0.id, "name": $0.name] }
    replyHandler(["current": server(of: page)?.id ?? Self.localId, "manage": manages, "servers": rows], nil)
  }

  // MARK: navegação: os gateways (o daqui e os cadastrados) aqui; o resto no navegador

  private func isLocal(_ url: URL?) -> Bool {
    guard let host = url?.host else { return url?.scheme == "about" || url?.scheme == "blob" || url?.scheme == "data" }
    return host == "localhost" || host == "127.0.0.1"
  }

  private func isOurs(_ url: URL?) -> Bool { isLocal(url) || server(of: url) != nil }

  /// ⛔ Para o navegador só vai endereço da web (e o `mailto:`). Sem isto, a página — a de outro servidor, ou o link que um
  /// agente escreveu — abriria um arquivo deste Mac (`file:`) ou o esquema de qualquer app, sem ninguém confirmar.
  private func openOutside(_ url: URL) {
    if Self.opensOutside(url) { NSWorkspace.shared.open(url) }
  }

  private static func opensOutside(_ url: URL) -> Bool { ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    if let url = action.request.url, !isOurs(url), action.targetFrame?.isMainFrame != false {
      openOutside(url)
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
      if isOurs(url) { webView.load(action.request) } else { openOutside(url) }
    }
    return nil
  }

  // MARK: downloads (o arquivo que o agente entrega, o export do catálogo)

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    var target = folder.appendingPathComponent(Self.fileName(suggestedFilename))
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

  /// O nome vem da resposta do servidor: só o último pedaço do caminho, e nunca um arquivo oculto.
  private static func fileName(_ suggested: String) -> String {
    var name = (suggested as NSString).lastPathComponent
    while name.hasPrefix(".") { name.removeFirst() }
    return name.isEmpty || name == "/" ? "arquivo" : name
  }

  /// Como no navegador: o que foi baixado leva a marca de quarentena, e o macOS confere antes de abrir um programa.
  private static func quarantine(_ file: URL) {
    var file = file
    var values = URLResourceValues()
    values.quarantineProperties = [kLSQuarantineTypeKey as String: kLSQuarantineTypeWebDownload as String, kLSQuarantineAgentNameKey as String: "Agents Gateway"]
    try? file.setResourceValues(values)
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let target = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
    Self.quarantine(target)
    NSWorkspace.shared.activateFileViewerSelecting([target])
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
    // ⌘1 é "Este Mac", ⌘2… os cadastrados (menu Servidor): o Início ficou com ⇧⌘H.
    submenu("Visualizar", [
      item("Início", #selector(goHome(_:)), "h", [.command, .shift], target: self),
      item("Recarregar", #selector(reload(_:)), "r", target: self),
      .separator(),
      item("Voltar", #selector(WKWebView.goBack(_:)), "["),
      item("Avançar", #selector(WKWebView.goForward(_:)), "]"),
    ])
    let holder = NSMenuItem(title: serverMenu.title, action: nil, keyEquivalent: "")
    holder.submenu = serverMenu
    serverMenu.delegate = self
    main.addItem(holder)
    rebuildServerMenu()
    submenu("Janela", [
      item("Minimizar", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Fechar", #selector(NSWindow.performClose(_:)), "w"),
    ])
    NSApp.mainMenu = main
  }

  private static let stoppedPage = """
  <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#09090b;color:#a1a1aa;font:15px/1.6 -apple-system">
  <div style="text-align:center;max-width:460px;padding:24px"><div style="font-size:28px;color:#71717a;margin-bottom:8px">◎</div>
  <div style="color:#e4e4e7;font-size:17px;margin-bottom:10px">O servidor deste Mac está parado</div>
  Para voltar: menu <b>Servidor → Iniciar o servidor deste Mac</b>.<br><br>
  Para atualizar o app: saia dele (⌘Q), arraste a versão nova para a pasta Aplicativos e abra.</div>
  </body></html>
  """

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
