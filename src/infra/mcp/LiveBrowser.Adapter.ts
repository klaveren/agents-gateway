import { ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Um quadro da tela: JPEG em base64, com a página que ele mostra. */
export interface ILiveBrowserFrame {
  data: string
  url?: string
  title?: string
  width?: number
  height?: number
}

/** O que a pessoa faz na tela, em pixels CSS da aba (a gaveta já mede no tamanho da aba). */
export type TLiveBrowserInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string; code?: string; keyCode?: number; text?: string; modifiers?: number }
  | { type: 'text'; text: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'navigate'; url: string }
  | { type: 'tab-select'; targetId: string }
  | { type: 'tab-new'; url?: string }
  | { type: 'tab-close'; targetId: string }

/** O elemento sob o ponto (a seta da barra): o bastante para a pessoa (e o agente) saber de qual se fala. */
export interface ILiveBrowserElement {
  tag: string
  selector: string
  text?: string
  html: string
  url?: string
  rect: { x: number; y: number; width: number; height: number }
}

/** Roda NA PÁGINA: o elemento em (x, y), com um seletor curto (id, ou o caminho com `:nth-of-type`). */
const INSPECT = (x: number, y: number) => `(() => {
  const el = document.elementFromPoint(${x}, ${y})
  if (!el) return null
  const css = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value)
  const path = []
  for (let node = el; node && node.nodeType === 1 && path.length < 5; node = node.parentElement) {
    if (node.id) { path.unshift('#' + css(node.id)); break }
    const tag = node.tagName.toLowerCase()
    const same = node.parentElement ? [...node.parentElement.children].filter((one) => one.tagName === node.tagName) : []
    path.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : tag)
  }
  const box = el.getBoundingClientRect()
  const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ').slice(0, 300)
  const html = el.outerHTML.length > 1500 ? el.outerHTML.slice(0, 1500) + '…' : el.outerHTML
  return { tag: el.tagName.toLowerCase(), selector: path.join(' > '), text, html, url: location.href, rect: { x: box.x, y: box.y, width: box.width, height: box.height } }
})()`

/** O tamanho da aba enquanto alguém olha: o da gaveta, para o site renderizar no layout dela. */
export interface ILiveBrowserViewport {
  width: number
  height: number
  scale: number
}

/** As abas do navegador (só as páginas), na ordem em que abriram, e a que a tela mostra. */
export interface ILiveBrowserTabs {
  tabs: Array<{ id: string; title: string; url: string }>
  current?: string
}

export type TLiveBrowserListener = (event: { type: 'frame'; frame: ILiveBrowserFrame } | { type: 'state'; live: boolean } | ({ type: 'tabs' } & ILiveBrowserTabs)) => void

interface ITarget {
  targetId: string
  url: string
  title: string
}

const START_TIMEOUT_MS = 15_000
/** ⏱️ Nenhum comando CDP espera para sempre: sem resposta, rejeita e libera o id. */
const CALL_TIMEOUT_MS = 30_000
/** ⏱️ A entrada da pessoa (clique, tecla, rolagem) é curta: passou disto, a tela segue para o próximo evento. */
export const INPUT_TIMEOUT_MS = 4_000
const SCREENCAST = { format: 'jpeg', quality: 85, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 }

/** O pacote é o Playwright MCP (`@playwright/mcp`, com ou sem versão). */
export const isPlaywrightMcp = (spec: string | undefined): boolean => !!spec && /^@playwright\/mcp(@|$)/.test(spec)

/** As opções do MCP que dizem onde e como abrir o navegador: com o gateway abrindo, elas saem. */
const OWN_BROWSER_FLAGS = new Set(['--headless', '--isolated', '--no-sandbox'])
const OWN_BROWSER_VALUES = new Set(['--browser', '--executable-path', '--user-data-dir', '--storage-state'])
/** Quem já aponta o MCP para um navegador (CDP, extensão, endpoint) fica como está. */
const EXTERNAL = /^--(cdp-endpoint|extension|endpoint)(=|$)/

