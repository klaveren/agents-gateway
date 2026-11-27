import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeAgents } from '@composition/factories/Agents.Factory'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeSessionStore } from '@composition/factories/Orchestrator.Factory'
import {
  makeAuthController,
  makeCatalogController,
  makeController,
  makePermissionRequestsController,
  makeProjectsController,
  makeProvidersController,
} from '@composition/factories/Controller.Factory'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { makeGuidance } from '@composition/factories/Guidance.Factory'
import { GuidanceController } from './Guidance.Controller'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

/**
 * ⛔ AGENTE GRAVA LISTA SÓ POR DELTA (incidente de 26/11: uma agente mandou `allowedTools` inteira, montada da lista efetiva
 * de outra máquina, e derrubou 171 ferramentas). `{ add, remove }` contra o agente DESTA máquina, teto por chamada,
 * simulação; a tela segue gravando a lista inteira.
 */
describe('patch_agent por delta (integração: MCP do gateway, API, cookie da tela)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let jar = ''
  /** A conversa viva do admin (o rótulo do pedido): a de outra pessoa, ou uma que não existe, não fica no pedido. */
  let conversation = ''

  const raw = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await raw(path, init)
    return { status: res.status, body: (await res.json()) as { ok: boolean; result?: any; code?: string; details?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const bearer = (token: string) => ({ 'X-Tool-Authorization': `Bearer ${token}` })
  const origin = () => `http://${new URL(base).host}`
  let csrf = ''
  /** A tela de verdade: o cookie, a origem, a prova do navegador (`Sec-Fetch-*`) e o CSRF que ela lê do cookie legível. */
  const screen = () => ({ Cookie: jar, Origin: origin(), 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'X-CSRF': csrf })

  /** O cliente MCP como o gateway o usa: a conta de quem conversa e a identidade do agente (rótulo). */
  const connect = async (token: string) => {
    const client = new Client({ name: 'teste', version: '1.0.0' })
    const headers = { ...bearer(token), 'x-gateway-agent': 'theo', 'x-gateway-conversation': conversation }
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }))
    return client
  }

  before(async () => {
    delete process.env.SELF_MCP_WRITE
    const controller = makeController()
    const server = new HttpServer(
      controller,
      makeAuthController(),
      makeProvidersController(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeProjectsController(),
      new GuidanceController({ guidance: makeGuidance(), proof: makeAuth().proof }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeCatalogController(),
      makePermissionRequestsController(),
    ).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
    admin = (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })).body.result
      .token
    const login = await raw('/auth/login', {
      method: 'POST',
      body: { email: 'root@x.test', password: PASSWORD },
      headers: { 'X-Gateway-Client': 'web', Origin: origin() },
    })
    const cookies = login.headers.getSetCookie().map((line) => line.split(';')[0])
    jar = cookies.find((item) => item.startsWith('gw_session_')) ?? ''
    csrf = decodeURIComponent((cookies.find((item) => item.startsWith('gw_csrf_')) ?? '').split('=')[1] ?? '')
    // O modelo do agente ativo: o `patch_agent` grava pelas regras do `PUT` (modelo ativado no catálogo).
    await call('/providers/claude/key', { method: 'PUT', headers: bearer(admin), body: { key: 'sk-ant-chave-de-teste-do-delta-000000000' } })
    await call('/providers/claude/models', { method: 'POST', headers: bearer(admin), body: { modelId: 'claude-sonnet-5' } })
    await call('/providers/claude/models', { method: 'PUT', headers: bearer(admin), body: { modelId: 'claude-sonnet-5', enabled: true } })
    const me = (await call('/auth/me', { headers: bearer(admin) })).body.result
    conversation = makeSessionStore().create({
      agentId: 'theo',
      provider: 'claude',
      protocol: EProvider.CLAUDE,
      mode: EMode.AGENT,
      model: 'claude-sonnet-5',
      tools: true,
      systemPrompt: 'x',
      metadata: { owner: { id: me.id, email: 'root@x.test' } },
    }).id
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'])
      makeAgents().save(
        { id, name: id, providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }], systemPrompt: 'faça', modes: [EMode.AGENT], allowedTools: [] },
        { rules: { knownTools: [] }, by: 'seed', creating: true },
      )
    makeAgents().save(
      {
        id: 'theo',
        name: 'Theo',
        providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
        systemPrompt: 'faça',
        modes: [EMode.AGENT],
        allowedTools: ['agent:a1', 'agent:a2', 'agent:a3', 'agent:a4'],
      },
      { rules: { knownTools: [], agentExists: () => true }, by: 'seed', creating: true },
    )
  })

  after(() => stop())

  const stored = async () => (await call('/agents/theo', { headers: bearer(admin) })).body.result as { allowedTools: string[]; modes: string[] }
  const patch = async (change: Record<string, unknown>, dryRun = false) => {
    const client = await connect(admin)
    try {
      const answer = (await client.callTool({ name: 'patch_agent', arguments: { agentId: 'theo', patch: change, reason: 'teste', ...(dryRun ? { dryRun } : {}) } })) as {
        content: Array<{ text: string }>
        isError?: boolean
      }
      return { error: answer.isError === true, body: JSON.parse(answer.content[answer.content.length - 1].text) }
    } finally {
      await client.close()
    }
  }
  const ORIGINAL = ['agent:a1', 'agent:a2', 'agent:a3', 'agent:a4']

  it('a descrição do patch_agent ensina add/remove e o teto', async () => {
    const client = await connect(admin)
    try {
      const description = (await client.listTools()).tools.find((tool) => tool.name === 'patch_agent')?.description ?? ''
      assert.match(description, /"add": \[\.\.\.\], "remove": \[\.\.\.\]/)
      assert.match(description, /At most 5 entries per call/)
      assert.match(description, /dryRun/)
    } finally {
      await client.close()
    }
  })

  it('⛔ lista inteira vinda de agente: 400 com a lista de agora desta máquina, e nada grava', async () => {
    const whole = await patch({ allowedTools: ['agent:a1'] })
    assert.deepStrictEqual([whole.error, whole.body.status, whole.body.code], [true, 400, 'delta_required'])
    assert.match(whole.body.message, /add.*remove/)
    assert.deepStrictEqual(whole.body.details.current.allowedTools, ORIGINAL)
    assert.deepStrictEqual((await stored()).allowedTools, ORIGINAL)
    // `modes` também.
    const modes = await patch({ modes: ['agent', 'chat'] })
    assert.deepStrictEqual([modes.error, modes.body.code], [true, 'delta_required'])
  })

  it('⛔ acima do teto (5): 409 com a diferença, e nada grava', async () => {
    const many = await patch({ allowedTools: { add: ['agent:a5', 'agent:a6', 'agent:a7'], remove: ['agent:a1', 'agent:a2', 'agent:a4'] } })
    assert.deepStrictEqual([many.error, many.body.status, many.body.code], [true, 409, 'too_many_changes'])
    assert.deepStrictEqual([many.body.details.limit, many.body.details.count], [5, 6])
    const [change] = many.body.details.changes
    assert.deepStrictEqual([change.field, change.added, change.removed], ['allowedTools', ['agent:a5', 'agent:a6', 'agent:a7'], ['agent:a1', 'agent:a2', 'agent:a4']])
    assert.match(many.body.message, /in parts/)
    assert.deepStrictEqual((await stored()).allowedTools, ORIGINAL)
    // ⚖️ O teto conta a diferença de VERDADE: o que já está, ou não está, não conta.
    const noop = await patch({ allowedTools: { add: ORIGINAL, remove: ['agent:a5', 'agent:a6', 'agent:a7'] } }, true)
    assert.strictEqual(noop.error, false, JSON.stringify(noop.body))
  })

  it('dryRun: o que sairia, o que entraria e o que viraria pedido — sem gravar', async () => {
    const sim = await patch({ allowedTools: { add: ['agent:a5'], remove: ['agent:a4'] } }, true)
    assert.strictEqual(sim.error, false, JSON.stringify(sim.body))
    assert.strictEqual(sim.body.dryRun, true)
    assert.deepStrictEqual(sim.body.added, { allowedTools: ['agent:a5'] })
    assert.deepStrictEqual(sim.body.removed, { allowedTools: ['agent:a4'] })
    assert.deepStrictEqual(sim.body.applied, ['allowedTools'])
    assert.deepStrictEqual(
      sim.body.pending.map((item: { entries?: unknown }) => item.entries),
      [{ field: 'allowedTools', add: ['agent:a5'] }],
    )
    assert.deepStrictEqual((await stored()).allowedTools, ORIGINAL)
    const open = (await call('/agents/theo/permission-requests', { headers: bearer(admin) })).body.result as Array<{ status: string }>
    assert.deepStrictEqual(
      open.filter((item) => item.status === 'pending'),
      [],
    )
  })

  it('delta: tirar vale já, acrescentar vira pedido', async () => {
    const done = await patch({ allowedTools: { add: ['agent:a5'], remove: ['agent:a4', 'agent:nao-tem'] } })
    assert.strictEqual(done.error, false, JSON.stringify(done.body))
    assert.deepStrictEqual(done.body.applied, ['allowedTools'])
    assert.strictEqual(done.body.pending.length, 1)
    assert.deepStrictEqual(done.body.pending[0].entries, { field: 'allowedTools', add: ['agent:a5'] })
    assert.deepStrictEqual(done.body.changes, [{ field: 'allowedTools', added: ['agent:a5'], removed: ['agent:a4'], ignored: ['agent:nao-tem'] }])
    assert.deepStrictEqual((await stored()).allowedTools, ['agent:a1', 'agent:a2', 'agent:a3'])
    // `modes` por delta.
    const modes = await patch({ modes: { add: ['chat'] } })
    assert.strictEqual(modes.error, false, JSON.stringify(modes.body))
  })

  it('a tela (pessoa, cookie) segue gravando a lista inteira', async () => {
    const rest = (await call('/agents/theo', { headers: bearer(admin) })).body.result
    const saved = await call('/agents/theo', {
      method: 'PUT',
      headers: screen(),
      body: { name: rest.name, providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }], systemPrompt: 'faça', modes: ['agent'], allowedTools: ORIGINAL },
    })
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body))
    assert.deepStrictEqual((await stored()).allowedTools, ORIGINAL)
  })

  it('set_agent_resources: só add/remove, com teto; a lista inteira volta 400 com a de agora', async () => {
    const client = await connect(admin)
    const set = async (args: Record<string, unknown>) => {
      const answer = (await client.callTool({ name: 'set_agent_resources', arguments: { agentId: 'theo', ...args } })) as {
        content: Array<{ text: string }>
        isError?: boolean
      }
      return { error: answer.isError === true, body: JSON.parse(answer.content[0].text) }
    }
    try {
      const whole = await set({ skills: [], commands: [] })
      assert.deepStrictEqual([whole.error, whole.body.code], [true, 'delta_required'])
      assert.deepStrictEqual(whole.body.details.current, { skills: ['*'], commands: ['*'] })
      // Com "*", tirar um é da tela.
      assert.strictEqual((await set({ skills: { remove: ['x'] } })).error, true)
      const noop = await set({ skills: { add: ['a', 'b', 'c'] }, commands: { add: ['d', 'e', 'f'] } })
      assert.strictEqual(noop.error, false, 'com "*", acrescentar não muda nada')
      // A pessoa escolhe a lista; daí o agente muda por delta, com teto.
      for (const id of ['s1', 's2', 's3', 's4', 's5', 's6']) makeGuidance().createResource({ id, kind: 'skill', description: id, body: 'b' }, 'root')
      assert.strictEqual((await call('/agents/theo/resources', { method: 'PUT', headers: bearer(admin), body: { skills: ['s1'], commands: [] } })).status, 200)
      const over = await set({ skills: { add: ['s2', 's3', 's4', 's5', 's6'], remove: ['s1'] } })
      assert.deepStrictEqual([over.error, over.body.code, over.body.details.count], [true, 'too_many_changes', 6])
      const sim = await set({ skills: { add: ['s2'], remove: ['s1'] }, dryRun: true })
      assert.deepStrictEqual([sim.body.added, sim.body.removed], [{ skills: ['s2'] }, { skills: ['s1'] }])
      const done = await set({ skills: { add: ['s2', 's3'], remove: ['s1'] } })
      assert.strictEqual(done.error, false, JSON.stringify(done.body))
      // A outra lista fica como estava (a rota troca as duas inteiras).
      assert.deepStrictEqual((await call('/agents/theo/resources', { headers: bearer(admin) })).body.result, { skills: ['s2', 's3'], commands: [] })
    } finally {
      await client.close()
    }
  })
})
