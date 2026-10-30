import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { ambientSection } from '@domain/Ambient.Policy'
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
    localFor: (allowed: readonly string[]) => allowed.filter((name) => ['run_bash', 'read_doc', 'search_docs'].includes(name)).map((name) => ({ name, description: `${name}.` })),
    mcpTools: async (server: string) => (server === 'crm' ? [stats, { name: 'outra', description: 'Não escolhida.' }] : undefined),
    projectName: (id: string) => (id === 'xpto' ? 'XPTO' : undefined),
    projectDir: (id: string) => `/dados/projects/${id}`,
  }

  it('cada parte com o seu peso, as mesmas peças da conversa; o total soma só o que se mede', async () => {
    const result = await agentFootprint(agent, 'xpto', deps)
    const by = Object.fromEntries(result.sections.map((section) => [section.key, section]))

    assert.strictEqual(by.soul.tokens, estimateTokens('## Quem você é\nCalmo.\n\n## Como você trabalha\n'))
    assert.strictEqual(by.instructions.tokens, estimateTokens('Você escreve código.'))
    // O "## Ambiente" como o `AgentProvider` o compõe para uma conversa no projeto do agente.
    assert.strictEqual(by.ambient.tokens, estimateTokens(ambientSection({ agentId: 'dev', project: { id: 'xpto', name: 'XPTO', own: true }, directory: '/dados/projects/xpto' })))
    assert.deepStrictEqual(
      result.sections.slice(0, 4).map((section) => section.key),
      ['soul', 'instructions', 'ambient', 'rules'],
      'na ordem do system prompt',
    )
    assert.strictEqual(by.rules.tokens, estimateTokens('## Regras do ambiente\n1. de xpto'))
    // O `read_doc` e o `search_docs` entram sozinhos quando há índice, como na conversa.
    assert.deepStrictEqual(by.local.items?.map((item) => item.name).sort(), ['read_doc', 'run_bash', 'search_docs'])
    assert.deepStrictEqual([by['mcp:crm'].tokens, by['mcp:crm'].items?.length], [toolTokens(stats), 1])
    assert.deepStrictEqual([by['mcp:fora'].tokens, by['mcp:fora'].note], [null, 'fora do ar: não medido'])
    assert.deepStrictEqual([by.sdk.tokens, by.sdk.items?.map((item) => item.name)], [null, ['sdk:Read']])
    assert.strictEqual(
      result.total,
      result.sections.reduce((sum, section) => sum + (section.tokens ?? 0), 0),
    )
    assert.strictEqual(result.project, 'xpto')
  })

  it('sem soul nem rules, essas partes nem aparecem; o "## Ambiente" sempre (o id do agente, a pasta vazia da conversa)', async () => {
    const bare = await agentFootprint({ ...agent, projectId: undefined, soul: undefined, allowedTools: [] }, undefined, { localFor: () => [], mcpTools: async () => undefined })
    assert.deepStrictEqual(
      bare.sections.map((section) => section.key),
      ['instructions', 'ambient'],
    )
    assert.strictEqual(bare.sections[1].tokens, estimateTokens(ambientSection({ agentId: 'dev' })))
  })
})
