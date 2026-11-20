import assert from 'node:assert'
import { describe, it } from 'node:test'
import { HttpError } from '@infra/http/Http.Error'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { LiveBrowser, LiveBrowsers, liveBrowsers, systemChromium } from './LiveBrowser.Adapter'
import { McpRegistry } from './Mcp.Registry'
import { PersonBrowsers, personBrowserUrl } from './PersonBrowsers.Service'

/** Um navegador de mentira: o teste nunca abre um Chromium de verdade. */
class FakeBrowser {
  person = false
  leases = 0
  touchedAt = 0
  watchers = 0
  closedTimes = 0
  readonly navigated: string[] = []
  private hooks: Array<() => void> = []
  private open = true
  constructor(readonly endpoint = 'http://127.0.0.1:9') {}
  get alive() {
    return this.open
  }
  lease() {
    this.leases += 1
  }
  release() {
    this.leases = Math.max(0, this.leases - 1)
  }
  onClosed(hook: () => void) {
    this.hooks.push(hook)
  }
  async navigate(url: string) {
    this.navigated.push(url)
  }
  watch() {
    return () => undefined
  }
  async close() {
    this.closedTimes += 1
    this.open = false
    for (const hook of this.hooks.splice(0)) hook()
  }
}

const asBrowser = (fake: FakeBrowser) => fake as unknown as LiveBrowser

function setup(over: { now?: () => number; enabled?: boolean; resolve?: () => ReturnType<ConstructorParameters<typeof PersonBrowsers>[0]['resolve']> } = {}) {
  const desk = new LiveBrowsers()
  const launched: Array<{ userDataDir: string; url?: string; noSandbox?: boolean }> = []
  const fakes: FakeBrowser[] = []
  const removed: string[] = []
  const service = new PersonBrowsers({
    desk,
    resolve: over.resolve ?? (() => ({ executable: '/fake/chrome', noSandbox: true, env: { HOME: '/h' } })),
    launch: async (options) => {
      launched.push({ userDataDir: options.userDataDir, url: options.url, noSandbox: options.noSandbox })
      const fake = new FakeBrowser()
      fakes.push(fake)
      return asBrowser(fake)
    },
    enabled: () => over.enabled ?? true,
    idleMs: 10 * 60_000,
    now: over.now,
    tmp: '/tmp-fake',
    remove: (path) => removed.push(path),
  })
  return { service, desk, launched, fakes, removed }
}

const code = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run()
  } catch (error: unknown) {
    return error instanceof HttpError ? error.code : String(error)
  }
  return undefined
}

