import assert from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { LiveBrowser, LiveBrowsers } from './LiveBrowser.Adapter'
import { BrowserProfiles, IBrowserProfileOwner } from './BrowserProfiles.Service'
import { PersonBrowsers } from './PersonBrowsers.Service'

let base: string
let root: string
let tmp: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gw-profiles-test-'))
  root = join(base, 'data', 'browser-profiles')
  tmp = join(base, 'tmp')
  mkdirSync(tmp)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const make = (owners: Record<string, IBrowserProfileOwner>) => {
  const profiles = new BrowserProfiles({ root: () => root, tmp: () => tmp })
  profiles.useOwner((sessionId) => owners[sessionId])
  return profiles
}

const theo = (projectId?: string): IBrowserProfileOwner => ({ agentId: 'theo', ...(projectId ? { projectId } : {}), keepLogin: true })

describe('BrowserProfiles — o perfil guardado do navegador', () => {
  it('desligado (ou conversa desconhecida): a pasta temporária de sempre, que o chamador apaga', () => {
    const profiles = make({ s1: { agentId: 'theo', projectId: 'alfa', keepLogin: false } })
    for (const id of ['s1', 'nenhuma']) {
      const profile = profiles.acquire(id, '/tmp/x/.browser')
      assert.equal(profile.kind, 'temp')
      assert.equal(profile.userDataDir, '/tmp/x/.browser')
      profile.release()
    }
    assert.equal(existsSync(root), false)
  })

  it('ligado: um perfil fixo por agente e por projeto (0700), que fica ao largar e volta na próxima conversa', () => {
    const profiles = make({ s1: theo('alfa'), s2: theo('alfa'), s3: theo('beta'), s4: theo() })
    const first = profiles.acquire('s1', '/t/1')
    assert.equal(first.kind, 'fixed')
    assert.equal(first.userDataDir, join(root, 'theo', 'alfa'))
    assert.equal(statSync(first.userDataDir).mode & 0o777, 0o700)
    assert.equal(statSync(root).mode & 0o777, 0o700)
    writeFileSync(join(first.userDataDir, 'Cookies'), 'login')
    first.release()
    first.release()
    assert.equal(readFileSync(join(root, 'theo', 'alfa', 'Cookies'), 'utf8'), 'login')

    const again = profiles.acquire('s2', '/t/2')
    assert.equal(again.kind, 'fixed')
    assert.equal(again.userDataDir, first.userDataDir)
    assert.equal(profiles.acquire('s3', '/t/3').userDataDir, join(root, 'theo', 'beta'))
    assert.equal(profiles.acquire('s4', '/t/4').userDataDir, join(root, 'theo', '_'))
  })

  it('o id não escapa da pasta dos perfis', () => {
    const profiles = make({ s1: { agentId: '../../etc', projectId: '../x', keepLogin: true } })
    assert.equal(profiles.acquire('s1', '/t').userDataDir, join(root, '______etc', '___x'))
  })

  it('apaga as travas de um Chromium que já fechou (outro host no pod novo, ou um que caiu)', () => {
    const dir = join(root, 'theo', 'alfa')
    mkdirSync(dir, { recursive: true })
    symlinkSync('outro-host-123', join(dir, 'SingletonLock'))
    writeFileSync(join(dir, 'DevToolsActivePort'), '9999\n/devtools/browser/velho')
    writeFileSync(join(dir, 'Cookies'), 'login')
    make({ s1: theo('alfa') }).acquire('s1', '/t')
    assert.equal(existsSync(join(dir, 'DevToolsActivePort')), false)
    assert.throws(() => statSync(join(dir, 'SingletonLock')))
    assert.equal(readFileSync(join(dir, 'Cookies'), 'utf8'), 'login')
  })

  it('em uso por outra conversa: a segunda ganha uma cópia temporária sem caches, apagada ao largar', () => {
    const profiles = make({ s1: theo('alfa'), s2: theo('alfa') })
    const first = profiles.acquire('s1', '/t/1')
    mkdirSync(join(first.userDataDir, 'Default', 'Cache'), { recursive: true })
    writeFileSync(join(first.userDataDir, 'Default', 'Cache', 'data_0'), 'x'.repeat(100))
    writeFileSync(join(first.userDataDir, 'Default', 'Cookies'), 'login')
    symlinkSync('host-1', join(first.userDataDir, 'SingletonLock'))

    const second = profiles.acquire('s2', '/t/2')
    assert.equal(second.kind, 'copy')
    assert.ok(second.userDataDir.startsWith(tmp))
    assert.equal(statSync(second.userDataDir).mode & 0o777, 0o700)
    assert.equal(readFileSync(join(second.userDataDir, 'Default', 'Cookies'), 'utf8'), 'login')
    assert.equal(existsSync(join(second.userDataDir, 'Default', 'Cache')), false)
    assert.throws(() => statSync(join(second.userDataDir, 'SingletonLock')))

    // O login feito na cópia não volta para o guardado; a cópia some.
    writeFileSync(join(second.userDataDir, 'Default', 'Cookies'), 'outro')
    second.release()
    assert.equal(existsSync(second.userDataDir), false)
    assert.equal(readFileSync(join(first.userDataDir, 'Default', 'Cookies'), 'utf8'), 'login')

    // Largado o primeiro, o próximo volta ao fixo.
    first.release()
    assert.equal(profiles.acquire('s2', '/t/3').kind, 'fixed')
  })

  it('limpar: recusa com o perfil aberto; apaga o do projeto ou, com `null`, os de todos', () => {
    const profiles = make({ s1: theo('alfa'), s2: theo('beta') })
    const alfa = profiles.acquire('s1', '/t/1')
    const beta = profiles.acquire('s2', '/t/2')
    assert.equal(profiles.clear('theo', 'alfa'), false)
    assert.equal(profiles.clear('theo', null), false)
    alfa.release()
    assert.equal(profiles.clear('theo', 'alfa'), true)
    assert.equal(existsSync(join(root, 'theo', 'alfa')), false)
    assert.equal(existsSync(join(root, 'theo', 'beta')), true)
    assert.equal(profiles.clear('theo', null), false)
    beta.release()
    assert.equal(profiles.clear('theo', null), true)
    assert.equal(existsSync(join(root, 'theo')), false)
    // Nada guardado: limpar não é erro.
    assert.equal(profiles.clear('ninguem', 'alfa'), true)
  })
})

