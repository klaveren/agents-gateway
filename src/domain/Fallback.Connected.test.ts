import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from './enums/EMode.Enum'
import { connectedTargets, defaultModelOf, IModelGroup, missingGroups, resolveConnected, stepUnavailable } from './Fallback.Policy'
import { IAgent } from './models/Agent.Model'

const SONNET = { provider: 'claude', model: 'claude-sonnet-5' }
const OPUS = { provider: 'claude', model: 'claude-opus-5' }
const QWEN = { provider: 'alibaba', model: 'qwen-max' }
const group = (id: string, ...steps: Array<typeof SONNET>): IModelGroup => ({ id, name: id, steps })

/** 🔌 A cascata do projeto conectado: da origem só o nome do grupo; o resto, desta máquina. */
describe('Fallback.Policy — projeto conectado', () => {
  const runs = (step: { provider: string }) => step.provider !== 'alibaba'

  it('a cascata completa, nível a nível', () => {
    const agent = { modelGroup: 'executor-low' }
    const all = {
      project: { modelGroups: [group('executor-low', SONNET), group('p-padrao', OPUS)], defaultModelGroup: 'p-padrao', defaultModel: OPUS },
      gateway: { modelGroups: [group('g-padrao', SONNET)], defaultModelGroup: 'g-padrao', defaultModel: SONNET },
    }
    assert.strictEqual(resolveConnected(agent, all.gateway, all.project, runs).source, 'agent-group')
    const noAgentGroup = { ...all.project, modelGroups: [group('p-padrao', OPUS)] }
    assert.strictEqual(resolveConnected(agent, all.gateway, noAgentGroup, runs).source, 'project-default-group')
    assert.strictEqual(resolveConnected(agent, all.gateway, { defaultModel: OPUS }, runs).source, 'gateway-default-group')
    const models = resolveConnected(agent, { defaultModel: SONNET }, { defaultModel: OPUS }, runs)
    assert.deepStrictEqual([models.source, models.defaultModel], ['project-default-model', OPUS])
    assert.strictEqual(resolveConnected(agent, { defaultModel: SONNET }, undefined, runs).source, 'gateway-default-model')
    assert.deepStrictEqual(resolveConnected(agent, undefined, undefined, runs), {})
  })

  it('⚖️ grupo só com passos que não rodam aqui não conta; `none` segue para o próximo nível', () => {
    const project = { modelGroups: [group('executor-low', QWEN), group('reserva', SONNET)], defaultModelGroup: 'reserva' }
    assert.strictEqual(resolveConnected({ modelGroup: 'executor-low' }, undefined, project, runs).group?.id, 'reserva')
    assert.strictEqual(resolveConnected({ modelGroup: 'none' }, undefined, project, runs).group?.id, 'reserva')
    // O modelo padrão que não roda aqui também não conta.
    assert.strictEqual(defaultModelOf({ defaultModel: SONNET }, { defaultModel: QWEN }, runs)?.source, 'gateway-default-model')
  })

  it('os alvos do conectado: os locais e os passos que rodam (com o sandbox do agente); sem nenhum, o modelo padrão', () => {
    const agent: IAgent = {
      id: 'maya',
      name: 'Maya',
      providers: [{ provider: 'alibaba', models: ['qwen-max'], sandbox: 'workspace-write' }],
      systemPrompt: 'p',
      modes: [EMode.CHAT],
      allowedTools: [],
    }
    const resolution = { group: group('executor-low', QWEN, SONNET) }
    assert.deepStrictEqual(connectedTargets(agent, [], resolution, runs), [{ provider: 'claude', models: ['claude-sonnet-5'], sandbox: 'workspace-write' }])
    assert.deepStrictEqual(connectedTargets(agent, [{ provider: 'claude', models: ['claude-opus-5'] }], resolution, runs), [
      { provider: 'claude', models: ['claude-opus-5', 'claude-sonnet-5'] },
    ])
    assert.deepStrictEqual(connectedTargets(agent, [], { defaultModel: OPUS }, runs), [{ provider: 'claude', models: ['claude-opus-5'], sandbox: 'workspace-write' }])
    assert.deepStrictEqual(connectedTargets(agent, [], {}, runs), [])
  })

  it('⚠️ o alerta: os grupos que os agentes pedem e não existem aqui, com quem pede', () => {
    const agents = [
      { id: 'zeus', modelGroup: 'executor-low' },
      { id: 'maya', modelGroup: 'executor-low' },
      { id: 'atlas', modelGroup: 'planner-high' },
      { id: 'iris', modelGroup: 'none' },
      { id: 'leo' },
    ]
    assert.deepStrictEqual(missingGroups(agents, { modelGroups: [group('planner-high', SONNET)] }, undefined), [{ id: 'executor-low', agents: ['maya', 'zeus'] }])
    assert.deepStrictEqual(missingGroups(agents, undefined, { modelGroups: [group('executor-low', SONNET), group('planner-high', OPUS)] }), [])
  })

  it('por que o passo não roda aqui', () => {
    const providers: Record<string, { enabled: boolean }> = { claude: { enabled: true }, openai: { enabled: false } }
    const facts = { provider: (id: string) => providers[id], modelEnabled: (_: string, model: string) => model !== 'claude-opus-5' }
    assert.strictEqual(stepUnavailable(QWEN, facts), 'provider-missing')
    assert.strictEqual(stepUnavailable({ provider: 'openai', model: 'gpt' }, facts), 'provider-disabled')
    assert.strictEqual(stepUnavailable(OPUS, facts), 'model-disabled')
    assert.strictEqual(stepUnavailable(SONNET, facts), undefined)
  })
})
