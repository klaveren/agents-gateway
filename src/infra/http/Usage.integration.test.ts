import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController, makeProvidersController, makeUsageController } from '@composition/factories/Controller.Factory'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

describe('uso (integração)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let member = ''
  let memberId = ''

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const text = await res.text()
    return { status: res.status, text, body: JSON.parse(text) as { ok: boolean; result?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    const controller = makeController()
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
    memberId = (await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })).body.result.id
    member = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token

    // O preço vem SÓ do catálogo: o modelo entra nele (com o preço de fábrica sugerido), como faz quem administra.
    await call('/providers/claude/models', { method: 'POST', token: admin, body: { modelId: 'claude-sonnet-5' } })
    // Uma conversa da Ana e uma de outra pessoa, gravadas direto no repositório. Sonnet 5 de fábrica: $2/$10 por 1M → $3 cada.
    const now = new Date()
    // O `metadata` de cobrança: a conta da Ana é texto; a do outro, número (vira texto no agrupamento).
    for (const [id, owner, billing] of [
      ['da-ana', { id: memberId, email: 'ana@x.test' }, { accountId: 'acme', userId: 'u1' }],
      ['de-outro', { id: 'outro', email: 'outro@x.test' }, { accountId: 42, userId: 'u2' }],
    ] as const) {
      await controller.conversations.saveSession({
        id,
        agentId: 'operador-teste',
        provider: 'claude',
        mode: 'agent',
        model: 'claude-sonnet-5',
        createdAt: now,
        updatedAt: now,
        turns: 1,
        usage: {},
        metadata: { owner, ...billing },
      })
      await controller.conversations.appendTurn({
        sessionId: id,
        index: 0,
        at: now,
        request: 'oi',
        text: 'olá',
        toolCalls: [],
        usage: { inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 },
      })
    }
  })

  after(() => stop())

  it('sem login, 401', async () => {
    assert.strictEqual((await call('/usage/me')).status, 401)
  })

  it('⛔ o membro vê só o próprio uso, e NADA de custo na resposta', async () => {
    const mine = await call('/usage/me?days=7&tz=-180', { token: member })

    assert.strictEqual(mine.status, 200)
    assert.deepStrictEqual([mine.body.result.totals.conversations, mine.body.result.totals.usage.totalTokens], [1, 1_100_000])
    assert.strictEqual(mine.body.result.daily.length, 7)
    assert.ok(!/cost/i.test(mine.text))
  })

  it('⛔ uso por usuário: 404 para membro; para o admin, cada um com custo', async () => {
    assert.strictEqual((await call('/usage/users', { token: member })).status, 404)

    const users = await call('/usage/users?days=30', { token: admin })
    const ana = users.body.result.users.find((user: { ownerId?: string }) => user.ownerId === memberId)
    assert.deepStrictEqual([ana.name, ana.costUsd], ['Ana', 3])
    assert.strictEqual(users.body.result.totals.costUsd, 6)
  })

  it('o detalhe de um usuário, para o admin, vem com custo; para o membro, 404', async () => {
    const detail = await call(`/usage/users/${memberId}`, { token: admin })
    assert.deepStrictEqual([detail.body.result.name, detail.body.result.totals.costUsd, detail.body.result.byModel[0].model], ['Ana', 3, 'claude-sonnet-5'])
    assert.strictEqual((await call(`/usage/users/${memberId}`, { token: member })).status, 404)
  })

  it('⛔ uso por chave do metadata: 404 para membro; para o admin, cada valor com custo, e o filtro recorta', async () => {
    assert.strictEqual((await call('/usage/by/accountId', { token: member })).status, 404)

    const byAccount = await call('/usage/by/accountId?days=30', { token: admin })
    assert.strictEqual(byAccount.status, 200)
    assert.deepStrictEqual(
      byAccount.body.result.groups.map((group: { value: string; conversations: number; costUsd: number }) => [group.value, group.conversations, group.costUsd]).sort(),
      [
        ['42', 1, 3],
        ['acme', 1, 3],
      ],
    )

    const usersOfAcme = await call('/usage/by/userId?accountId=acme', { token: admin })
    assert.deepStrictEqual(
      usersOfAcme.body.result.groups.map((group: { value: string }) => group.value),
      ['u1'],
    )
  })

  it('o detalhe de um valor bate com o grupo; chave inválida ou `owner` é 422', async () => {
    const detail = await call('/usage/by/accountId/42?days=30', { token: admin })
    assert.deepStrictEqual([detail.status, detail.body.result.totals.conversations, detail.body.result.totals.costUsd, detail.body.result.top[0].id], [200, 1, 3, 'de-outro'])

    assert.strictEqual((await call('/usage/by/owner', { token: admin })).status, 422)
    assert.strictEqual((await call("/usage/by/a'b", { token: admin })).status, 422)
    assert.strictEqual((await call('/usage/by/accountId?x%27%29--=1', { token: admin })).status, 422)
  })
})
