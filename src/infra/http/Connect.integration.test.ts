import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAgents } from '@composition/factories/Agents.Factory'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeLedger } from '@composition/factories/Ledger.Factory'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import {
  makeAuthController,
  makeConnectController,
  makeController,
  makeGuidanceController,
  makeProjectsController,
  makeProvidersController,
} from '@composition/factories/Controller.Factory'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TEnvelope = { ok: boolean; result?: any; details?: any }

/**
 * 🔌 A ORIGEM DE UM PROJETO CONECTADO de ponta a ponta: o membro cria o token de conexão, o outro gateway lê a versão, o
 * pacote, os arquivos e o aviso de mudança — e o token não abre mais nada.
 */
describe('projeto conectado: a origem (/connect)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let ana = ''
  let bob = ''
  let anaId = ''
  let rootId = ''
  let connection = ''
  let sha = ''

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return { status: res.status, body: (await res.json()) as TEnvelope }
  }
  const login = async (email: string) => (await call('/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.result.token as string

  before(async () => {
    const u = undefined
    const server = new HttpServer(
      makeController(),
      makeAuthController(),
      makeProvidersController(),
      u,
      u,
      u,
      u,
      u,
      makeProjectsController(),
      makeGuidanceController(),
      u,
      u,
      u,
      u,
      u,
      u,
      u,
      u,
      u,
      makeConnectController(),
    ).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
    const setup = (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })).body
      .result
    admin = setup.token
    rootId = setup.user.id
    anaId = (await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })).body.result.id
    await call('/users', { method: 'POST', token: admin, body: { email: 'bob@x.test', name: 'Bob', password: PASSWORD } })
    ana = await login('ana@x.test')
    bob = await login('bob@x.test')

    assert.strictEqual((await call('/projects', { method: 'POST', token: admin, body: { id: 'logiccus', name: 'Logiccus' } })).status, 201)
    const members = await call('/projects/logiccus/members', {
      method: 'PUT',
      token: admin,
      body: {
        members: [
          { userId: rootId, role: 'admin' },
          { userId: anaId, role: 'member' },
        ],
      },
    })
    assert.strictEqual(members.status, 200, JSON.stringify(members.body))
    const content = Buffer.from('echo saldo\n').toString('base64')
    sha = (await call('/files', { method: 'POST', token: admin, body: { content } })).body.result.sha256
    const skill = await call('/resources', {
      method: 'POST',
      token: admin,
      body: { id: 'banco', kind: 'skill', projectId: 'logiccus', description: 'Banco', body: 'Use os scripts.' },
    })
    assert.strictEqual(skill.status, 201, JSON.stringify(skill.body))
    assert.strictEqual((await call('/resources/banco/files', { method: 'PUT', token: admin, body: { files: [{ path: 'scripts/saldo.sh', sha256: sha, bytes: 11 }] } })).status, 200)
    await call('/providers/claude/models', { method: 'POST', token: admin, body: { modelId: 'claude-sonnet-5' } })
    await call('/providers/claude/models', { method: 'PUT', token: admin, body: { modelId: 'claude-sonnet-5', enabled: true } })
    for (const [id, projectId] of [
      ['maya', 'logiccus'],
      ['solta', undefined],
    ] as const)
      makeAgents().save(
        {
          id,
          name: id,
          ...(projectId ? { projectId } : {}),
          providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
          systemPrompt: 'faça',
          modes: [EMode.AGENT],
          allowedTools: [],
        },
        { rules: { knownTools: [] }, by: 'seed', creating: true },
      )
  })

  after(() => stop())

  it('o token de conexão: só para quem é do projeto, com o prefixo agc_ e o projeto na lista', async () => {
    assert.strictEqual((await call('/auth/tokens', { method: 'POST', token: bob, body: { name: 'meu gateway', expiresInDays: 30, projectId: 'logiccus' } })).status, 404)
    const created = await call('/auth/tokens', { method: 'POST', token: ana, body: { name: 'meu gateway', expiresInDays: 30, projectId: 'logiccus' } })
    assert.strictEqual(created.status, 201)
    connection = created.body.result.token
    assert.ok(connection.startsWith('agc_'))
    assert.strictEqual(created.body.result.projectId, 'logiccus')
  })

  it('⛔ o token de conexão não abre o resto da API, nem outro projeto; sem token, 401', async () => {
    assert.strictEqual((await call('/projects', { token: connection })).status, 401)
    assert.strictEqual((await call('/auth/tokens', { token: connection })).status, 401)
    assert.strictEqual((await call('/connect/outro/version', { token: connection })).status, 404)
    assert.strictEqual((await call('/connect/logiccus/version')).status, 401)
    // O token de sessão da conta também não serve aqui: o /connect só conhece o de conexão.
    assert.strictEqual((await call('/connect/logiccus/version', { token: ana })).status, 401)
  })

  it('a versão, o pacote com os arquivos citados e o que mudou desde uma versão', async () => {
    const first = (await call('/connect/logiccus/version', { token: connection })).body.result.version as number
    assert.ok(first > 0)

    const whole = (await call('/connect/logiccus/package?since=0', { token: connection })).body.result
    assert.strictEqual(whole.version, first)
    assert.ok(Object.keys(whole.package.files).includes('projects/logiccus/skills/banco/SKILL.md'))
    assert.deepStrictEqual(whole.files, [{ sha256: sha, bytes: 11 }])
    assert.ok(whole.changes.some((change: { kind: string; id: string }) => change.kind === 'skill' && change.id === 'banco'))

    const file = (await call(`/connect/logiccus/files/${sha}`, { token: connection })).body.result
    assert.strictEqual(Buffer.from(file.base64, 'base64').toString(), 'echo saldo\n')
    assert.strictEqual((await call(`/connect/logiccus/files/${'f'.repeat(64)}`, { token: connection })).status, 404)

    // Duas mudanças na skill: a versão sobe, e o aviso traz UMA linha para ela, com as duas revisões.
    for (const body of ['Use os scripts do banco.', 'Use os scripts do banco, sempre.'])
      assert.strictEqual((await call('/resources/banco', { method: 'PUT', token: admin, body: { body } })).status, 200)
    const later = (await call(`/connect/logiccus/package?since=${first}`, { token: connection })).body.result
    assert.ok(later.version > first)
    assert.deepStrictEqual(
      later.changes.map((change: { kind: string; id: string; op: string; revisions: number }) => [change.kind, change.id, change.op, change.revisions]),
      [['skill', 'banco', 'update', 2]],
    )
    assert.strictEqual((await call('/connect/logiccus/package?since=-1', { token: connection })).status, 400)
    // O aviso sem o pacote: a mesma lista.
    const notice = (await call(`/connect/logiccus/changes?since=${first}`, { token: connection })).body.result
    assert.deepStrictEqual([notice.version, notice.changes.length], [later.version, 1])
  })

  it('o aviso ao vivo: a versão ao abrir e a nova a cada mudança do projeto', async () => {
    const res = await fetch(`${base}/connect/logiccus/events`, { headers: { 'X-Tool-Authorization': `Bearer ${connection}` } })
    assert.strictEqual(res.status, 200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const nextVersion = async (): Promise<number> => {
      for (;;) {
        const match = /event: catalog\.version\ndata: (.+)\n\n/.exec(buffer)
        if (match) {
          buffer = buffer.slice(match.index + match[0].length)
          return JSON.parse(match[1]!).version
        }
        const { value, done } = await reader.read()
        if (done) throw new Error('stream closed')
        buffer += decoder.decode(value)
      }
    }
    const opened = await nextVersion()
    await call('/resources/banco', { method: 'PUT', token: admin, body: { description: 'Banco do Brasil' } })
    assert.ok((await nextVersion()) > opened)
    await reader.cancel()
  })

  it('🔌 o ledger do agente do projeto, pela conexão: um ledger só (o daqui), com o autor e a conta da conexão', async () => {
    assert.deepStrictEqual((await call('/connect/logiccus/ledger/maya', { token: connection })).body.result, {
      index: { agentId: 'maya', contexts: [], lineCount: 0, warnings: [] },
      prompt: null,
    })
    const written = await call('/connect/logiccus/ledger/maya/write', {
      method: 'POST',
      token: connection,
      body: { change: { action: 'criar', topic: 'Build OOM', trigger: 'quando o build estourar memória no CI' }, conversationId: 'gw_local_1' },
    })
    assert.strictEqual(written.status, 200, JSON.stringify(written.body))
    assert.deepStrictEqual(makeLedger().revisions('maya', 'build-oom')[0]!.by, { kind: 'agent', agentId: 'maya', via: 'ana@x.test', conversationId: 'gw_local_1' })
    assert.strictEqual((await call('/connect/logiccus/ledger/maya/contexts/build-oom', { token: connection })).body.result.trigger, 'quando o build estourar memória no CI')
    const invalid = await call('/connect/logiccus/ledger/maya/write', {
      method: 'POST',
      token: connection,
      body: { change: { action: 'criar', topic: 'outro-tema', trigger: 'curto' } },
    })
    assert.deepStrictEqual([invalid.status, invalid.body.details[0].field], [422, 'trigger'])
    // Agente de fora do projeto: como inexistente.
    assert.strictEqual((await call('/connect/logiccus/ledger/solta', { token: connection })).status, 404)
  })

  it('⛔ a conta que sai do projeto perde a conexão', async () => {
    await call('/projects/logiccus/members', { method: 'PUT', token: admin, body: { members: [{ userId: rootId, role: 'admin' }] } })
    assert.strictEqual((await call('/connect/logiccus/version', { token: connection })).status, 404)
  })
})