/** Um navegador de mentira: o teste nunca abre um Chromium de verdade. */
class FakeBrowser {
  person = false
  leases = 0
  touchedAt = 0
  watchers = 0
  private hooks: Array<() => void> = []
  alive = true
  readonly endpoint = 'http://127.0.0.1:9'
  lease() {
    this.leases += 1
  }
  release() {}
  onClosed(hook: () => void) {
    this.hooks.push(hook)
  }
  async navigate() {}
  async close() {
    this.alive = false
    for (const hook of this.hooks.splice(0)) hook()
  }
}

describe('PersonBrowsers com perfil guardado — a pessoa entra no site e vale para o agente', () => {
  it('abre no perfil do agente (o dono vem da rota), não apaga ao fechar e solta a trava', async () => {
    const profiles = make({})
    const launched: string[] = []
    const removed: string[] = []
    const fakes: FakeBrowser[] = []
    const service = new PersonBrowsers({
      desk: new LiveBrowsers(),
      resolve: () => ({ executable: '/fake/chrome', noSandbox: true, env: { HOME: '/h' } }),
      launch: async (options) => {
        launched.push(options.userDataDir)
        const fake = new FakeBrowser()
        fakes.push(fake)
        return fake as unknown as LiveBrowser
      },
      enabled: () => true,
      tmp: tmp,
      remove: (path) => removed.push(path),
      profiles,
    })
    await service.open('s1', undefined, theo('alfa'))
    assert.deepEqual(launched, [join(root, 'theo', 'alfa')])
    assert.equal(profiles.inUse('theo', 'alfa'), true)
    assert.equal(profiles.clear('theo', 'alfa'), false)
    await service.close('s1')
    assert.deepEqual(removed, [])
    assert.equal(existsSync(join(root, 'theo', 'alfa')), true)
    assert.equal(profiles.inUse('theo', 'alfa'), false)

    // Desligado: o temporário de sempre, apagado ao fechar.
    await service.open('s2', undefined, { agentId: 'theo', projectId: 'alfa', keepLogin: false })
    assert.equal(launched[1], join(tmp, 'gw-browser-s2'))
    await service.close('s2')
    assert.deepEqual(removed, [join(tmp, 'gw-browser-s2')])
  })
})
