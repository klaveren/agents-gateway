import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { InvalidAgentError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteAgentLocalLayerRepository } from '@infra/persistence/Sqlite.AgentLocalLayerRepository'
import { AgentLocalLayerService } from './AgentLocalLayer.Service'

const SUB = [{ provider: EProvider.CLAUDE_SUB, models: ['claude-sonnet-5'] }]

function build(modes: EMode[]) {
  const agent = {
    id: 'sre',
    name: 'SRE',
    projectId: 'logiccus',
    providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
    systemPrompt: 'faça',
    modes,
    allowedTools: [],
  } as IAgent
  const service = new AgentLocalLayerService({
    repository: new SqliteAgentLocalLayerRepository(':memory:'),
    agents: { entry: () => ({ agent }), rawEntries: () => [{ agent }], applyLocalLayer: () => undefined } as never,
    connected: () => true,
  })
  service.useAgentValidation(async () => ({ rules: { knownTools: [], modelEnabled: () => true }, issues: () => [] }))
  return service
}

describe('camada local: os modelos desta máquina e as lanes da origem', () => {
  it('assinatura (só a lane agent) num agente que a origem roda em chat e agent: grava, sobra a lane agent', async () => {
    const view = await build([EMode.CHAT, EMode.AGENT]).save('logiccus', 'sre', { providers: SUB, allowedTools: [], permissions: [] }, 'dev')
    assert.deepEqual(view.layer.providers, SUB)
  })

  it('⛔ nenhuma lane da origem roda nos modelos locais: recusa, na guia Modelos', async () => {
    await assert.rejects(build([EMode.CHAT]).save('logiccus', 'sre', { providers: SUB, allowedTools: [], permissions: [] }, 'dev'), (error: InvalidAgentError) =>
      error.issues.some((issue) => issue.field === 'providers' && /agent lane/.test(issue.message)),
    )
  })
})
