import assert from 'node:assert'
import { describe, it } from 'node:test'
import { Request, Response } from 'express'
import { AgentHooksService } from '@application/AgentHooks.Service'
import { HOOK_DEFAULTS, IAgentHook } from '@domain/models/AgentHook.Model'
import { eventMessage, HooksController } from './Hooks.Controller'

describe('eventMessage — o que o agente recebe de um hook', () => {
  const hook: IAgentHook = {
    agentId: 'a',
    name: 'deploy',
    prompt: 'Resuma.',
    enabled: true,
    verify: 'hmac',
    ...HOOK_DEFAULTS,
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