export function takesExternalBrowser(args: string[]): boolean {
  return args.some((arg) => EXTERNAL.test(arg))
}

/**
 * 📸 Onde o Playwright MCP grava capturas e downloads: a pasta de rascunho do projeto (`$TMPDIR` dos comandos dele), que
 * as regras de leitura do agente alcançam — no `/tmp` ele não leria o que acabou de salvar. Quem já definiu
 * `--output-dir` fica como está.
 */
export function argsForOutputDir(args: string[], dir: string): string[] {
  return args.some((arg) => /^--output-dir(=|$)/.test(arg)) ? args : [...args, '--output-dir', dir]
}

/** Os argumentos do MCP com o navegador do gateway: tira os de abrir navegador e aponta para o CDP. */
export function argsForEndpoint(args: string[], endpoint: string): string[] {
  const out: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const name = arg.split('=')[0]
    if (OWN_BROWSER_FLAGS.has(name)) continue
    if (OWN_BROWSER_VALUES.has(name)) {
      if (!arg.includes('=')) index += 1
      continue
    }
    out.push(arg)
  }
  return [...out, '--cdp-endpoint', endpoint]
}

/**
 * O Chromium que o Playwright do MCP usaria. ⚖️ Se a revisão dele não está baixada, a mais nova que estiver (o CDP é
 * compatível o bastante para a tela e para o MCP).
 */
export function chromiumExecutable(installDir: string, env: NodeJS.ProcessEnv): string | undefined {
  let wanted: string | undefined
  try {
    const core = createRequire(join(installDir, 'package.json'))('playwright-core') as { chromium: { executablePath(): string } }
    wanted = core.chromium.executablePath()
  } catch {
    wanted = undefined
  }
  if (wanted && existsSync(wanted)) return wanted

  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright') : join(env.HOME ?? homedir(), '.cache', 'ms-playwright'),
  ]
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const revisions = readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    const inside = wanted?.split(/chromium-\d+[\\/]/)[1]
    const candidates = [
      inside,
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-linux64/chrome',
      'chrome-linux/chrome',
    ].filter((path): path is string => !!path)
    for (const revision of revisions) for (const path of candidates) if (existsSync(join(root, revision, path))) return join(root, revision, path)
  }
  return undefined
}

/**
 * Um Chromium do sistema, para quando o Playwright MCP não está instalado (a imagem Docker traz o `chromium` do apt; no
 * Mac, o Chrome). `undefined`: nenhum.
 */
export function systemChromium(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
  const names = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) for (const name of names) if (exists(join(dir, name))) return join(dir, name)
  const fixed = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  return fixed.find((path) => exists(path))
}

/**
 * 👁️ O NAVEGADOR DE UMA CONVERSA, QUE A TELA PODE VER: o gateway abre o Chromium (headless, CDP numa porta local), o
 * Playwright MCP se liga nele por `--cdp-endpoint`, e a tela recebe os quadros (`Page.startScreencast`) da aba em uso.
 *
 * ⚖️ A transmissão só roda com alguém olhando (o primeiro que assiste liga, o último que sai desliga). A aba "em uso" é a
 * última criada ou a última que mudou de endereço — o MCP não diz qual é a dele.
 */
export class LiveBrowser {
  private ws?: WebSocket
  private nextId = 0
  private readonly calls = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  private readonly pages = new Map<string, ITarget>()
  private current?: string
  private attached?: { targetId: string; sessionId: string }
  private readonly listeners = new Set<TLiveBrowserListener>()
  private last?: ILiveBrowserFrame
  private viewport?: ILiveBrowserViewport
  private closed = false
  private readonly closeHooks: Array<() => void> = []
  /** 🙋 Aberto pela PESSOA (a tela), não pelo MCP: só ele fecha por ociosidade e pelo botão. */
  person = false
  /** Quantos MCPs usam este navegador agora (o que o gateway abriu para o agente conta um). */
  leases = 0
  /** Quando alguém (tela ou MCP) largou ou usou o navegador pela última vez: a conta da ociosidade. */
  touchedAt = Date.now()

