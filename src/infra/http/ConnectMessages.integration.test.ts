import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAgents } from '@composition/factories/Agents.Factory'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makePersonMessages } from '@composition/factories/PersonMessages.Factory'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import {
  makeAuthController,
  makeConnectController,
  makeController,
  makeGuidanceController,
  makeProjectsController,
  makeProvidersController,
  makeUsageController,
} from '@composition/factories/Controller.Factory'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TEnvelope = { ok: boolean; result?: any; details?: any }
type TThread = { id: string; projectId?: string; title?: string; requestId?: string; unread: number; pending: number }
type TMessage = { id: string; from: string; body: string; status?: string }

/**
 * 💬 As MENSAGENS DA CONEXÃO (`/connect/:projectId/messages*`): a conta do token lê, responde, resolve e arquiva o que os agentes
 * do projeto lhe mandaram — e só isso: a mensagem de outra conta e a de outro projeto são 404.
 */
describe('projeto conectado: as mensagens (/connect/:projectId/messages)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let ana = ''
  let anaId = ''
  let bobId = ''
  let token = ''
  let controller: ReturnType<typeof makeController>

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return { status: res.status, body: (await res.json()) as TEnvelope }
  }
  const origin = (path: string, init: { method?: string; body?: unknown } = {}) => call(`/connect/logiccus/messages${path}`, { ...init, token })
  const session = async (id: string, owner: string, project?: string) => {
    const now = new Date()
    await controller.conversations.saveSession({
      id,
      agentId: 'maya',
      provider: 'claude',
      mode: 'agent',
      model: 'claude-sonnet-5',
      createdAt: now,
      updatedAt: now,
      turns: 1,
      usage: {},
      metadata: { owner: { id: owner }, ...(project ? { project } : {}) },
    })
  }
  const send = (sessionId: string, to: string, body: string, level = 'attention') => makePersonMessages().send({ sessionId, agentId: 'maya', to, title: body, body, level })

  before(async () => {
    const u = undefined
    controller = makeController()
    const server = new HttpServer(
      controller,
      makeAuthController(),
      makeProvidersController(),
      makeUsageController(controller.conversations),
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
      makeConnectController(controller),
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
    anaId = (await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana Souza', password: PASSWORD } })).body.result.id
    bobId = (await call('/users', { method: 'POST', token: admin, body: { email: 'bob@x.test', name: 'Bob', password: PASSWORD } })).body.result.id
    ana = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token
    for (const id of ['logiccus', 'outro']) assert.strictEqual((await call('/projects', { method: 'POST', token: admin, body: { id, name: id } })).status, 201)
    for (const id of ['logiccus', 'outro']) {
      const members = await call(`/projects/${id}/members`, {
        method: 'PUT',
        token: admin,
        body: {
          members: [
            { userId: setup.user.id, role: 'admin' },
            { userId: anaId, role: 'member' },
            { userId: bobId, role: 'member' },
          ],
        },
      })
      assert.strictEqual(members.status, 200, JSON.stringify(members.body))
    }
    await call('/providers/claude/models', { method: 'POST', token: admin, body: { modelId: 'claude-sonnet-5' } })
    await call('/providers/claude/models', { method: 'PUT', token: admin, body: { modelId: 'claude-sonnet-5', enabled: true } })
    makeAgents().save(
      {
        id: 'maya',
        name: 'maya',
        projectId: 'logiccus',
        providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
        systemPrompt: 'faça',
        modes: [EMode.AGENT],
        allowedTools: [],
      },
      { rules: { knownTools: [] }, by: 'seed', creating: true },
    )
    token = (await call('/auth/tokens', { method: 'POST', token: ana, body: { name: 'meu gateway', expiresInDays: 30, projectId: 'logiccus' } })).body.result.token
    await session('c_da_ana', anaId, 'logiccus')
    await session('c_do_bob', bobId, 'logiccus')
    await session('c_outro', anaId, 'outro')
  })

  after(() => stop())

  it('⛔ lista só o que é DA CONTA e DESTE projeto, com os totais; sem token, 401', async () => {
    await send('c_da_ana', 'owner', 'Pedido da Ana')
    await send('c_do_bob', 'owner', 'Pedido do Bob')
    await send('c_outro', 'owner', 'Pedido de outro projeto')
    const listed = (await origin('')).body.result as { threads: TThread[]; unread: number; pending: number }
    assert.deepStrictEqual(
      listed.threads.map((thread) => [thread.title, thread.projectId]),
      [['Pedido da Ana', 'logiccus']],
    )
    assert.deepStrictEqual([listed.unread, listed.pending], [1, 1])
    assert.strictEqual((await call('/connect/logiccus/messages')).status, 401)
    assert.strictEqual((await call('/connect/outro/messages', { token })).status, 404)
  })

  it('⛔ o item de outra conta e o de outro projeto são 404 em TODAS as rotas', async () => {
    const bobs = (await makePersonMessages().threads(bobId))[0]
    const others = (await makePersonMessages().threads(anaId)).find((thread) => thread.title === 'Pedido de outro projeto')!
    for (const key of [bobs.id, others.id, 'c_do_bob', 'c_outro']) {
      assert.strictEqual((await origin(`/${key}`)).status, 404, key)
      assert.strictEqual((await origin(`/${key}/read`, { method: 'POST' })).status, 404, key)
      assert.strictEqual((await origin(`/${key}/archive`, { method: 'PUT', body: { archived: true } })).status, 404, key)
      assert.strictEqual((await origin(`/${key}/reply`, { method: 'POST', body: { message: 'oi' } })).status, 404, key)
      assert.strictEqual((await origin(`/${key}/${key}/status`, { method: 'PUT', body: { status: 'resolved' } })).status, 404, key)
    }
    // Nada mudou lá: a do Bob continua não lida, a de outro projeto também.
    assert.strictEqual((await makePersonMessages().threads(bobId))[0].unread, 1)
    assert.strictEqual(makePersonMessages().unread(anaId), 2)
  })

  it('item, ler, resolver, reabrir e arquivar pelo id do pedido', async () => {
    const item = ((await origin('')).body.result.threads as TThread[])[0]
    const messages = (await origin(`/${item.id}`)).body.result.messages as TMessage[]
    assert.deepStrictEqual(
      messages.map((message) => [message.from, message.body, message.status]),
      [['agent', 'Pedido da Ana', 'pending']],
    )
    // Lê: o total é o DESTE projeto (a de outro projeto continua não lida, mas não entra).
    assert.strictEqual((await origin(`/${item.id}/read`, { method: 'POST' })).body.result.unread, 0)
    assert.strictEqual(makePersonMessages().unread(anaId), 1)
    const resolved = await origin(`/${item.id}/${item.id}/status`, { method: 'PUT', body: { status: 'resolved' } })
    assert.deepStrictEqual([resolved.status, resolved.body.result], [200, { status: 'resolved', pending: 0 }])
    assert.strictEqual((await origin(`/${item.id}/${item.id}/status`, { method: 'PUT', body: { status: 'x' } })).status, 422)
    assert.strictEqual((await origin(`/${item.id}/${item.id}/status`, { method: 'PUT', body: { status: 'pending' } })).body.result.pending, 1)
    await origin(`/${item.id}/archive`, { method: 'PUT', body: { archived: true } })
    assert.deepStrictEqual([((await origin('')).body.result.threads as TThread[]).length, ((await origin('?archived=1')).body.result.threads as TThread[]).length], [0, 1])
    await origin(`/${item.id}/archive`, { method: 'PUT', body: { archived: false } })
    assert.strictEqual(((await origin('')).body.result.threads as TThread[]).length, 1)
  })

  it('💬 responder: entra na conversa daqui, como pela rota normal (202); replyTo que não é pedido, 422; texto vazio, 422', async () => {
    const item = ((await origin('')).body.result.threads as TThread[])[0]
    assert.strictEqual((await origin(`/${item.id}/reply`, { method: 'POST', body: { message: '  ' } })).status, 422)
    assert.strictEqual((await origin(`/${item.id}/reply`, { method: 'POST', body: { message: 'oi', replyTo: 'm_inexistente' } })).status, 422)
    const sent = await origin(`/${item.id}/reply`, { method: 'POST', body: { message: 'Pode seguir' } })
    assert.strictEqual(sent.status, 202, JSON.stringify(sent.body))
    const thread = (await origin(`/${item.id}`)).body.result.messages as TMessage[]
    const mine = thread.find((message) => message.from === 'person')
    assert.strictEqual(mine?.body, 'Pode seguir')
    // O pedido virou "respondido" e o turno foi aberto (ou entrou na fila) na conversa de origem.
    assert.strictEqual(thread.find((message) => message.from === 'agent')?.status, 'answered')
    assert.strictEqual(typeof sent.body.result.queued, 'boolean')
  })

  it('📡 o aviso ao vivo: `messages.changed` para a conta e `message.new` só para mensagem de agente deste projeto', async () => {
    const abort = new AbortController()
    const res = await fetch(`${base}/connect/logiccus/events`, { headers: { 'X-Tool-Authorization': `Bearer ${token}` }, signal: abort.signal })
    assert.strictEqual(res.status, 200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const frames = async (until: (names: string[]) => boolean) => {
      const timeout = setTimeout(() => abort.abort(), 4000)
      try {
        while (!until([...buffer.matchAll(/^event: (.+)$/gm)].map((match) => match[1]))) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
        }
      } finally {
        clearTimeout(timeout)
      }
      return buffer
    }
    await frames((names) => names.includes('catalog.version'))
    buffer = ''
    // Outro projeto e outra conta: nem `message.new` nem conteúdo no fluxo.
    await send('c_outro', 'owner', 'Segredo de outro projeto', 'info')
    await send('c_do_bob', 'owner', 'Segredo do Bob', 'info')
    await send('c_da_ana', 'owner', 'Nova para a Ana', 'info')
    const text = await frames((names) => names.includes('message.new'))
    abort.abort()
    const news = [...text.matchAll(/^event: message\.new\ndata: (.+)$/gm)].map(
      (match) => JSON.parse(match[1]) as { title?: string; body: string; level: string; conversationId: string; key: string },
    )
    assert.deepStrictEqual(
      news.map((item) => [item.body, item.level, item.conversationId, item.key]),
      [['Nova para a Ana', 'info', 'c_da_ana', 'c_da_ana']],
    )
    assert.ok(/event: messages\.changed\ndata: \{"type":"messages\.changed","unread":\d+\}/.test(text), text)
    assert.ok(!text.includes('Segredo'), text)
  })
})
