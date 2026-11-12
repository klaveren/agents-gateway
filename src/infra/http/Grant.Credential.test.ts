import assert from 'node:assert'
import { Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import { IDENTITY_HEADERS } from '@domain/Agent.Identity'
import { TurnGrants } from '@infra/tools/Turn.Grants'
import { grantCredential } from './Grant.Credential'
import { CALLER_HEADER, requireCaller, TURN_GRANT_LOCAL } from './Security.Middleware'

describe('Grant.Credential', () => {
  const grants = new TurnGrants()
  let server: Server
  let base = ''
  before(async () => {
    const app = express()
    app.use(grantCredential(grants))
    app.use(requireCaller())
    app.all(/.*/, (req, res) =>
      res.json({
        caller: req.headers[CALLER_HEADER] ?? null,
        scope: res.locals[TURN_GRANT_LOCAL] ?? null,
        identity: Object.fromEntries(Object.entries(IDENTITY_HEADERS).map(([key, name]) => [key, req.headers[name] ?? null])),
      }),
    )
    await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  after(() => server.close())

  const call = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers })
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as {
        caller?: string | null
        scope?: { projectId?: string } | null
        identity?: Record<'agent' | 'conversation' | 'project', string | null>
      },
    }
  }
  /** O que o agente escreveria nos cabeçalhos de identidade para se passar por outro. */
  const FORGED = { 'x-gateway-agent': 'outro', 'x-gateway-conversation': 'c9', 'x-gateway-project': 'q' }

  it('⛔ a concessão vira a credencial do dono do turno, por dentro: o agente só apresenta o X-Turn-Grant', async () => {
    const grant = grants.register({ tools: [], context: { token: 'jwt-do-dono', projectId: 'p1', agentId: 'a1' } })
    for (const path of ['/v1/turn-tools', '/v1/mcp', '/v1/mcp-proxy/srv']) {
      const answer = await call(path, { 'X-Turn-Grant': grant })
      assert.strictEqual(answer.status, 200, path)
      assert.strictEqual(answer.body.caller, 'Bearer jwt-do-dono')
      assert.strictEqual(answer.body.scope?.projectId, 'p1')
    }
  })

  it('⛔ o que o chamador mandou no cabeçalho da credencial não vale junto com a concessão', async () => {
    const grant = grants.register({ tools: [], context: { token: 'jwt-do-dono' } })
    const answer = await call('/v1/mcp', { 'X-Turn-Grant': grant, 'X-Tool-Authorization': 'Bearer outro' })
    assert.strictEqual(answer.body.caller, 'Bearer jwt-do-dono')
  })

  it('⛔ a identidade (agente, conversa, projeto) é a do turno: a que o chamador escreveu nos cabeçalhos não vale', async () => {
    const grant = grants.register({ tools: [], context: { token: 'jwt-do-dono', agentId: 'a1', sessionId: 'c1', projectId: 'casa', conversationProjectId: 'p1' } })
    for (const path of ['/v1/turn-tools', '/v1/mcp', '/v1/mcp-proxy/srv']) {
      const answer = await call(path, { 'X-Turn-Grant': grant, ...FORGED })
      assert.deepStrictEqual(answer.body.identity, { agent: 'a1', conversation: 'c1', project: 'p1' }, path)
    }
  })

  it('⛔ o que o turno não tem não entra pelo cabeçalho: agente global, conversa fora de projeto', async () => {
    const grant = grants.register({ tools: [], context: { token: 'jwt-do-dono', agentId: 'atlas', sessionId: 'c1' } })
    assert.deepStrictEqual((await call('/v1/mcp', { 'X-Turn-Grant': grant, ...FORGED })).body.identity, { agent: 'atlas', conversation: 'c1', project: null })
    const bare = grants.register({ tools: [], context: { token: 'jwt-do-dono' } })
    assert.deepStrictEqual((await call('/v1/mcp', { 'X-Turn-Grant': bare, ...FORGED })).body.identity, { agent: null, conversation: null, project: null })
  })

  it('sem concessão (a conexão por dentro do gateway, ou a pessoa com a credencial dela), os cabeçalhos seguem como vieram', async () => {
    const answer = await call('/v1/mcp', { 'X-Tool-Authorization': 'Bearer da-pessoa', ...FORGED })
    assert.deepStrictEqual(answer.body.identity, { agent: 'outro', conversation: 'c9', project: 'q' })
    // Fora das rotas do turno a concessão não é lida: nada muda.
    const grant = grants.register({ tools: [], context: { token: 'jwt-do-dono', agentId: 'a1' } })
    const other = await call('/v1/settings', { 'X-Turn-Grant': grant, 'X-Tool-Authorization': 'Bearer da-pessoa', ...FORGED })
    assert.deepStrictEqual(other.body.identity, { agent: 'outro', conversation: 'c9', project: 'q' })
  })

  it('a concessão só abre as rotas do turno; em qualquer outra, sem credencial é 401', async () => {
    const grant = grants.register({ tools: [], context: { token: 'jwt-do-dono' } })
    assert.strictEqual((await call('/v1/auth/tokens', { 'X-Turn-Grant': grant })).status, 401)
    assert.strictEqual((await call('/v1/settings', { 'X-Turn-Grant': grant })).status, 401)
  })

  it('concessão desconhecida ou que já acabou: nada entra', async () => {
    const grant = grants.register({ tools: [], context: { token: 'jwt-do-dono' } })
    grants.release(grant)
    assert.strictEqual((await call('/v1/mcp', { 'X-Turn-Grant': grant })).status, 401)
    assert.strictEqual((await call('/v1/mcp', { 'X-Turn-Grant': 'inventado' })).status, 401)
  })
})
