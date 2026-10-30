import assert from 'node:assert'
import { describe, it } from 'node:test'
import { PERMISSION_CATEGORIES } from '@domain/Permission.Policy'
import { agentBodySchema } from './Request.Schema'

describe('agentBodySchema', () => {
  it('aceita no agente toda categoria de permissão do motor (a lista fixa recusava "account")', () => {
    const body = {
      name: 'A',
      providers: [{ provider: 'claude', models: ['m'] }],
      systemPrompt: 'x',
      modes: ['agent'],
      permissions: PERMISSION_CATEGORIES.map((category) => ({ category, pattern: 'x', decision: 'allow' })),
    }
    assert.strictEqual(agentBodySchema.safeParse(body).success, true)
  })

  it('aceita quantas ferramentas o agente precisar: quem decide é quem cria (o teto de 100 barrava um agente com o MCP inteiro)', () => {
    const allowedTools = Array.from({ length: 250 }, (_, index) => `mcp:logiccus/tool_${index}`)
    const body = { name: 'A', providers: [{ provider: 'claude', models: ['m'] }], systemPrompt: 'x', modes: ['agent'], allowedTools }
    const parsed = agentBodySchema.safeParse(body)
    assert.strictEqual(parsed.success && parsed.data.allowedTools.length, 250)
  })
})