describe('PersonBrowsers — o navegador que a pessoa abre', () => {
  it('abre uma vez, registra na mesa e marca como da pessoa; o segundo pedido só navega', async () => {
    const { service, desk, launched, fakes } = setup()
    await service.open('s1', 'example.com/login')
    assert.equal(launched.length, 1)
    assert.equal(launched[0].url, 'https://example.com/login')
    assert.equal(launched[0].noSandbox, true)
    assert.equal(launched[0].userDataDir, '/tmp-fake/gw-browser-s1')
    assert.equal(desk.has('s1'), true)
    assert.equal(fakes[0].person, true)

    await service.open('s1', 'https://outro.test/')
    assert.equal(launched.length, 1)
    assert.deepEqual(fakes[0].navigated, ['https://outro.test/'])
    service.stop()
  })

  it('dois pedidos juntos abrem UM navegador', async () => {
    const { service, launched } = setup()
    await Promise.all([service.open('s1'), service.open('s1')])
    assert.equal(launched.length, 1)
    service.stop()
  })

  it('com um navegador do MCP já aberto, só navega (não abre outro)', async () => {
    const { service, desk, launched } = setup()
    const mcp = new FakeBrowser()
    mcp.leases = 1
    desk.register('s1', asBrowser(mcp))
    await service.open('s1', 'https://a.test')
    assert.equal(launched.length, 0)
    assert.deepEqual(mcp.navigated, ['https://a.test/'])
  })

  it('⛔ endereço bloqueado ou de outro esquema não abre', async () => {
    const { service, launched } = setup()
    assert.equal(await code(() => service.open('s1', 'http://169.254.169.254/latest/meta-data')), 'url_blocked')
    assert.equal(await code(() => service.open('s1', 'http://metadata.google.internal/')), 'url_blocked')
    assert.equal(await code(() => service.open('s1', 'file:///etc/passwd')), 'validation_error')
    assert.equal(await code(() => service.open('s1', 'javascript:alert(1)')), 'validation_error')
    assert.equal(launched.length, 0)
    assert.equal(personBrowserUrl(undefined), undefined)
    assert.equal(personBrowserUrl('  example.com '), 'https://example.com/')
  })

  it('desligado ou sem navegador instalado: 409 com código claro', async () => {
    assert.equal(await code(() => setup({ enabled: false }).service.open('s1')), 'browser_disabled')
    assert.equal(await code(() => setup({ resolve: () => undefined }).service.open('s1')), 'browser_unavailable')
  })

  it('falha ao abrir: browser_unavailable e a pasta do perfil some', async () => {
    const desk = new LiveBrowsers()
    const removed: string[] = []
    const service = new PersonBrowsers({
      desk,
      resolve: () => ({ executable: '/x', noSandbox: false, env: {} }),
      launch: async () => {
        throw new Error('boom')
      },
      tmp: '/t',
      remove: (path) => removed.push(path),
    })
    assert.equal(await code(() => service.open('s1')), 'browser_unavailable')
    assert.deepEqual(removed, ['/t/gw-browser-s1'])
  })

  it('o id da conversa não escapa do tmpdir', async () => {
    const { service, launched } = setup()
    await service.open('../../etc/x', undefined)
    assert.equal(launched[0].userDataDir, '/tmp-fake/gw-browser-______etc_x')
    service.stop()
  })

  it('fecha por ociosidade: sem tela e sem MCP por 10 min; apaga a pasta e sai da mesa', async () => {
    let clock = 1_000
    const { service, desk, fakes, removed } = setup({ now: () => clock })
    await service.open('s1')
    clock += 9 * 60_000
    assert.equal(await service.sweep(), 0)
    clock += 2 * 60_000
    assert.equal(await service.sweep(), 1)
    assert.equal(fakes[0].closedTimes, 1)
    assert.equal(desk.has('s1'), false)
    assert.deepEqual(removed, ['/tmp-fake/gw-browser-s1'])
    service.stop()
  })

  it('não fecha enquanto alguém olha ou um MCP usa', async () => {
    let clock = 1_000
    const { service, fakes } = setup({ now: () => clock })
    await service.open('s1')
    clock += 60 * 60_000
    fakes[0].watchers = 1
    assert.equal(await service.sweep(), 0)
    fakes[0].watchers = 0
    fakes[0].leases = 1
    assert.equal(await service.sweep(), 0)
    fakes[0].leases = 0
    assert.equal(await service.sweep(), 1)
    service.stop()
  })

  it('close: fecha o da pessoa; 409 para o do MCP e para o da pessoa que o MCP usa', async () => {
    const { service, desk, fakes } = setup()
    await service.open('s1')
    fakes[0].leases = 1
    assert.equal(await code(() => service.close('s1')), 'browser_in_use')
    fakes[0].leases = 0
    assert.equal(await service.close('s1'), true)
    assert.equal(desk.has('s1'), false)
    assert.equal(await service.close('s1'), false)

    const mcp = new FakeBrowser()
    desk.register('s2', asBrowser(mcp))
    assert.equal(await code(() => service.close('s2')), 'browser_in_use')
    assert.equal(mcp.closedTimes, 0)
  })

  it('closeFor (conversa apagada) fecha o da pessoa', async () => {
    const { service, desk } = setup()
    await service.open('s1')
    await service.closeFor('s1')
    assert.equal(desk.has('s1'), false)
  })
})

describe('McpRegistry — adoção do navegador da pessoa', () => {
  const registry = () => new McpRegistry(new SqliteMcpServerRepository(':memory:'), { get: () => undefined })
  const config = {
    id: 'playwright',
    name: 'PW',
    url: '',
    transport: 'auto',
    auth: 'none',
    enabled: true,
    process: { package: '@playwright/mcp', args: ['--headless'] },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  type TPrivate = {
    openLiveBrowser(config: unknown, sessionId: string, cwd: string, env: Record<string, string>): Promise<{ browser: LiveBrowser; launched: boolean } | undefined>
    dropBrowser(sessionId: string, opened: { browser: LiveBrowser; launched: boolean } | undefined): Promise<void>
  }

  it('reusa o navegador vivo da conversa, sem abrir outro; o cleanup do MCP só larga', async () => {
    const person = new FakeBrowser()
    person.person = true
    liveBrowsers().register('adopt-1', asBrowser(person))
    const internals = registry() as unknown as TPrivate
    const opened = await internals.openLiveBrowser(config, 'adopt-1', '/x', {})
    assert.equal(opened?.launched, false)
    assert.equal(opened?.browser, asBrowser(person))
    assert.equal(person.leases, 1)

    await internals.dropBrowser('adopt-1', opened)
    assert.equal(person.closedTimes, 0)
    assert.equal(person.leases, 0)
    assert.equal(liveBrowsers().has('adopt-1'), true)
    liveBrowsers().unregister('adopt-1', asBrowser(person))
  })

  it('o navegador que o próprio MCP abriu fecha no cleanup', async () => {
    const own = new FakeBrowser()
    liveBrowsers().register('adopt-2', asBrowser(own))
    await (registry() as unknown as TPrivate).dropBrowser('adopt-2', { browser: asBrowser(own), launched: true })
    assert.equal(own.closedTimes, 1)
    assert.equal(liveBrowsers().has('adopt-2'), false)
  })
})

describe('systemChromium', () => {
  it('acha pelo PATH, e depois pelos caminhos conhecidos', () => {
    assert.equal(
      systemChromium({ PATH: '/a:/b' }, (path) => path === '/b/chromium'),
      '/b/chromium',
    )
    assert.equal(
      systemChromium({ PATH: '' }, (path) => path === '/usr/bin/chromium'),
      '/usr/bin/chromium',
    )
    assert.equal(
      systemChromium({ PATH: '/a' }, () => false),
      undefined,
    )
  })
})
