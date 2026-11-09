import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentScopeOf, scopedWrites } from './SelfMcp.Guard'
import { ISelfReply, TSelfApi } from './Self.Api'
import { TURN_GRANT_LOCAL } from './Security.Middleware'

/** Uma API falsa: o que existe (agentes e itens por projeto) e o que foi gravado. */
function fakeApi() {
  const written: string[] = []
  const agents: Record<string, { projectId?: string }> = { 'a-p': { projectId: 'P' }, 'a-q': { projectId: 'Q' }, atlas: {} }
  const items: Record<string, Array<{ id: string; projectId?: string }>> = { 'rules?P': [{ id: 'r-p', projectId: 'P' }], 'rules?Q': [{ id: 'r-q', projectId: 'Q' }] }
  const api: TSelfApi = async (method, path, options) => {
    if (method !== 'GET') {
      written.push(`${method} ${path}`)
      return { ok: true, status: 200, result: {} }
    }
    const agent = /^\/agents\/([^/]+)$/.exec(path)
    if (agent) return agents[agent[1]] ? { ok: true, status: 200, result: { id: agent[1], ...agents[agent[1]] } } : { ok: false, status: 404 }
    const list = /^\/(rules|docs|resources)$/.exec(path)
    if (list) return { ok: true, status: 200, result: items[`${list[1]}?${options?.query?.project}`] ?? [] }
    return { ok: true, status: 200, result: [] }
  }
  return { api, written }
}

const refused = (answer: ISelfReply) => answer.status === 403 && answer.ok === false

