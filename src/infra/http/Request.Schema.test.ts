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
})
