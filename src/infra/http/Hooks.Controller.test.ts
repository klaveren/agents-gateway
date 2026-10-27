import assert from 'node:assert'
import { describe, it } from 'node:test'
import { Request } from 'express'
import { HOOK_DEFAULTS, IAgentHook } from '@domain/models/AgentHook.Model'
import { eventMessage } from './Hooks.Controller'

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
