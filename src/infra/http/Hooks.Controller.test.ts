import assert from 'node:assert'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { Request, Response } from 'express'
import { AgentHooksService } from '@application/AgentHooks.Service'
import { HOOK_DEFAULTS, IAgentHook } from '@domain/models/AgentHook.Model'
import { SqliteAgentHookRepository } from '@infra/persistence/Sqlite.AgentHookRepository'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { drain } from './Drain.State'
import { eventMessage, HooksController } from './Hooks.Controller'

describe('eventMessage — o que o agente recebe de um hook', () => {
  const hook: IAgentHook = {
    agentId: 'a',
    name: 'deploy',
    prompt: 'Resuma.',
    enabled: true,
    verify: 'hmac',
    ...HOOK_DEFAULTS,
    requireTimestamp: false,
    session: 'new',
    runAs: 'u',
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const request = (headers: Record<string, string>, query: Record<string, string> = {}) => ({ headers, query }) as unknown as Request

  it('⛔ credenciais e assinatura ficam de fora; headers x-*, user-agent e a query (sem `key`) entram', () => {
    const text = eventMessage(
      hook,
      request(
        {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=abc',
          authorization: 'Bearer s',
          'x-hook-key': 'k',
          'x-forwarded-for': '1.2.3.4',
          'x-github-event': 'push',
          'user-agent': 'GitHub-Hookshot',
          accept: '*/*',
        },
        { key: 'segredo', env: 'prod' },
      ),
      Buffer.from('{"a":1}'),
      new Date('2026-10-27T12:00:00Z'),
    )
    assert.match(text, /^Resuma\.\n\n## Evento recebido\n- hook: deploy · 2026-10-27T12:00:00.000Z/)
    assert.match(text, /"x-github-event":"push"/)
    assert.match(text, /"user-agent":"GitHub-Hookshot"/)
    assert.match(text, /- query: \{"env":"prod"\}/)
    assert.match(text, /```json\n\{\n {2}"a": 1\n\}\n```/)
    for (const secret of ['sha256=abc', 'Bearer s', '"k"', 'segredo', '1.2.3.4', 'accept']) assert.ok(!text.includes(secret), secret)
  })

  it('corpo grande é cortado com aviso; corpo vazio é dito', () => {
    const big = eventMessage(hook, request({ 'content-type': 'text/plain' }), Buffer.from('x'.repeat(150_000)))
    assert.match(big, /\(corpo cortado em 100000 caracteres\)$/)
    assert.ok(big.length < 101_000)
    assert.match(eventMessage(hook, request({}), Buffer.alloc(0)), /\(corpo vazio\)/)
  })
})

describe('HooksController.receive — a cota depois de conferir a chave', () => {
  const hook = {
    agentId: 'a',
    name: 'deploy',
    prompt: 'p',
    enabled: true,
    verify: 'key',
    ...HOOK_DEFAULTS,
    session: 'new',
    runAs: 'u',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IAgentHook
  const build = () => {
    process.env.HOOK_RATE_LIMIT = '2'
    process.env.HOOK_FAIL_LIMIT = '3'
    const hooks = { active: (_a: string, name: string) => (name === 'deploy' ? hook : undefined), secretOf: () => 'whk_certa' } as unknown as AgentHooksService
    // Sem sessão da conta: quem passa na chave para no 409, depois de contar o sucesso.
    const controller = new HooksController({ hooks, sessionFor: () => undefined })
    delete process.env.HOOK_RATE_LIMIT
    delete process.env.HOOK_FAIL_LIMIT
    return (ip: string, name: string, key: string) => {
      const reply = { status: 0, code: '' }
      const res = {
        status: (code: number) => ((reply.status = code), res),
        json: (body: { code?: string }) => ((reply.code = body.code ?? ''), res),
        setHeader: () => res,
      } as unknown as Response
      return controller
        .receive({ params: { agentId: 'a', hookName: name }, headers: { 'x-hook-key': key }, body: Buffer.alloc(0), ip, query: {} } as unknown as Request, res)
        .then(() => reply)
    }
  }

  it('⚖️ drenando para um deploy, o hook autenticado recebe 503 `draining` (e o não autenticado segue 401)', async () => {
    const fire = build()
    drain.set(true)
    try {
      assert.deepStrictEqual(await fire('3.3.3.3', 'deploy', 'whk_certa'), { status: 503, code: 'draining' })
      assert.deepStrictEqual(await fire('3.3.3.3', 'deploy', 'errada'), { status: 401, code: 'hook_unauthorized' })
    } finally {
      drain.set(false)
    }
    assert.strictEqual((await fire('3.3.3.3', 'deploy', 'whk_certa')).status, 409, 'sem dreno, segue o fluxo normal')
  })

  it('⛔ 401 uniforme: hook inexistente e chave errada respondem igual', async () => {
    const fire = build()
    assert.deepStrictEqual(await fire('1.1.1.1', 'nao-existe', 'x'), { status: 401, code: 'hook_unauthorized' })
    assert.deepStrictEqual(await fire('1.1.1.1', 'deploy', 'errada'), { status: 401, code: 'hook_unauthorized' })
  })

  it('⛔ o anônimo que erra a chave esgota a cota DELE (por IP), não a do webhook legítimo', async () => {
    const fire = build()
    for (let index = 0; index < 3; index += 1) assert.strictEqual((await fire('9.9.9.9', 'deploy', 'errada')).status, 401)
    assert.strictEqual((await fire('9.9.9.9', 'deploy', 'whk_certa')).status, 429, 'o IP que só errou fica bloqueado')
    // O legítimo, de outro IP, segue com a cota cheia (2 por minuto aqui) e só cai ao passar dela.
    assert.strictEqual((await fire('2.2.2.2', 'deploy', 'whk_certa')).status, 409)
    assert.strictEqual((await fire('2.2.2.2', 'deploy', 'whk_certa')).status, 409)
    assert.strictEqual((await fire('2.2.2.2', 'deploy', 'whk_certa')).status, 429)
  })
})

describe('HooksController.receive — HMAC com `X-Timestamp`: a assinatura só é gasta quando o evento entra', () => {
  const START = 1_800_000_000_000
  const MINUTE = 60_000

  /** O serviço de verdade (SQLite em memória): a validade da assinatura gasta é a dele. `api` = a porta de uma API de mentira. */
  const build = (options: { limit?: number; api?: number } = {}) => {
    const hooks = new AgentHooksService(new SqliteAgentHookRepository(':memory:'), new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:'), () => true)
    const { secret } = hooks.create('a', { name: 'carimbado', prompt: 'p', verify: 'hmac' }, { userId: 'u', label: 'u' })
    const clock = { at: START }
    process.env.HOOK_RATE_LIMIT = String(options.limit ?? 5)
    const controller = new HooksController({ hooks, sessionFor: () => (options.api ? { token: 't' } : undefined), now: () => clock.at })
    delete process.env.HOOK_RATE_LIMIT
    /** O MESMO evento = o mesmo corpo com o mesmo carimbo: a assinatura é a mesma. */
    const fire = (body: string, signedAt = START) => {
      const stamp = String(Math.floor(signedAt / 1000))
      const reply = { status: 0, code: '' }
      const res = {
        status: (code: number) => ((reply.status = code), res),
        json: (sent: { code?: string }) => ((reply.code = sent.code ?? ''), res),
        setHeader: () => res,
      } as unknown as Response
      const req = {
        params: { agentId: 'a', hookName: 'carimbado' },
        headers: { 'x-timestamp': stamp, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(`${stamp}.${body}`).digest('hex')}` },
        body: Buffer.from(body),
        ip: '5.5.5.5',
        query: {},
        socket: { localAddress: '127.0.0.1', localPort: options.api },
      } as unknown as Request
      return controller.receive(req, res).then(() => reply)
    }
    return { fire, clock, hooks }
  }
  const REPLAY = { status: 401, code: 'hook_unauthorized' }

  it('⚖️ drenando, o evento assinado recebe 503 e a assinatura NÃO é gasta: reenviado, o mesmo evento entra — uma vez', async () => {
    const { fire } = build()
    drain.set(true)
    try {
      assert.deepStrictEqual(await fire('{"n":1}'), { status: 503, code: 'draining' })
    } finally {
      drain.set(false)
    }
    assert.strictEqual((await fire('{"n":1}')).status, 409, 'o reenvio passa da assinatura (e para na conta, que aqui não existe)')
    assert.deepStrictEqual(await fire('{"n":1}'), REPLAY)
  })

  it('⛔ fora da cota (429) a assinatura também não é gasta; e o replay conta para o IP, não para a cota do hook', async () => {
    const { fire, clock } = build({ limit: 2 })
    assert.strictEqual((await fire('{"n":1}')).status, 409)
    assert.deepStrictEqual(await fire('{"n":1}'), REPLAY)
    assert.strictEqual((await fire('{"n":2}')).status, 409, 'o replay não entrou na cota de sucesso: o segundo evento ainda cabe')
    assert.strictEqual((await fire('{"n":3}')).status, 429)
    clock.at += MINUTE + 1000
    assert.strictEqual((await fire('{"n":3}')).status, 409, 'depois do `Retry-After`, o mesmo evento assinado entra')
  })

  it('⛔ a assinatura fica gasta enquanto o carimbo valer — o relógio adiantado de quem envia não reabre a janela', async () => {
    const { fire, clock } = build()
    const ahead = START + 4 * MINUTE
    assert.strictEqual((await fire('{"n":1}', ahead)).status, 409)
    // 5 min depois do primeiro uso o carimbo (4 min à frente) ainda está na janela: tem de seguir gasta.
    clock.at = START + 5 * MINUTE + 1000
    assert.deepStrictEqual(await fire('{"n":1}', ahead), REPLAY)
    clock.at = ahead + 5 * MINUTE - 1
    assert.deepStrictEqual(await fire('{"n":1}', ahead), REPLAY, 'no último instante da janela')
    clock.at = ahead + 5 * MINUTE
    assert.deepStrictEqual(await fire('{"n":1}', ahead), REPLAY, 'fora da janela, é o carimbo que recusa')
  })

  it('a conversa não abriu (a API recusou): a assinatura volta, e o reenvio do mesmo evento não é um replay', async () => {
    let refuse = true
    const api = createServer((_req, res) => {
      res.writeHead(refuse ? 503 : 201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(refuse ? { ok: false, code: 'draining', message: 'restarting' } : { ok: true, result: { id: 'c1' } }))
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    try {
      const { fire, hooks } = build({ api: (api.address() as AddressInfo).port })
      assert.deepStrictEqual(await fire('{"n":1}'), { status: 503, code: 'draining' })
      refuse = false
      assert.strictEqual((await fire('{"n":1}')).status, 202)
      assert.deepStrictEqual(await fire('{"n":1}'), REPLAY, 'aceito uma vez: agora é replay')
      // O turno do evento aceito roda solto: espera ele fechar a entrega antes de derrubar a API.
      for (let tries = 0; tries < 100 && hooks.deliveries('a', 'carimbado')[0]?.status !== 'ok'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.deepStrictEqual(
        hooks.deliveries('a', 'carimbado').map((delivery) => delivery.status),
        ['ok', 'error'],
      )
    } finally {
      api.closeAllConnections()
      await new Promise((resolve) => api.close(resolve))
    }
  })
})
