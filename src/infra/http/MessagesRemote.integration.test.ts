import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { ProjectConnectionService } from '@application/ProjectConnection.Service'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController, makeProvidersController, makeUsageController } from '@composition/factories/Controller.Factory'
import { makePersonMessages } from '@composition/factories/PersonMessages.Factory'
import type { IPersonThread } from '@domain/models/PersonMessage.Model'
import { IRemoteCatalog, RemoteRequestError, RemoteUnavailableError } from '@domain/ports/RemoteCatalog.Port'
import { SqliteProjectConnectionRepository } from '@infra/persistence/Sqlite.ProjectConnectionRepository'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

const remoteThread = (id: string, at: string): IPersonThread => ({
  id,
  requestId: id,
  conversationId: 'c_da_origem',
  agentId: 'maya',
  projectId: 'logiccus',
  title: 'Pedido da origem',
  last: { id, recipientId: 'x', conversationId: 'c_da_origem', agentId: 'maya', from: 'agent', body: 'Posso?', level: 'attention', createdAt: new Date(at) },
  unread: 1,
  pending: 1,
  archived: false,
})

/**
 * 🔌 A TELA MENSAGENS COM PROJETO CONECTADO: a lista junta os itens da origem (só para a conta que conectou) e as ações de um
 * item que não é daqui vão para a origem; o item daqui segue como sempre.
 */
