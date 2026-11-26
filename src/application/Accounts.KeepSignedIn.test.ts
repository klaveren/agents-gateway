import assert from 'node:assert'
import { describe, it } from 'node:test'
import { SessionNotFoundError } from '@domain/errors/Domain.Error'
import { deviceLabel } from '@domain/LoginSession.Policy'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { LocalCallerProof } from '@infra/auth/Local.CallerProof'
import { ScryptPasswordHasher } from '@infra/auth/Scrypt.PasswordHasher'
import { SqliteUserRepository } from '@infra/persistence/Sqlite.UserRepository'
import { AccountsService } from './Accounts.Service'

const PASSWORD = 'frase longa o bastante'
const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('AccountsService — "Manter conectado"', () => {
  /** Relógio perto do real: a limpeza das revogadas (`revokeSession`) usa a hora de verdade. */
  const build = async () => {
    let now = Date.now()
    const users = new SqliteUserRepository(':memory:')
    const tokens = new HmacTokenIssuer('s', 12 * HOUR, () => now)
    const service = new AccountsService(users, new ScryptPasswordHasher({ N: 1024, r: 8, p: 1 }), tokens, () => now, 'AAAA-BBBB-CCCC', { keepTtlMs: 30 * DAY, renewAfterMs: HOUR })
    // A sessão do setup sai logo: os testes contam só as sessões que abrem.
    const first = service.setup({ email: 'ana@x.test', name: 'Ana', password: PASSWORD }, 'AAAA-BBBB-CCCC')
    service.logout(first.user.id, first.token)
    const proof = new LocalCallerProof(tokens, users)
    const login = (keep: boolean, device = 'Safari · iPhone') => service.login('ana@x.test', PASSWORD, '', { keep, device })
    const id = users.findByEmail('ana@x.test')!.id
    return { service, users, tokens, proof, login, id, now: () => now, advance: (ms: number) => (now += ms) }
  }

  it('marcada: 30 dias; desmarcada: 12 h, como sempre', async () => {
    const { login, now } = await build()
    const kept = await login(true)
    const short = await login(false)
    assert.ok(Math.abs(kept.expiresAt.getTime() - (now() + 30 * DAY)) < 1000)
    assert.ok(Math.abs(short.expiresAt.getTime() - (now() + 12 * HOUR)) < 1000)
  })

  it('a renovação desliza: só depois do intervalo, e volta a 30 dias a partir de agora (mesma sessão)', async () => {
    const { service, tokens, login, advance, now } = await build()
    const kept = await login(true)

    advance(30 * 60_000)
    assert.strictEqual(service.keepAlive(kept.token), undefined, 'antes de 1 h não renova')

    advance(31 * 60_000)
    const renewed = service.keepAlive(kept.token)
    assert.ok(renewed)
    assert.ok(Math.abs(renewed.expiresAt.getTime() - (now() + 30 * DAY)) < 1000)
    assert.strictEqual(tokens.verify(renewed.token)?.sid, tokens.verify(kept.token)?.sid)
    assert.strictEqual(service.keepAlive(renewed.token), undefined, 'o token novo espera mais 1 h')

    // 29 dias sem usar, uma renovação, e mais 29 dias: ainda vale (passaria de 30 sem deslizar).
    advance(29 * DAY)
    const again = service.keepAlive(renewed.token)
    assert.ok(again)
    advance(29 * DAY)
    assert.ok(tokens.verify(again.token))
  })

  it('desmarcada não renova; vencida não renova', async () => {
    const { service, login, advance } = await build()
    const short = await login(false)
    advance(2 * HOUR)
    assert.strictEqual(service.keepAlive(short.token), undefined)

    const kept = await login(true)
    advance(31 * DAY)
    assert.strictEqual(service.keepAlive(kept.token), undefined)
  })

  it('⛔ revogada não renova: encerrar, sair deste aparelho, sair de todos e trocar a senha', async () => {
    const { service, proof, login, id, advance } = await build()
    const ended = await login(true)
    const others = await login(true)
    const here = await login(true)
    service.endSession(id, (await service.listSessions(id, ended.token)).find((session) => session.current)!.id)

    advance(2 * HOUR)
    assert.strictEqual(service.keepAlive(ended.token), undefined)
    assert.strictEqual(await proof.prove(ended.token), false)

    service.logout(id, others.token)
    assert.strictEqual(service.keepAlive(others.token), undefined)
    assert.strictEqual(await proof.prove(others.token), false)

    const changed = await service.changeOwnPassword(id, PASSWORD, 'outra frase longa', '', here.token)
    assert.strictEqual(await proof.prove(here.token), false, 'a sessão longa de antes cai')
    assert.strictEqual(service.keepAlive(here.token), undefined)
    assert.ok(Math.abs(changed.expiresAt.getTime() - (Date.now() + 2 * HOUR + 30 * DAY)) < 60_000, 'esta tela continua no "Manter conectado"')

    const all = await service.login('ana@x.test', 'outra frase longa', '', { keep: true })
    service.logout(id, all.token, true)
    assert.strictEqual(await proof.prove(all.token), false)
    assert.strictEqual(service.keepAlive(all.token), undefined)
  })

  it('a lista: aparelho, último uso, a atual marcada; encerrar uma e encerrar as outras', async () => {
    const { service, proof, login, id, advance } = await build()
    const phone = await login(true, 'App · iPhone')
    advance(1000)
    const mac = await login(false, 'Chrome · Mac')
    advance(1000)
    const here = await login(true, 'Safari · Mac')

    advance(5 * 60_000)
    service.keepAlive(phone.token)
    const list = service.listSessions(id, here.token)
    assert.deepStrictEqual(
      list.map((session) => [session.device, session.keep, session.current]),
      [
        ['App · iPhone', true, false],
        ['Safari · Mac', true, true],
        ['Chrome · Mac', false, false],
      ],
    )

    // Sessão de outra conta (ou inexistente): a mesma recusa.
    assert.throws(() => service.endSession('u_outro', list[0].id), SessionNotFoundError)
    service.endSession(id, list.find((session) => session.device === 'Chrome · Mac')!.id)
    assert.strictEqual(await proof.prove(mac.token), false)
    assert.deepStrictEqual(
      service.listSessions(id, here.token).map((session) => session.device),
      ['App · iPhone', 'Safari · Mac'],
    )

    const kept = service.endOtherSessions(id, here.token)
    assert.strictEqual(await proof.prove(phone.token), false)
    assert.strictEqual(await proof.prove(here.token), false, 'até a cópia antiga desta cai: volta o token novo')
    assert.strictEqual(await proof.prove(kept.token), true)
    assert.deepStrictEqual(
      service.listSessions(id, kept.token).map((session) => [session.device, session.keep, session.current]),
      [['Safari · Mac', true, true]],
    )
  })
})

describe('deviceLabel', () => {
  it('resume o user-agent em navegador · aparelho', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    assert.strictEqual(deviceLabel(iphone), 'Safari · iPhone')
    assert.strictEqual(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'), 'App · iPhone')
    assert.strictEqual(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'), 'Chrome · Mac')
    assert.strictEqual(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0'), 'Edge · Windows')
    assert.strictEqual(deviceLabel('curl/8.7.1'), 'curl')
    assert.strictEqual(deviceLabel(undefined), 'Desconhecido')
  })
})
