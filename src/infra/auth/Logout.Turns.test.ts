import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { NextFunction, Request, Response } from 'express'
import { AccountsService } from '@application/Accounts.Service'
import { readableMcpRefusal } from '@domain/Provider.Failure'
import { requestScope } from '@infra/http/Request.Scope'
import { SqliteUserRepository } from '@infra/persistence/Sqlite.UserRepository'
import { HmacTokenIssuer } from './Hmac.TokenIssuer'
import { liveTurnTokens, LiveTurnTokens } from './Live.TurnTokens'
import { LocalCallerProof } from './Local.CallerProof'
import { ScryptPasswordHasher } from './Scrypt.PasswordHasher'

const PASSWORD = 'senha-forte-de-teste-123'

async function build() {
  const users = new SqliteUserRepository(':memory:')
  const tokens = new HmacTokenIssuer(users.signingSecret())
  const accounts = new AccountsService(users, new ScryptPasswordHasher({ N: 1024, r: 8, p: 1 }), tokens)
  const root = accounts.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, accounts.setupCode)
  const other = await accounts.login('root@x.test', PASSWORD)
  return { accounts, proof: new LocalCallerProof(tokens, users), mine: root.token, other: other.token, id: root.user.id }
}

/** A prova como uma rota a chama: dentro do escopo da rota registrada. */
function proveOn(route: string, proof: LocalCallerProof, token: string): Promise<boolean> {
  return new Promise((resolve, reject) => requestScope('post', route)({} as Request, {} as Response, (() => proof.prove(token).then(resolve, reject)) as NextFunction))
}

describe('Sair: deste navegador ou de todos', () => {
  it('sair encerra só a sessão deste navegador; a do outro aparelho segue', async () => {
    const { accounts, proof, mine, other, id } = await build()
    accounts.logout(id, mine)
    assert.deepStrictEqual([await proof.prove(mine), await proof.prove(other)], [false, true])
  })

  it('sair de todos os aparelhos derruba todas', async () => {
    const { accounts, proof, mine, other, id } = await build()
    accounts.logout(id, mine, true)
    assert.deepStrictEqual([await proof.prove(mine), await proof.prove(other)], [false, false])
  })

  it('⚖️ turno rodando vai até o fim depois de sair, só nas rotas internas; acabou o turno, cai', async () => {
    const { accounts, proof, mine, id } = await build()
    const release = liveTurnTokens().hold(mine)
    accounts.logout(id, mine, true)
    assert.strictEqual(await proveOn('/mcp-proxy/:serverId', proof, mine), true)
    assert.strictEqual(await proveOn('/mcp', proof, mine), true)
    assert.strictEqual(await proveOn('/conversations', proof, mine), false, 'telas e API recusam na hora')
    release()
    assert.strictEqual(await proveOn('/mcp', proof, mine), false)
  })
})

describe('LiveTurnTokens', () => {
  it('conta por token: duas conversas da mesma pessoa; soltar duas vezes não desconta a outra', () => {
    const live = new LiveTurnTokens()
    const first = live.hold('t')
    const second = live.hold('t')
    first()
    first()
    assert.strictEqual(live.holds('t'), true)
    second()
    assert.strictEqual(live.holds('t'), false)
  })
})

describe('readableMcpRefusal', () => {
  it('o "Not found" cru do MCP vira o que aconteceu e o que fazer; o resto passa igual', () => {
    const raw = 'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Not found"},"id":null}'
    assert.match(readableMcpRefusal(raw), /^Um MCP do gateway recusou a chamada no meio do turno/)
    assert.ok(readableMcpRefusal(raw).includes(raw))
    assert.strictEqual(readableMcpRefusal('rate limit'), 'rate limit')
  })
})
