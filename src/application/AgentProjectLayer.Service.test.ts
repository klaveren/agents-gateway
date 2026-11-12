import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { InvalidAgentError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteAgentProjectLayerRepository } from '@infra/persistence/Sqlite.AgentProjectLayerRepository'
import { AgentProjectLayerService } from './AgentProjectLayer.Service'

const ATLAS = {
  id: 'atlas',
  name: 'Atlas',
  providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
  systemPrompt: 'faça',
  modes: [EMode.AGENT],
  allowedTools: ['cap:terminal', 'mcp:gateway/*', 'agent:construtor'],
  permissions: [{ category: 'terminal', pattern: 'git status', decision: 'allow' }],
} as IAgent
const SRE = { ...ATLAS, id: 'sre', projectId: 'bh' } as IAgent

function build() {
  const agents: Record<string, IAgent> = { atlas: ATLAS, sre: SRE }
  const service = new AgentProjectLayerService({
    repository: new SqliteAgentProjectLayerRepository(':memory:'),
    agents: { entry: (id: string) => (agents[id] ? { agent: agents[id] } : undefined) } as never,
    projectExists: (id) => ['bh', 'xpto'].includes(id),
  })
  // O MCP `crm` é só do projeto bh; o `gateway`, global. A delegação a agente de outro projeto vem do `issues`.
  service.useAgentValidation(async () => ({
    rules: {
      knownTools: ['cap:terminal'],
      modelEnabled: () => true,
      agentExists: (id) => ['sre', 'de-xpto', 'construtor'].includes(id),
      mcpServerExists: (server, projectId) => server === 'gateway' || (server === 'crm' && projectId === 'bh'),
    },
    issues: (agent) =>
      agent.allowedTools.includes('agent:de-xpto') && agent.projectId !== 'xpto' ? [{ field: 'allowedTools', message: 'agent:de-xpto is in another project (xpto)' }] : [],
  }))
  return service
}

describe('AgentProjectLayerService — a camada do projeto do agente global', () => {
  it('⚖️ vale só no projeto dela: em bh o Atlas ganha o MCP do bh e a regra, e perde a delegação; em xpto, é a base', async () => {
    const service = build()
    const view = await service.save(
      'bh',
      'atlas',
      { allowedTools: ['mcp:crm/*'], disabledTools: ['agent:construtor'], permissions: [{ category: 'network', pattern: 'crm.bh.local', decision: 'allow' }] },
      'ana',
    )
    assert.deepEqual(view.origin.allowedTools, ATLAS.allowedTools)
    const inBh = service.apply(ATLAS, 'bh')
    assert.deepEqual(inBh.allowedTools, ['cap:terminal', 'mcp:gateway/*', 'mcp:crm/*'])
    assert.deepEqual(service.apply(ATLAS, 'xpto'), ATLAS)
    assert.deepEqual(service.apply(ATLAS, undefined), ATLAS)
    assert.deepEqual(
      service.rules(ATLAS, 'bh')?.map((rule) => rule.pattern),
      ['git status', 'crm.bh.local'],
    )
    assert.deepEqual(service.rules(ATLAS, 'xpto'), ATLAS.permissions)
  })

  it('⛔ conferida como o agente que roda no projeto: MCP de outro projeto e delegação cruzada são recusados', async () => {
    const service = build()
    await assert.rejects(service.save('xpto', 'atlas', { allowedTools: ['mcp:crm/*'], permissions: [] }, 'ana'), InvalidAgentError)
    await assert.rejects(service.save('bh', 'atlas', { allowedTools: ['agent:de-xpto'], permissions: [] }, 'ana'), InvalidAgentError)
    await service.save('xpto', 'atlas', { allowedTools: ['agent:de-xpto'], permissions: [] }, 'ana')
  })

  it('⛔ só agente global tem camada; projeto que não existe é 404', async () => {
    const service = build()
    await assert.rejects(service.save('bh', 'sre', { allowedTools: [], permissions: [] }, 'ana'), InvalidAgentError)
    assert.throws(() => service.get('nao-existe', 'atlas'))
    assert.equal(service.of(SRE, 'bh'), undefined)
  })

  it('vazia apaga; o agente apagado e o projeto apagado levam a camada; a delegação a quem saiu some', async () => {
    const service = build()
    await service.save('bh', 'atlas', { allowedTools: ['agent:sre'], permissions: [] }, 'ana')
    await service.save('xpto', 'atlas', { allowedTools: ['mcp:gateway/list_agents'], permissions: [] }, 'ana')
    assert.ok(service.of(ATLAS, 'bh'))
    service.forget('sre')
    assert.equal(service.of(ATLAS, 'bh'), undefined)
    service.removeProject('xpto')
    assert.equal(service.of(ATLAS, 'xpto'), undefined)
    await service.save('bh', 'atlas', { allowedTools: ['mcp:crm/*'], permissions: [] }, 'ana')
    await service.save('bh', 'atlas', { allowedTools: [], permissions: [] }, 'ana')
    assert.equal(service.of(ATLAS, 'bh'), undefined)
  })
})
