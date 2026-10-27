import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { estimateTokens, toolTokens } from '@domain/Token.Estimate'
import { agentFootprint } from './Agent.Footprint'

describe('agentFootprint', () => {
  const agent: IAgent = {
    id: 'dev',
    name: 'Dev',
    projectId: 'xpto',
    providers: [{ provider: EProvider.CLAUDE, models: ['m'] }],
    soul: 'Calmo.',
    systemPrompt: 'Você escreve código.',
    modes: [EMode.AGENT],
    allowedTools: ['run_bash', 'mcp:crm/stats', 'mcp:fora/*', 'sdk:Read'],
  }
  const stats = { name: 'stats', description: 'Stats.', inputSchema: { type: 'object' } }
  const deps = {
    guidance: {
      environmentParts: (projectId?: string) => ({ rules: `## Regras do ambiente\n1. de ${projectId}`, index: '## Documentos de referência\n- [spec] a — A' }),
      hasDocs: () => true,
    },
    localFor: (allowed: readonly string[]) => allowed.filter((name) => ['run_bash', 'read_doc'].includes(name)).map((name) => ({ name, description: `${name}.` })),
    mcpTools: async (server: string) => (server === 'crm' ? [stats, { name: 'outra', description: 'Não escolhida.' }] : undefined),
  }

  it('cada parte com o seu peso, as mesmas peças da conversa; o total soma só o que se mede', async () => {
    const result = await agentFootprint(agent, 'xpto', deps)
    const by = Object.fromEntries(result.sections.map((section) => [section.key, section]))

    assert.strictEqual(by.soul.tokens, estimateTokens('## Quem você é\nCalmo.\n\n## Como você trabalha\n'))
    assert.strictEqual(by.instructions.tokens, estimateTokens('Você escreve código.'))
    assert.strictEqual(by.rules.tokens, estimateTokens('## Regras do ambiente\n1. de xpto'))
    // O `read_doc` entra sozinho quando há índice, como na conversa.
    assert.deepStrictEqual(by.local.items?.map((item) => item.name).sort(), ['read_doc', 'run_bash'])
    assert.deepStrictEqual([by['mcp:crm'].tokens, by['mcp:crm'].items?.length], [toolTokens(stats), 1])
    assert.deepStrictEqual([by['mcp:fora'].tokens, by['mcp:fora'].note], [null, 'fora do ar: não medido'])
    assert.deepStrictEqual([by.sdk.tokens, by.sdk.items?.map((item) => item.name)], [null, ['sdk:Read']])
    assert.strictEqual(
      result.total,
      result.sections.reduce((sum, section) => sum + (section.tokens ?? 0), 0),
    )
    assert.strictEqual(result.project, 'xpto')
  })

  it('sem soul nem ambiente, essas partes nem aparecem', async () => {
    const bare = await agentFootprint({ ...agent, soul: undefined, allowedTools: [] }, undefined, { localFor: () => [], mcpTools: async () => undefined })
    assert.deepStrictEqual(
      bare.sections.map((section) => section.key),
      ['instructions'],
    )
  })
})
