import assert from 'node:assert'
import { Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import express from 'express'
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
    app.all(/.*/, (req, res) => res.json({ caller: req.headers[CALLER_HEADER] ?? null, scope: res.locals[TURN_GRANT_LOCAL] ?? null }))
    await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  after(() => server.close())

  const call = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as { caller?: string | null; scope?: { projectId?: string } | null } }
  }

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