describe('Mensagens de projeto conectado (integração)', () => {
  let base = ''
  let stop = () => undefined as void
  let admin = ''
  let ana = ''
  let anaId = ''
  const calls: string[] = []
  const origin = { down: false }

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return { status: res.status, body: (await res.json()) as { result?: any; message?: string } } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    const controller = makeController()
    const live = () => {
      if (origin.down) throw new RemoteUnavailableError('down')
    }
    const client = {
      messages: async () => (live(), calls.push('messages'), { threads: [remoteThread('m_remoto', '2999-01-01T00:00:00Z')], unread: 1, pending: 1 }),
      message: async (key: string) => {
        live()
        calls.push(`message:${key}`)
        if (key !== 'm_remoto') throw new RemoteRequestError(404, 'Not found')
        return { messages: [remoteThread('m_remoto', '2999-01-01T00:00:00Z').last] }
      },
      readMessage: async (key: string) => (calls.push(`read:${key}`), { unread: 0 }),
      archiveMessage: async (key: string, archived: boolean) => (calls.push(`archive:${key}:${archived}`), { unread: 0 }),
      setMessageStatus: async (key: string, id: string, status: string) => (calls.push(`status:${key}:${id}:${status}`), { status, pending: 0 }),
      replyMessage: async (key: string, message: string) => (calls.push(`reply:${key}:${message}`), { queued: true }),
    } as unknown as IRemoteCatalog
    const repository = new SqliteProjectConnectionRepository(':memory:')
    repository.insert(
      {
        projectId: 'logiccus',
        url: 'http://origem.test',
        remoteProjectId: 'logiccus',
        syncedVersion: 1,
        latestVersion: 1,
        state: 'ok',
        changes: [],
        skipped: [],
        secrets: [],
        modelMap: {},
        autoUpdate: true,
        createdAt: new Date(),
        // A conta que conectou: só ela vê as mensagens da origem.
        createdBy: 'ana@x.test',
      },
      'agc_x',
    )
    const connections = new ProjectConnectionService({
      repository,
      box: { seal: (plain: string) => plain, open: (box: string) => box },
      client: () => client,
    } as never)
    // O serviço de conexões do controlador é o desta prova (a origem é a falsa de cima).
    ;(controller as unknown as { usecases: { connections: unknown } }).usecases.connections = connections

    const server = new HttpServer(controller, makeAuthController(), makeProvidersController(), makeUsageController(controller.conversations)).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
    admin = (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })).body.result
      .token
    anaId = (await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })).body.result.id
    ana = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token
    const now = new Date()
    await controller.conversations.saveSession({
      id: 'gw_da_ana',
      agentId: 'zeus',
      provider: 'claude',
      mode: 'agent',
      model: 'm',
      createdAt: now,
      updatedAt: now,
      turns: 1,
      usage: {},
      metadata: { owner: { id: anaId, email: 'ana@x.test' } },
    })
    await makePersonMessages().send({ sessionId: 'gw_da_ana', agentId: 'zeus', to: 'owner', title: 'Pedido local', body: 'Posso?', level: 'attention' })
  })

  after(() => stop())

  it('⛔ a lista da conta que conectou junta local e origem (a mais recente primeiro, com `origin` e os totais); a dos outros, só a local', async () => {
    const mine = (await call('/messages', { token: ana })).body.result
    assert.deepStrictEqual(
      mine.threads.map((thread: { title: string; origin?: unknown }) => [thread.title, thread.origin]),
      [
        ['Pedido da origem', { projectId: 'logiccus', url: 'http://origem.test' }],
        ['Pedido local', undefined],
      ],
    )
    assert.deepStrictEqual([mine.unread, mine.pending], [2, 2])
    const others = (await call('/messages', { token: admin })).body.result
    assert.deepStrictEqual([others.threads.length, others.unread, others.pending], [0, 0, 0])
  })

  it('origem fora do ar: a lista não quebra nem espera; traz a última lista marcada `stale`', async () => {
    origin.down = true
    try {
      const mine = (await call('/messages', { token: ana })).body.result
      assert.deepStrictEqual(mine.threads.find((thread: { id: string }) => thread.id === 'm_remoto').origin, { projectId: 'logiccus', url: 'http://origem.test', stale: true })
      assert.strictEqual(mine.threads.length, 2)
    } finally {
      origin.down = false
    }
  })

  it('o item que não é daqui vai para a origem (abrir, ler, resolver, arquivar, responder); outra conta e chave desconhecida, 404', async () => {
    const opened = await call('/messages/m_remoto', { token: ana })
    assert.deepStrictEqual(
      opened.body.result.messages.map((message: { body: string }) => message.body),
      ['Posso?'],
    )
    assert.strictEqual((await call('/messages/m_remoto/read', { method: 'POST', token: ana })).body.result.unread, 1)
    assert.deepStrictEqual((await call('/messages/m_remoto/m_remoto/status', { method: 'PUT', token: ana, body: { status: 'resolved' } })).body.result, {
      status: 'resolved',
      pending: 1,
    })
    assert.strictEqual((await call('/messages/m_remoto/archive', { method: 'PUT', token: ana, body: { archived: true } })).status, 200)
    const replied = await call('/messages/m_remoto/reply', { method: 'POST', token: ana, body: { message: 'Pode' } })
    assert.deepStrictEqual([replied.status, replied.body.result], [202, { queued: true }])
    assert.strictEqual((await call('/messages/m_remoto/reply', { method: 'POST', token: ana, body: { message: ' ' } })).status, 422)
    // 📎 Anexo ainda não vai a projeto conectado: 422, sem chamar a origem.
    const calledBefore = calls.length
    const attached = await call('/messages/m_remoto/reply', {
      method: 'POST',
      token: ana,
      body: { message: 'Pode', files: [{ name: 'a.txt', mimeType: 'text/plain', data: 'YQ==' }] },
    })
    assert.deepStrictEqual([attached.status, calls.slice(calledBefore).filter((entry) => entry.startsWith('reply:'))], [422, []])
    for (const key of ['m_remoto', 'm_desconhecido']) {
      const before = calls.length
      if (key === 'm_remoto') {
        assert.strictEqual((await call(`/messages/${key}`, { token: admin })).status, 404)
        assert.strictEqual(calls.length, before, 'a origem não é consultada para quem não conectou')
      } else assert.strictEqual((await call(`/messages/${key}`, { token: ana })).status, 404)
    }
    assert.deepStrictEqual(
      calls.filter((entry) => !entry.startsWith('message:') && entry !== 'messages'),
      ['read:m_remoto', 'status:m_remoto:m_remoto:resolved', 'archive:m_remoto:true', 'reply:m_remoto:Pode'],
    )
  })

  it('o item daqui segue como sempre: nem consulta a origem', async () => {
    const local = (await call('/messages', { token: ana })).body.result.threads.find((thread: { origin?: unknown }) => !thread.origin)
    const before = calls.length
    const opened = await call(`/messages/${local.id}`, { token: ana })
    assert.deepStrictEqual(
      opened.body.result.messages.map((message: { body: string }) => message.body),
      ['Posso?'],
    )
    assert.strictEqual((await call(`/messages/${local.id}/read`, { method: 'POST', token: ana })).body.result.unread, 0)
    // (a lista consulta a origem; as ações do item daqui, não)
    assert.deepStrictEqual(
      calls.slice(before).filter((entry) => entry !== 'messages'),
      [],
    )
  })

  it('origem fora do ar: agir num item dela dá erro claro (502 connection_unavailable), não 404', async () => {
    origin.down = true
    try {
      const res = await call('/messages/m_remoto/read', { method: 'POST', token: ana })
      assert.strictEqual(res.status, 502)
    } finally {
      origin.down = false
    }
  })
})