  private constructor(
    private readonly child: ChildProcess,
    readonly endpoint: string,
  ) {}

  static async launch(options: { executable: string; userDataDir: string; noSandbox?: boolean; env?: NodeJS.ProcessEnv; url?: string }): Promise<LiveBrowser> {
    mkdirSync(options.userDataDir, { recursive: true, mode: 0o700 })
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${options.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1280,900',
      ...(options.noSandbox ? ['--no-sandbox'] : []),
      options.url ?? 'about:blank',
    ]
    const child = spawn(options.executable, args, { env: options.env, stdio: 'ignore' })
    const portFile = join(options.userDataDir, 'DevToolsActivePort')
    const started = Date.now()
    while (Date.now() - started < START_TIMEOUT_MS) {
      if (child.exitCode !== null) throw new Error(`the browser exited (${child.exitCode})`)
      if (existsSync(portFile)) {
        const [port, path] = readFileSync(portFile, 'utf8').split('\n')
        if (port && path) {
          const browser = new LiveBrowser(child, `http://127.0.0.1:${port.trim()}`)
          await browser.connect(`ws://127.0.0.1:${port.trim()}${path.trim()}`)
          return browser
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    child.kill('SIGKILL')
    throw new Error('the browser did not open its debugging port in time')
  }

  private connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      ws.onopen = () => {
        void this.send('Target.setDiscoverTargets', { discover: true }).then(() => resolve(), reject)
      }
      ws.onerror = () => reject(new Error('could not connect to the browser'))
      ws.onclose = () => this.dispose()
      ws.onmessage = (message) => this.onMessage(String(message.data))
    })
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = CALL_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('browser closed'))
    const id = (this.nextId += 1)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.calls.delete(id)) return
        reject(new Error(`${method} did not answer in ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      const settle =
        <T>(done: (value: T) => void) =>
        (value: T) => {
          clearTimeout(timer)
          done(value)
        }
      this.calls.set(id, { resolve: settle(resolve), reject: settle(reject) })
      try {
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        this.calls.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private onMessage(raw: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const call = this.calls.get(message.id)
      this.calls.delete(message.id)
      if (message.error) call?.reject(new Error(message.error.message ?? 'CDP error'))
      else call?.resolve(message.result ?? {})
      return
    }
    const params = message.params ?? {}
    switch (message.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const info = params.targetInfo as { targetId: string; type: string; url: string; title: string }
        if (info.type !== 'page') return
        const before = this.pages.get(info.targetId)
        this.pages.set(info.targetId, { targetId: info.targetId, url: info.url, title: info.title })
        // A aba nova, ou a que mudou de endereço, vira a que a tela mostra.
        if (!before || (before.url !== info.url && info.url !== 'about:blank')) this.focus(info.targetId)
        else if (this.last && info.targetId === this.current) this.last = { ...this.last, url: info.url, title: info.title }
        this.announceTabs()
        return
      }
      case 'Target.targetDestroyed': {
        const targetId = String(params.targetId)
        this.pages.delete(targetId)
        if (this.current === targetId) this.focus([...this.pages.keys()].pop())
        this.announceTabs()
        return
      }
      case 'Page.screencastFrame': {
        if (!this.attached || message.sessionId !== this.attached.sessionId) return
        void this.send('Page.screencastFrameAck', { sessionId: params.sessionId }, message.sessionId).catch(() => undefined)
        const metadata = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number }
        const page = this.current ? this.pages.get(this.current) : undefined
        this.last = { data: String(params.data), url: page?.url, title: page?.title, width: metadata.deviceWidth, height: metadata.deviceHeight }
        for (const listener of this.listeners) listener({ type: 'frame', frame: this.last })
        return
      }
    }
  }

  private focus(targetId: string | undefined): void {
    this.current = targetId
    void this.restream()
    this.announceTabs()
  }

  tabs(): ILiveBrowserTabs {
    return { tabs: [...this.pages.values()].map((page) => ({ id: page.targetId, title: page.title, url: page.url })), current: this.current }
  }

  /** As abas mudaram (abriu, fechou, trocou de endereço ou de foco): avisa quem olha. */
  private announceTabs(): void {
    const tabs = this.tabs()
    for (const listener of this.listeners) listener({ type: 'tabs', ...tabs })
  }

  /** Liga a transmissão na aba em uso (e desliga da anterior), só com alguém olhando. */
  private async restream(): Promise<void> {
    const want = this.listeners.size ? this.current : undefined
    if (this.attached?.targetId === want) return
    const previous = this.attached
    this.attached = undefined
    if (previous) await this.send('Target.detachFromTarget', { sessionId: previous.sessionId }).catch(() => undefined)
    if (!want || this.closed) return
    try {
      const { sessionId } = (await this.send('Target.attachToTarget', { targetId: want, flatten: true })) as { sessionId: string }
      if (this.current !== want || !this.listeners.size) return void (await this.send('Target.detachFromTarget', { sessionId }).catch(() => undefined))
      this.attached = { targetId: want, sessionId }
      await this.send('Page.enable', {}, sessionId)
      await this.applyViewport(sessionId)
    } catch {
      // A aba fechou no meio: a próxima mudança tenta de novo.
    }
  }

  /**
   * ⚖️ O tamanho vale só enquanto a tela está ligada a esta aba: a sessão CDP que o aplicou é a da transmissão, e o
   * override cai junto quando ela solta a aba (ninguém olhando, ou outra aba) — o agente volta ao tamanho de sempre.
   */
  private async applyViewport(sessionId: string): Promise<void> {
    const viewport = this.viewport
    if (viewport) {
      await this.send(
        'Emulation.setDeviceMetricsOverride',
        { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: viewport.width < 768 },
        sessionId,
      )
    }
    await this.send('Page.stopScreencast', {}, sessionId).catch(() => undefined)
    const limit = viewport ? { maxWidth: Math.round(viewport.width * viewport.scale), maxHeight: Math.round(viewport.height * viewport.scale) } : {}
    await this.send('Page.startScreencast', { ...SCREENCAST, ...limit }, sessionId)
  }

  async setViewport(viewport: ILiveBrowserViewport): Promise<void> {
    this.viewport = viewport
    if (this.attached) await this.applyViewport(this.attached.sessionId).catch(() => undefined)
  }

  /** 🖱️ O clique, a rolagem e o teclado da pessoa, na aba que a tela mostra. */
  /**
   * ⌨️ O clique caiu num campo de texto? A tela do celular só abre o teclado quando a pessoa pede (o iPhone abre o teclado
   * a cada foco); com isto, o botão do teclado acende quando a página espera texto.
   */
  private async focusedEditable(sid: string): Promise<boolean> {
    const expression =
      "(() => { let e = document.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement; if (!e) return false; if (e.isContentEditable) return true; if (e.tagName === 'TEXTAREA') return !e.readOnly && !e.disabled; if (e.tagName !== 'INPUT') return false; return !e.readOnly && !e.disabled && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(e.type) })()"
    const result = (await this.send('Runtime.evaluate', { expression, returnByValue: true }, sid, INPUT_TIMEOUT_MS).catch(() => undefined)) as
      { result?: { value?: unknown } } | undefined
    return result?.result?.value === true
  }

  async input(event: TLiveBrowserInput): Promise<{ editable?: boolean } | void> {
    this.touchedAt = Date.now()
    // As abas não dependem da aba à mostra.
    if (event.type === 'tab-select') {
      if (!this.pages.has(event.targetId)) throw new Error('tab not found')
      await this.send('Target.activateTarget', { targetId: event.targetId }, undefined, INPUT_TIMEOUT_MS).catch(() => undefined)
      return this.focus(event.targetId)
    }
    if (event.type === 'tab-new') {
      await this.send('Target.createTarget', { url: event.url ?? 'about:blank' }, undefined, INPUT_TIMEOUT_MS)
      return
    }
    if (event.type === 'tab-close') {
      if (!this.pages.has(event.targetId)) throw new Error('tab not found')
      await this.send('Target.closeTarget', { targetId: event.targetId }, undefined, INPUT_TIMEOUT_MS)
      return
    }
    const target = this.attached
    if (!target) throw new Error('nobody is watching this browser')
    const sid = target.sessionId
    // ⏱️ Cada comando de entrada com tempo limite curto: um evento que a aba não confirma não trava os seguintes.
    const command = (method: string, params: Record<string, unknown>) => this.send(method, params, sid, INPUT_TIMEOUT_MS)
    const mouse = (params: Record<string, unknown>) => command('Input.dispatchMouseEvent', params)
    switch (event.type) {
      case 'move':
        await mouse({ type: 'mouseMoved', x: event.x, y: event.y })
        return
      case 'click': {
        const button = event.button ?? 'left'
        const clickCount = event.clickCount ?? 1
        const modifiers = event.modifiers ?? 0
        await mouse({ type: 'mouseMoved', x: event.x, y: event.y, modifiers })
        await mouse({ type: 'mousePressed', x: event.x, y: event.y, button, clickCount, modifiers })
        await mouse({ type: 'mouseReleased', x: event.x, y: event.y, button, clickCount, modifiers })
        return { editable: await this.focusedEditable(sid) }
      }
      case 'wheel':
        // 🛞 Sem esperar: o CDP só confirma a rolagem depois que o compositor a desenha, e a aba sem desenhar (em segundo
        // plano) nunca confirma. A rolagem é disparada e a resposta sai na hora; erro só no log.
        void mouse({ type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY }).catch((error: unknown) =>
          console.warn('[LiveBrowser] wheel:', error instanceof Error ? error.message : error),
        )
        return
      case 'text':
        await command('Input.insertText', { text: event.text })
        return
      case 'reload':
        await command('Page.reload', {})
        return
      case 'navigate':
        await command('Page.navigate', { url: event.url })
        return
      case 'back':
      case 'forward': {
        const history = (await command('Page.getNavigationHistory', {})) as { currentIndex: number; entries: Array<{ id: number }> }
        const entry = history.entries[history.currentIndex + (event.type === 'back' ? -1 : 1)]
        if (entry) await command('Page.navigateToHistoryEntry', { entryId: entry.id })
        return
      }
      case 'key': {
        const base = { key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, nativeVirtualKeyCode: event.keyCode, modifiers: event.modifiers ?? 0 }
        await command('Input.dispatchKeyEvent', {
          ...base,
          type: event.text ? 'keyDown' : 'rawKeyDown',
          ...(event.text ? { text: event.text, unmodifiedText: event.text } : {}),
        })
        await command('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
        return
      }
    }
  }

  /** 🎯 O elemento sob o ponto (pixels CSS da aba). `undefined`: nada ali. */
  async inspect(x: number, y: number): Promise<ILiveBrowserElement | undefined> {
    const target = this.attached
    if (!target) throw new Error('nobody is watching this browser')
    const result = (await this.send('Runtime.evaluate', { expression: INSPECT(Math.round(x), Math.round(y)), returnByValue: true }, target.sessionId)) as {
      result?: { value?: ILiveBrowserElement | null }
    }
    return result.result?.value ?? undefined
  }

  watch(listener: TLiveBrowserListener): () => void {
    this.listeners.add(listener)
    this.touchedAt = Date.now()
    listener({ type: 'tabs', ...this.tabs() })
    if (this.last) listener({ type: 'frame', frame: this.last })
    void this.restream()
    return () => {
      this.listeners.delete(listener)
      this.touchedAt = Date.now()
      if (!this.listeners.size) this.viewport = undefined
      void this.restream()
    }
  }

  get alive(): boolean {
    return !this.closed
  }

  /** Quantas telas olham agora. */
  get watchers(): number {
    return this.listeners.size
  }

  /** O MCP passa a usar este navegador (adoção) ou larga. */
  lease(): void {
    this.leases += 1
    this.touchedAt = Date.now()
  }

  release(): void {
    this.leases = Math.max(0, this.leases - 1)
    this.touchedAt = Date.now()
  }

  /** Roda quando o navegador fecha (qualquer motivo). */
  onClosed(hook: () => void): void {
    if (this.closed) hook()
    else this.closeHooks.push(hook)
  }

  /**
   * Leva a aba ao endereço. ⚖️ Com a tela ligada, na aba à mostra; sem ela não há sessão na aba, então abre uma aba
   * nova (que vira a em uso).
   */
  async navigate(url: string): Promise<void> {
    this.touchedAt = Date.now()
    if (this.attached) {
      await this.input({ type: 'navigate', url })
      return
    }
    await this.send('Target.createTarget', { url })
  }

  private dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const call of this.calls.values()) call.reject(new Error('browser closed'))
    this.calls.clear()
    for (const listener of this.listeners) listener({ type: 'state', live: false })
    for (const hook of this.closeHooks.splice(0)) {
      try {
        hook()
      } catch {
        // o gancho de limpeza não derruba o fechamento
      }
    }
  }

  async close(): Promise<void> {
    this.dispose()
    try {
      this.ws?.close()
    } catch {
      // já fechado
    }
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill('SIGKILL')
          resolve()
        }, 3000)
        this.child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
}

/**
 * Os navegadores ao vivo, por conversa. Quem assiste antes de o navegador abrir fica esperando: ele aparece quando o
 * agente usa o MCP pela primeira vez.
 */
export class LiveBrowsers {
  private readonly browsers = new Map<string, LiveBrowser>()
  private readonly waiting = new Map<string, Set<TLiveBrowserListener>>()
  private readonly unwatch = new Map<TLiveBrowserListener, () => void>()

  register(sessionId: string, browser: LiveBrowser): void {
    this.browsers.set(sessionId, browser)
    for (const listener of this.waiting.get(sessionId) ?? []) this.attach(sessionId, listener)
  }

  unregister(sessionId: string, browser: LiveBrowser): void {
    if (this.browsers.get(sessionId) === browser) this.browsers.delete(sessionId)
  }

  get(sessionId: string): LiveBrowser | undefined {
    const browser = this.browsers.get(sessionId)
    return browser?.alive ? browser : undefined
  }

  has(sessionId: string): boolean {
    return !!this.browsers.get(sessionId)?.alive
  }

  private attach(sessionId: string, listener: TLiveBrowserListener): void {
    const browser = this.browsers.get(sessionId)
    if (!browser?.alive) return
    this.unwatch.get(listener)?.()
    listener({ type: 'state', live: true })
    this.unwatch.set(
      listener,
      browser.watch((event) => {
        listener(event)
        // Fechou (ociosidade, fim da conversa): volta a esperar o próximo.
        if (event.type === 'state' && !event.live) this.unwatch.delete(listener)
      }),
    )
  }

  watch(sessionId: string, listener: TLiveBrowserListener): () => void {
    const set = this.waiting.get(sessionId) ?? new Set()
    set.add(listener)
    this.waiting.set(sessionId, set)
    if (this.has(sessionId)) this.attach(sessionId, listener)
    else listener({ type: 'state', live: false })
    return () => {
      set.delete(listener)
      if (!set.size) this.waiting.delete(sessionId)
      this.unwatch.get(listener)?.()
      this.unwatch.delete(listener)
    }
  }
}

let shared: LiveBrowsers | undefined
export const liveBrowsers = (): LiveBrowsers => (shared ??= new LiveBrowsers())

/** Desligado com `GATEWAY_LIVE_BROWSER=0`: o Playwright MCP abre o navegador dele, como antes. */
export const liveBrowserEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.GATEWAY_LIVE_BROWSER !== '0'
