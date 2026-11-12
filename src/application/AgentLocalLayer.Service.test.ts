import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { InvalidAgentError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteAgentLocalLayerRepository } from '@infra/persistence/Sqlite.AgentLocalLayerRepository'
import { AgentLocalLayerService } from './AgentLocalLayer.Service'

const SUB = [{ provider: EProvider.CLAUDE_SUB, models: ['claude-sonnet-5'] }]

function build(modes: EMode[], allowedTools: string[] = [], connected = true) {
  const agent = {
    id: 'sre',
    name: 'SRE',
    projectId: 'logiccus',
    providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
    systemPrompt: 'faça',
    modes,
    allowedTools,
  } as IAgent
  const service = new AgentLocalLayerService({
    repository: new SqliteAgentLocalLayerRepository(':memory:'),
    agents: { entry: () => ({ agent }), rawEntries: () => [{ agent }], applyLocalLayer: () => undefined } as never,
    connected: () => connected,
  })
  service.useAgentValidation(async () => ({ rules: { knownTools: [], modelEnabled: () => true, mcpServerExists: () => true }, issues: () => [] }))
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

describe('camada local: o que veio da origem e não vale aqui', () => {
  const ORIGIN = ['mcp:tickets/*', 'agent:atlas', 'run_bash']

  it('desliga o que a origem tem; o que ela não tem não fica guardado', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    const view = await service.save('logiccus', 'sre', { allowedTools: [], disabledTools: ['mcp:tickets/*', 'agent:fantasma'], permissions: [] }, 'dev')
    assert.deepEqual(view.layer.disabledTools, ['mcp:tickets/*'])
    assert.deepEqual(view.origin.allowedTools, ORIGIN)
    // Religar tudo esvazia a camada.
    assert.deepEqual((await service.save('logiccus', 'sre', { allowedTools: [], disabledTools: [], permissions: [] }, 'dev')).layer.disabledTools, [])
    assert.equal(service.of({ id: 'sre', projectId: 'logiccus' } as IAgent), undefined)
  })

  it('o pedido de permissão aprovado não religa o que está desligado; o agente que saiu some da lista', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    await service.save('logiccus', 'sre', { allowedTools: [], disabledTools: ['agent:atlas', 'run_bash'], permissions: [] }, 'dev')
    service.localRules({ id: 'sre', projectId: 'logiccus' })!.save([{ category: 'terminal', pattern: 'npm test', decision: 'allow' }], 'dev')
    assert.deepEqual(service.get('logiccus', 'sre').layer.disabledTools, ['agent:atlas', 'run_bash'])
    service.forget('atlas')
    assert.deepEqual(service.get('logiccus', 'sre').layer.disabledTools, ['run_bash'])
  })

  it('o que a camada ACRESCENTA (para quem pergunta quem usa um MCP): só no projeto conectado', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    assert.deepEqual(service.extras({ id: 'sre', projectId: 'logiccus' }), [])
    await service.save('logiccus', 'sre', { allowedTools: ['mcp:local/*'], disabledTools: ['mcp:tickets/*'], permissions: [] }, 'dev')
    assert.deepEqual(service.extras({ id: 'sre', projectId: 'logiccus' }), ['mcp:local/*'])
    assert.equal(service.extras({ id: 'solto' }), undefined)
    assert.equal(build([EMode.AGENT], ORIGIN, false).extras({ id: 'sre', projectId: 'logiccus' }), undefined)
  })
})

describe('camada local: o ajuste que um agente faz (patch_agent com localLayer)', () => {
  const ORIGIN = ['mcp:tickets/*', 'agent:atlas', 'run_bash', 'save_agent']

  it('desliga somando ao já desligado; o que o agente não tem volta em `ignored`; o resto da camada fica', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    const rule = { category: 'terminal' as const, pattern: 'npm test', decision: 'allow' as const }
    await service.save('logiccus', 'sre', { allowedTools: ['mcp:local/*'], disabledTools: ['run_bash'], permissions: [rule] }, 'dev')
    const view = await service.adjust('logiccus', 'sre', { disabledTools: ['save_agent', 'fantasma'] }, 'dev')
    assert.deepEqual(view.layer.disabledTools, ['run_bash', 'save_agent'])
    assert.deepEqual(view.ignored, ['fantasma'])
    assert.deepEqual(view.layer.allowedTools, ['mcp:local/*'])
    assert.equal(view.layer.permissions.length, 1)
  })

  it('⛔ a camada que muda durante o ajuste (a regra aprovada na tela, no meio da conferência) não é desfeita', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    let raced = false
    service.useAgentValidation(async () => {
      if (!raced) {
        raced = true
        service.localRules({ id: 'sre', projectId: 'logiccus' })!.save([{ category: 'terminal', pattern: 'npm test', decision: 'allow' }], 'dev')
      }
      return { rules: { knownTools: [], modelEnabled: () => true, mcpServerExists: () => true }, issues: () => [] }
    })
    const view = await service.adjust('logiccus', 'sre', { disabledTools: ['run_bash'] }, 'dev')
    assert.deepEqual(view.layer.disabledTools, ['run_bash'])
    assert.equal(view.layer.permissions.length, 1, 'a regra gravada no meio continua lá')
  })

  it('⛔ não religa: mandar uma lista menor não tira nada do que já está desligado', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    await service.adjust('logiccus', 'sre', { disabledTools: ['run_bash', 'save_agent'] }, 'dev')
    assert.deepEqual((await service.adjust('logiccus', 'sre', { disabledTools: [] }, 'dev')).layer.disabledTools, ['run_bash', 'save_agent'])
  })

  it('o que foi ligado AQUI sai da camada quando o agente pede para desligar', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    await service.save('logiccus', 'sre', { allowedTools: ['mcp:local/*', 'mcp:extra/*'], permissions: [] }, 'dev')
    const view = await service.adjust('logiccus', 'sre', { disabledTools: ['mcp:extra/*'] }, 'dev')
    assert.deepEqual(view.layer.allowedTools, ['mcp:local/*'])
    assert.deepEqual(view.ignored, [])
  })

  it('troca os modelos daqui sem mexer no que está desligado; `null` volta aos da origem', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    await service.adjust('logiccus', 'sre', { disabledTools: ['run_bash'] }, 'dev')
    const view = await service.adjust('logiccus', 'sre', { providers: SUB }, 'dev')
    assert.deepEqual(view.layer.providers, SUB)
    assert.deepEqual(view.layer.disabledTools, ['run_bash'])
    const back = await service.adjust('logiccus', 'sre', { providers: null }, 'dev')
    assert.equal(back.layer.providers, undefined)
    assert.deepEqual(back.layer.disabledTools, ['run_bash'])
  })

  it('⛔ modelos com sandbox mais solto ou rede: recusa (é da tela), e nada é gravado', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    for (const loose of [{ sandbox: 'danger-full-access' }, { network: true }])
      await assert.rejects(service.adjust('logiccus', 'sre', { providers: [{ ...SUB[0], ...loose }] as never }, 'dev'), (error: InvalidAgentError) =>
        error.issues.every((issue) => issue.field === 'providers' && /tela do agente/.test(issue.message)),
      )
    assert.equal(service.of({ id: 'sre', projectId: 'logiccus' } as IAgent), undefined)
  })

  it('⛔ agente de outro projeto, ou projeto que não é conectado: não existe', async () => {
    await assert.rejects(build([EMode.AGENT], ORIGIN).adjust('outro', 'sre', { disabledTools: ['run_bash'] }, 'dev'), /sre/)
    await assert.rejects(build([EMode.AGENT], ORIGIN, false).adjust('logiccus', 'sre', { disabledTools: ['run_bash'] }, 'dev'), /sre/)
  })
})

