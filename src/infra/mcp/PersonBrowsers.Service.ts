import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from '@infra/http/Http.Error'
import { isAlwaysBlockedHost } from '@domain/Url.Policy'
import { BrowserProfiles, browserProfiles, IBrowserProfileOwner } from './BrowserProfiles.Service'
import { LiveBrowser, liveBrowserEnabled, liveBrowsers, LiveBrowsers } from './LiveBrowser.Adapter'

/** Como abrir o Chromium: o executável, o sandbox e o ambiente. */
export interface IBrowserLaunch {
  executable: string
  noSandbox: boolean
  env: NodeJS.ProcessEnv
}

export interface IPersonBrowsersOptions {
  /** Onde achar o Chromium (o do Playwright MCP instalado, ou o do sistema). `undefined`: nenhum. */
  resolve: () => IBrowserLaunch | undefined
  /** Quem abre o Chromium: injetável, para o teste não abrir um de verdade. */
  launch?: (options: { executable: string; userDataDir: string; noSandbox?: boolean; env?: NodeJS.ProcessEnv; url?: string }) => Promise<LiveBrowser>
  desk?: LiveBrowsers
  enabled?: () => boolean
  /** Sem tela e sem MCP por este tempo, o navegador da pessoa fecha. */
  idleMs?: number
  /** De quanto em quanto tempo a ociosidade é conferida. */
  sweepMs?: number
  now?: () => number
  tmp?: string
  remove?: (path: string) => void
  /** Os perfis guardados (o agente que guarda o login): o MESMO do MCP. Padrão: o do processo. */
  profiles?: BrowserProfiles
}

const MINUTE = 60_000
/** O nome da pasta do navegador: só letras, números, `-` e `_` (o id da conversa nunca sai do tmpdir). */
const safe = (sessionId: string): string => sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)

/**
 * O endereço que a pessoa digitou, conferido: sem esquema vira `https://`; só http(s).
 * ⛔ Metadado de nuvem, link-local, loopback e `localhost` não abrem (a mesma política dos endereços de aviso).
 */
export function personBrowserUrl(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || raw.length > 4000) throw new HttpError(422, 'validation_error', 'url must be a string up to 4000 characters')
  const text = raw.trim()
  const full = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(full)
  } catch {
    throw new HttpError(422, 'validation_error', 'url is not a valid address')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(422, 'validation_error', 'only http and https addresses open in the browser')
  if (isAlwaysBlockedHost(url.hostname)) throw new HttpError(422, 'url_blocked', 'this address is not allowed in the browser')
  return url.href
}

/**
 * 🙋 O NAVEGADOR QUE A PESSOA ABRE (a tela), antes de o agente usar o Playwright: o mesmo `LiveBrowser` da conversa, na
 * mesma mesa (`liveBrowsers()`), então o MCP que subir depois ADOTA este navegador (mesmo login, mesmos cookies).
 *
 * ⚖️ Fecha sozinho quando ninguém olha e nenhum MCP usa por `idleMs` (10 min): a pasta do perfil temporário some junto (o perfil guardado do agente fica, ver `BrowserProfiles`).
 * Um navegador que o MCP abriu não é da pessoa: ela não o fecha enquanto o MCP vive.
 */
export class PersonBrowsers {
  private readonly desk: LiveBrowsers
  private readonly launcher: NonNullable<IPersonBrowsersOptions['launch']>
  private readonly mine = new Map<string, LiveBrowser>()
  private readonly opening = new Map<string, Promise<void>>()
  private timer?: NodeJS.Timeout

  constructor(private readonly options: IPersonBrowsersOptions) {
    this.desk = options.desk ?? liveBrowsers()
    this.launcher = options.launch ?? ((launch) => LiveBrowser.launch(launch))
  }

  private get idleMs(): number {
    return this.options.idleMs ?? 10 * MINUTE
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Abre (ou só leva ao endereço, se já há navegador na conversa). */
  async open(sessionId: string, rawUrl?: unknown, owner?: IBrowserProfileOwner): Promise<void> {
    if (!(this.options.enabled ?? liveBrowserEnabled)()) throw new HttpError(409, 'browser_disabled', 'The live browser is turned off on this server')
    const url = personBrowserUrl(rawUrl)
    // Dois pedidos juntos abrem UM navegador: a conferência e o registro do pedido em curso são síncronos.
    const pending = this.opening.get(sessionId)
    if (pending) await pending
    const existing = this.desk.get(sessionId)
    if (existing) {
      if (url) await existing.navigate(url)
      return
    }
    const job = this.launchFor(sessionId, url, owner)
    this.opening.set(sessionId, job)
    try {
      await job
    } finally {
      this.opening.delete(sessionId)
    }
  }

  private async launchFor(sessionId: string, url: string | undefined, owner?: IBrowserProfileOwner): Promise<void> {
    const how = this.options.resolve()
    if (!how) throw new HttpError(409, 'browser_unavailable', 'No browser is installed on this server (install the Playwright MCP or Chromium)')
    const temp = join(this.options.tmp ?? tmpdir(), `gw-browser-${safe(sessionId)}`)
    // 🌐 O agente que guarda o login: a pessoa entra no site AQUI e vale para ele (o mesmo perfil do MCP).
    const profile = (this.options.profiles ?? browserProfiles()).acquire(sessionId, temp, owner)
    const userDataDir = profile.userDataDir
    const removeTemp = this.options.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }))
    // ⛔ O perfil guardado nunca é apagado ao fechar: só se larga (a cópia, essa sim, some).
    const remove = (path: string) => (profile.kind === 'temp' ? removeTemp(path) : profile.release())
    let browser: LiveBrowser
    try {
      browser = await this.launcher({ executable: how.executable, userDataDir, noSandbox: how.noSandbox, env: how.env.HOME ? how.env : { ...how.env, HOME: userDataDir }, url })
    } catch (error: unknown) {
      remove(userDataDir)
      console.warn('[PersonBrowsers] the browser did not open:', error instanceof Error ? error.message : error)
      throw new HttpError(409, 'browser_unavailable', 'The browser could not be started on this server')
    }
    browser.person = true
    browser.touchedAt = this.now()
    this.mine.set(sessionId, browser)
    browser.onClosed(() => {
      this.desk.unregister(sessionId, browser)
      if (this.mine.get(sessionId) === browser) this.mine.delete(sessionId)
      remove(userDataDir)
    })
    this.desk.register(sessionId, browser)
    this.startSweeper()
  }

  /** Fecha o navegador da pessoa. 409: não é dela, ou um MCP está usando agora. */
  async close(sessionId: string): Promise<boolean> {
    const browser = this.desk.get(sessionId)
    if (!browser) return false
    if (!browser.person || browser.leases > 0) throw new HttpError(409, 'browser_in_use', 'The agent is using this browser; it closes when the agent is done')
    await browser.close()
    return true
  }

  /** A conversa acabou: o navegador da pessoa vai junto (o do MCP fecha com o MCP). */
  async closeFor(sessionId: string): Promise<void> {
    const browser = this.mine.get(sessionId)
    if (browser?.person && browser.leases === 0) await browser.close()
  }

  /** Fecha os da pessoa sem tela e sem MCP há `idleMs`. Devolve quantos fechou. */
  async sweep(): Promise<number> {
    const now = this.now()
    const idle = [...this.mine.values()].filter((browser) => browser.alive && browser.watchers === 0 && browser.leases === 0 && now - browser.touchedAt >= this.idleMs)
    await Promise.all(idle.map((browser) => browser.close()))
    return idle.length
  }

  private startSweeper(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), this.options.sweepMs ?? 30_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
