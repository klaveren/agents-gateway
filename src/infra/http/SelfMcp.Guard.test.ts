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
    assert.ok(refused(await guarded('POST', '/agents', { body: { id: 'novo' } })), 'sem projectId = global')
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
    assert.strictEqual(written.length, 8)
  })

  it('administrador do gateway numa conversa SEM projeto (o Atlas) escreve onde a conta dele escreve', async () => {
    const { api, written } = fakeApi()
    const guarded = scopedWrites(api, { unrestricted: true })
    assert.strictEqual((await guarded('POST', '/agents', { body: { id: 'n', projectId: 'Q' } })).ok, true)
    assert.strictEqual((await guarded('POST', '/projects', { body: { id: 'z' } })).ok, true)
    assert.strictEqual((await guarded('PUT', '/providers/x/models', { body: {} })).ok, true)
    assert.strictEqual(written.length, 3)
  })

  it('sem projeto e sem ser administrador do gateway, o agente não escreve em lugar nenhum', async () => {
    const { api, written } = fakeApi()
    const guarded = scopedWrites(api, { unrestricted: false })
    assert.ok(refused(await guarded('POST', '/agents', { body: { id: 'n', projectId: 'Q' } })))
    assert.ok(refused(await guarded('POST', '/agents', { body: { id: 'n' } })))
    assert.deepStrictEqual(written, [])
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
      assert.deepStrictEqual(agentScopeOf({ headers: { 'x-gateway-conversation': 'c' } }, res(), true), { unrestricted: true })
      assert.strictEqual(agentScopeOf({ headers: {} }, res(), true), undefined)
    })
  })
})