describe('camada local: ligar ferramentas aqui (o pedido `agent-local`, aprovado na tela)', () => {
  const ORIGIN = ['mcp:tickets/*', 'agent:atlas']
  const sre = {
    id: 'sre',
    name: 'SRE',
    projectId: 'logiccus',
    providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
    systemPrompt: 'faça',
    modes: [EMode.AGENT],
    allowedTools: ORIGIN,
  } as IAgent
  const validation = { rules: { knownTools: [], modelEnabled: () => true, mcpServerExists: (id: string) => id !== 'fantasma' }, issues: () => [] }

  it('a que não veio da origem entra a mais; nada é gravado até o `save`', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    const plan = service.enabling(sre, ['mcp:local/*'])!
    assert.deepEqual(plan.before.allowedTools, ORIGIN)
    assert.deepEqual(plan.after.allowedTools, [...ORIGIN, 'mcp:local/*'])
    plan.check(validation)
    assert.equal(service.of(sre), undefined)
    plan.save(validation, 'dev')
    assert.deepEqual(service.of(sre)?.allowedTools, ['mcp:local/*'])
    assert.equal(service.of(sre)?.updatedBy, 'dev')
  })

  it('a que a camada tinha desligado volta: sai de `disabledTools`, não entra em `allowedTools`', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    await service.adjust('logiccus', 'sre', { disabledTools: ['agent:atlas'] }, 'dev')
    const plan = service.enabling(sre, ['agent:atlas'])!
    assert.deepEqual(plan.before.allowedTools, ['mcp:tickets/*'])
    assert.deepEqual(plan.after.allowedTools, ORIGIN)
    plan.save(validation, 'dev')
    // A camada que ficou vazia some: o agente volta a rodar como veio.
    assert.equal(service.of(sre), undefined)
  })

  it('a que já está ligada não muda o agente; o resto da camada fica como estava', async () => {
    const service = build([EMode.AGENT], ORIGIN)
    const rule = { category: 'terminal' as const, pattern: 'npm test', decision: 'allow' as const }
    await service.save('logiccus', 'sre', { allowedTools: ['mcp:local/*'], disabledTools: ['agent:atlas'], permissions: [rule] }, 'dev')
    const plan = service.enabling(sre, ['mcp:tickets/*', 'mcp:local/*'])!
    assert.deepEqual(plan.after.allowedTools, plan.before.allowedTools)
    plan.save(validation, 'dev')
    assert.deepEqual(service.of(sre)?.disabledTools, ['agent:atlas'])
    assert.deepEqual(service.of(sre)?.permissions, [rule])
  })

  it('⛔ o que o cadastro recusa (MCP que não existe) não passa na conferência nem grava', () => {
    const service = build([EMode.AGENT], ORIGIN)
    const refusing = {
      ...validation,
      issues: (agent: IAgent) => (agent.allowedTools.includes('mcp:fantasma/*') ? [{ field: 'allowedTools', message: 'unknown MCP server: fantasma' }] : []),
    }
    const plan = service.enabling(sre, ['mcp:fantasma/*'])!
    assert.throws(() => plan.check(refusing), InvalidAgentError)
    assert.throws(() => plan.save(refusing, 'dev'), InvalidAgentError)
    assert.equal(service.of(sre), undefined)
  })

  it('agente global, ou de projeto que não é conectado: não há camada', () => {
    assert.equal(build([EMode.AGENT], ORIGIN, false).enabling(sre, ['mcp:local/*']), undefined)
    assert.equal(build([EMode.AGENT], ORIGIN).enabling({ ...sre, projectId: undefined }, ['mcp:local/*']), undefined)
  })
})