describe('SelfMcp.Guard', () => {
  it('⛔ injeção numa conversa do projeto P não grava agente, regra ou recurso em Q (nem no global)', async () => {
    const { api, written } = fakeApi()
    const guarded = scopedWrites(api, { projectId: 'P', unrestricted: false })

    assert.ok(refused(await guarded('POST', '/agents', { body: { id: 'novo', projectId: 'Q' } })))
    assert.ok(refused(await guarded('POST', '/agents', { body: { id: 'novo', projectId: null } })))
    assert.ok(refused(await guarded('PUT', '/agents/a-q', { body: { name: 'x' } })), 'agente existente de Q')
    assert.ok(refused(await guarded('PUT', '/agents/atlas', { body: { name: 'x' } })), 'agente global')
    assert.ok(refused(await guarded('PUT', '/agents/a-p', { body: { projectId: 'Q' } })), 'mover o agente de P para Q')
    assert.ok(refused(await guarded('POST', '/agents/a-q/hooks', { body: { name: 'h' } })))
    assert.ok(refused(await guarded('POST', '/resources', { body: { id: 'r', projectId: 'Q' } })))
    assert.ok(refused(await guarded('PUT', '/rules/r-q', { body: { body: 'x' } })), 'regra de Q')
    assert.ok(refused(await guarded('DELETE', '/rules/r-q')))
    assert.ok(refused(await guarded('PUT', '/projects/Q/members', { body: { members: [] } })))
    assert.ok(refused(await guarded('POST', '/projects', { body: { id: 'z' } })))
    assert.ok(refused(await guarded('PUT', '/providers/x/models', { body: {} })))
    assert.ok(refused(await guarded('POST', '/packages', { body: { name: 'jq' } })))
    assert.ok(refused(await guarded('POST', '/catalog/history/restore', { body: { kind: 'rule', id: 'r-q', project: 'Q' } })))
    assert.ok(refused(await guarded('POST', '/sessions', { body: { agentId: 'a-q' } })), 'abrir conversa com o agente de Q')
    assert.ok(refused(await guarded('POST', '/sessions', { body: { agentId: 'atlas', projectId: 'Q' } })))
    assert.ok(refused(await guarded('PATCH', '/agents/a-q', { body: { patch: { name: 'x' }, reason: 'x' } })), 'o patch grava na hora o que não amplia: só no projeto da conversa')
    assert.deepStrictEqual(written, [])
  })

  it('no projeto da conversa a escrita segue (agente, regra existente, hooks, recursos, conversa)', async () => {
    const { api, written } = fakeApi()
    const guarded = scopedWrites(api, { projectId: 'P', unrestricted: false })

    assert.strictEqual((await guarded('POST', '/agents', { body: { id: 'novo', projectId: 'P' } })).ok, true)
    assert.strictEqual((await guarded('PUT', '/agents/a-p', { body: { name: 'x' } })).ok, true)
    assert.strictEqual((await guarded('POST', '/agents/a-p/hooks', { body: { name: 'h' } })).ok, true)
    assert.strictEqual((await guarded('PUT', '/rules/r-p', { body: { body: 'x', projectId: 'P' } })).ok, true)
    assert.strictEqual((await guarded('POST', '/resources', { body: { id: 'r', projectId: 'P' } })).ok, true)
    assert.strictEqual((await guarded('PUT', '/projects/P/members', { body: { members: [] } })).ok, true)
    assert.strictEqual((await guarded('POST', '/sessions', { body: { agentId: 'atlas', projectId: 'P' } })).ok, true, 'agente global, conversa do projeto')
    assert.strictEqual((await guarded('PATCH', '/agents/a-p', { body: { patch: {}, reason: 'x' } })).ok, true, 'pedido que a pessoa aprova na tela')
    assert.strictEqual(written.length, 9, 'o save_agent de agente grava o mínimo e pede o resto (POST + PATCH, PUT → PATCH)')
  })

  it('⛔ o agente não compartilha (mexe em OUTRO projeto): PUT .../shares é recusado mesmo no projeto da conversa e para o Atlas', async () => {
    for (const scope of [{ projectId: 'P', unrestricted: false }, { unrestricted: true }, { unrestricted: false }]) {
      const { api, written } = fakeApi()
      const guarded = scopedWrites(api, scope)
      assert.ok(refused(await guarded('PUT', '/resources/skill-p/shares', { body: { projects: ['Q'] } })), JSON.stringify(scope))
      assert.ok(refused(await guarded('PUT', '/docs/spec-p/shares', { body: { projects: ['Q'] } })))
      assert.ok(refused(await guarded('PUT', '/docs/spec-p/shares', { body: { projects: [] } })), 'parar de compartilhar também')
      assert.ok(refused(await guarded('PUT', '/resources/skill%20p/shares/', { body: { projects: ['Q'] } })))
      // ⛔ O agente também não compartilha AGENTES (nem o próprio).
      assert.ok(refused(await guarded('PUT', '/agents/a-p/shares', { body: { projects: ['Q'] } })), JSON.stringify(scope))
      assert.ok(refused(await guarded('PUT', '/agents/a-p/shares/', { body: { projects: [] } })), 'parar também')
      assert.deepStrictEqual(written, [])
    }
  })

  it('o resto de docs do projeto da conversa segue como antes (a trava é só a rota de compartilhar)', async () => {
    const { api, written } = fakeApi()
    const guarded = scopedWrites(api, { projectId: 'P', unrestricted: false })
    assert.strictEqual((await guarded('POST', '/docs', { body: { id: 'd', projectId: 'P' } })).ok, true)
    assert.strictEqual(written.length, 1)
  })

  it('administrador do gateway numa conversa SEM projeto (o Atlas) escreve onde a conta dele escreve', async () => {
    const { api, written } = fakeApi()
    const guarded = scopedWrites(api, { unrestricted: true })
    assert.strictEqual((await guarded('POST', '/agents', { body: { id: 'n', projectId: 'Q' } })).ok, true)
    assert.strictEqual((await guarded('POST', '/projects', { body: { id: 'z' } })).ok, true)
    assert.strictEqual((await guarded('PUT', '/providers/x/models', { body: {} })).ok, true)
    assert.strictEqual(written.length, 4)
  })

  it('⛔ agente não edita as sequências de modelos (PUT /settings), nem o Atlas', async () => {
    const { api, written } = fakeApi()
    for (const scope of [{ projectId: 'P', unrestricted: false }, { unrestricted: true }, { unrestricted: false }])
      assert.ok(refused(await scopedWrites(api, scope)('PUT', '/settings', { body: { modelGroups: [] } })))
    assert.deepStrictEqual(written, [])
  })

  it('sem projeto e sem ser administrador do gateway, o agente não escreve em lugar nenhum', async () => {
    const { api, written } = fakeApi()
    const guarded = scopedWrites(api, { unrestricted: false })
    assert.ok(refused(await guarded('POST', '/agents', { body: { id: 'n', projectId: 'Q' } })))
    assert.ok(refused(await guarded('POST', '/agents', { body: { id: 'n' } })))
    assert.deepStrictEqual(written, [])
  })

  describe('⛔ save_agent de agente não amplia acesso; agente novo nasce no projeto da conversa', () => {
    /** API falsa que guarda o agente e os corpos recebidos. */
    function saving(existing: Record<string, unknown> = {}) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls: Array<{ method: string; path: string; body?: any }> = []
      const api: TSelfApi = async (method, path, options) => {
        calls.push({ method, path, body: options?.body })
        if (method === 'GET') return path === '/agents/a-p' ? { ok: true, status: 200, result: { id: 'a-p', projectId: 'P', ...existing } } : { ok: false, status: 404 }
        if (method === 'PATCH') return { ok: true, status: 200, result: { agentId: 'x', applied: [], pending: [{ id: 'r1' }], notice: 'PENDENTE' } }
        return { ok: true, status: 201, result: { id: 'novo', ...((options?.body as object) ?? {}) } }
      }
      return { api, calls }
    }

    it('o agente que se dá run_bash / terminal * pelo save_agent: não grava, vira pedido', async () => {
      const { api, calls } = saving()
      const guarded = scopedWrites(api, { projectId: 'P', unrestricted: false })
      const answer = await guarded('PUT', '/agents/a-p', {
        body: { id: 'a-p', name: 'A', allowedTools: ['run_bash'], permissions: [{ category: 'terminal', pattern: '*', effect: 'allow' }], projectId: 'P' },
      })
      assert.strictEqual(answer.ok, true)
      assert.ok(!calls.some((call) => call.method === 'PUT' || call.method === 'POST'), 'nada de PUT/POST')
      const patch = calls.find((call) => call.method === 'PATCH')
      assert.strictEqual(patch?.path, '/agents/a-p')
      assert.deepStrictEqual(patch?.body.patch.allowedTools, ['run_bash'])
      assert.ok(patch?.body.reason)
      assert.strictEqual((answer.result as { notice?: string }).notice, 'PENDENTE')
    })

    it('editar manda só os campos enviados (adminOnly omitido não abre o agente)', async () => {
      const { api, calls } = saving({ adminOnly: true })
      const guarded = scopedWrites(api, { projectId: 'P', unrestricted: false })
      await guarded('PUT', '/agents/a-p', { body: { id: 'a-p', name: 'B' } })
      assert.deepStrictEqual(calls.find((call) => call.method === 'PATCH')?.body.patch, { name: 'B' })
    })

    it('agente novo sem projectId nasce no projeto da conversa, no mínimo, e o resto é pedido', async () => {
      const { api, calls } = saving()
      const guarded = scopedWrites(api, { projectId: 'P', unrestricted: false })
      const body = {
        id: 'novo',
        name: 'N',
        providers: [{ provider: 'codex', models: ['m'], sandbox: 'full', network: true }],
        allowedTools: ['run_bash', 'agent:outro'],
        modes: ['agent'],
        adminOnly: false,
        env: { A: 'b' },
      }
      const answer = await guarded('POST', '/agents', { body })
      assert.strictEqual(answer.ok, true)
      const created = calls.find((call) => call.method === 'POST')
      assert.strictEqual(created?.body.projectId, 'P')
      assert.deepStrictEqual(created?.body.allowedTools, [])
      assert.strictEqual(created?.body.adminOnly, true)
      assert.deepStrictEqual(created?.body.providers, [{ provider: 'codex', models: ['m'] }])
      assert.strictEqual(created?.body.env, undefined)
      const patch = calls.find((call) => call.method === 'PATCH')
      assert.strictEqual(patch?.path, '/agents/novo')
      assert.deepStrictEqual(patch?.body.patch.allowedTools, ['run_bash', 'agent:outro'])
      assert.strictEqual(patch?.body.patch.adminOnly, false)
      assert.strictEqual(patch?.body.patch.providers[0].sandbox, 'full')
      assert.strictEqual((answer.result as { notice?: string }).notice, 'PENDENTE')
    })

    it('patch recusado (corpo inválido): o agente recém-criado é apagado', async () => {
      const calls: string[] = []
      const api: TSelfApi = async (method, path) => {
        calls.push(`${method} ${path}`)
        if (method === 'PATCH') return { ok: false, status: 422, code: 'validation_error' }
        return { ok: true, status: 201, result: {} }
      }
      const answer = await scopedWrites(api, { projectId: 'P', unrestricted: false })('POST', '/agents', { body: { id: 'novo' } })
      assert.strictEqual(answer.status, 422)
      assert.deepStrictEqual(calls, ['POST /agents', 'PATCH /agents/novo', 'DELETE /agents/novo'])
    })

    it('mover para global (projectId null) continua recusado ao agente de projeto', async () => {
      const { api, calls } = saving()
      const guarded = scopedWrites(api, { projectId: 'P', unrestricted: false })
      assert.ok(refused(await guarded('PUT', '/agents/a-p', { body: { id: 'a-p', projectId: null } })))
      assert.ok(!calls.some((call) => call.method !== 'GET'))
    })

    it('pessoa (sem escopo de agente) segue direto, sem pedido: não passa pelo guard', async () => {
      const { api, calls } = saving()
      await api('PUT', '/agents/a-p', { body: { allowedTools: ['run_bash'] } })
      assert.deepStrictEqual(
        calls.map((call) => call.method),
        ['PUT'],
      )
    })
  })

  it('leituras passam como estão', async () => {
    const { api } = fakeApi()
    const guarded = scopedWrites(api, { projectId: 'P', unrestricted: false })
    assert.strictEqual((await guarded('GET', '/agents/a-q')).ok, true)
  })

  describe('quem é agente', () => {
    const res = (grant?: object) => ({ locals: grant ? { [TURN_GRANT_LOCAL]: grant } : {} })

    it('a concessão do turno manda: o projeto vem do contexto do servidor, não do cabeçalho', () => {
      const scope = agentScopeOf({ headers: { 'x-gateway-project': 'Q' } }, res({ conversationProjectId: 'P', agentId: 'a' }), true)
      assert.deepStrictEqual(scope, { projectId: 'P', unrestricted: false })
      assert.deepStrictEqual(agentScopeOf({ headers: {} }, res({ agentId: 'atlas' }), true), { unrestricted: true })
      assert.deepStrictEqual(agentScopeOf({ headers: {} }, res({ agentId: 'atlas' }), false), { unrestricted: false })
    })

    it('sem concessão, os cabeçalhos de identidade do gateway marcam o agente; sem nenhum, é uma pessoa (conta inteira)', () => {
      assert.deepStrictEqual(agentScopeOf({ headers: { 'x-gateway-agent': 'a', 'x-gateway-project': 'P' } }, res(), true), { projectId: 'P', unrestricted: false })
      // Na lite, o projeto padrão vale como "sem projeto" para o administrador do gateway (só ele, e só o padrão).
      process.env.GATEWAY_EDITION = 'lite'
      try {
        assert.deepStrictEqual(agentScopeOf({ headers: {} }, res({ agentId: 'atlas', conversationProjectId: 'geral' }), true), { projectId: 'geral', unrestricted: true })
        assert.deepStrictEqual(agentScopeOf({ headers: {} }, res({ agentId: 'atlas', conversationProjectId: 'geral' }), false), { projectId: 'geral', unrestricted: false })
        assert.deepStrictEqual(agentScopeOf({ headers: {} }, res({ agentId: 'atlas', conversationProjectId: 'outro' }), true), { projectId: 'outro', unrestricted: false })
      } finally {
        delete process.env.GATEWAY_EDITION
      }
      assert.deepStrictEqual(agentScopeOf({ headers: {} }, res({ agentId: 'atlas', conversationProjectId: 'geral' }), true), { projectId: 'geral', unrestricted: false })
      assert.deepStrictEqual(agentScopeOf({ headers: { 'x-gateway-conversation': 'c' } }, res(), true), { unrestricted: true })
      assert.strictEqual(agentScopeOf({ headers: {} }, res(), true), undefined)
    })
  })

  it('⛔ conversa alvo de outro projeto (ou sem projeto): ler, mandar e reconfigurar recusados; a lista traz só as do projeto', async () => {
    const sessions: Record<string, { agentId: string; metadata?: Record<string, unknown> }> = {
      sp: { agentId: 'atlas', metadata: { project: 'P' } },
      sq: { agentId: 'atlas', metadata: { project: 'Q' } },
      sn: { agentId: 'atlas' },
      'sa-q': { agentId: 'a-q' },
    }
    const api: TSelfApi = async (_method, path) => {
      const session = /^\/sessions\/([^/]+)$/.exec(path)
      if (session) return sessions[session[1]] ? { ok: true, status: 200, result: sessions[session[1]] } : { ok: false, status: 404 }
      const agent = /^\/agents\/([^/]+)$/.exec(path)
      if (agent) return { ok: true, status: 200, result: agent[1] === 'a-q' ? { projectId: 'Q' } : {} }
      if (path === '/conversations') return { ok: true, status: 200, result: { sessions: Object.entries(sessions).map(([id, item]) => ({ id, ...item })) } }
      return { ok: true, status: 200, result: {} }
    }
    for (const scope of [{ projectId: 'P', unrestricted: false }, { unrestricted: true }]) {
      const guarded = scopedWrites(api, scope)
      const own = scope.projectId ? 'sp' : 'sn'
      for (const id of Object.keys(sessions).filter((key) => key !== own)) {
        assert.ok(refused(await guarded('POST', `/sessions/${id}/turns`, { body: { message: 'x' } })), `${id} turns`)
        assert.ok(refused(await guarded('GET', `/sessions/${id}/turns/0`)), `${id} turn`)
        assert.ok(refused(await guarded('PATCH', `/sessions/${id}`, { body: {} })), `${id} patch`)
      }
      assert.strictEqual((await guarded('POST', `/sessions/${own}/turns`, { body: { message: 'x' } })).ok, true)
      const listed = (await guarded('GET', '/conversations')).result as { sessions: Array<{ id: string }> }
      assert.deepStrictEqual(
        listed.sessions.map((item) => item.id),
        [own],
      )
    }
  })
})
