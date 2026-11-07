import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from './enums/EMode.Enum'
import { benchKeyOf, fallbackChain, groupOf, IModelGroup, modelGroupIssues, nextStep, retireSteps, switchesOn, withGroupTargets } from './Fallback.Policy'
import { IAgent } from './models/Agent.Model'

const agent: IAgent = {
  id: 'theo',
  name: 'Theo',
  providers: [{ provider: 'claude-sub', models: ['claude-opus-5-5'], sandbox: 'workspace-write', network: true }],
  systemPrompt: 'p',
  modes: [EMode.AGENT],
  allowedTools: [],
}
const padrao: IModelGroup = {
  id: 'padrao',
  name: 'Padrão',
  steps: [
    { provider: 'claude-sub', model: 'claude-opus-5-5' },
    { provider: 'claude-sub', model: 'claude-sonnet-5-5' },
    { provider: 'codex', model: 'gpt-6.1-sol' },
    { provider: 'codex', model: 'gpt-6.1-sol' },
  ],
}

describe('Fallback.Policy — grupos de modelos', () => {
  it('o grupo do agente: o dele, senão o padrão; `none` e id que sumiu = nenhum', () => {
    const settings = { modelGroups: [padrao, { ...padrao, id: 'outro' }], defaultModelGroup: 'padrao' }
    assert.strictEqual(groupOf(agent, settings)?.id, 'padrao')
    assert.strictEqual(groupOf({ modelGroup: 'outro' }, settings)?.id, 'outro')
    assert.strictEqual(groupOf({ modelGroup: 'none' }, settings), undefined)
    assert.strictEqual(groupOf({ modelGroup: 'sumiu' }, settings), undefined)
    assert.strictEqual(groupOf(agent, { modelGroups: [padrao] }), undefined)
  })

  it('a cadeia sem repetir; troca só no que o grupo escolhe (padrão: cota, limite, modelo)', () => {
    assert.strictEqual(fallbackChain(padrao).length, 3)
    assert.ok(switchesOn(padrao, 'quota') && switchesOn(padrao, 'model') && !switchesOn(padrao, 'auth') && !switchesOn(padrao, 'other'))
    assert.ok(switchesOn({ ...padrao, switchOn: ['auth'] }, 'auth'))
    assert.ok(!switchesOn(undefined, 'quota'))
  })

  it('⚖️ cota tira o provedor inteiro; erro do modelo, só o modelo', () => {
    const step = { provider: 'claude-sub', model: 'claude-opus-5-5' }
    assert.strictEqual(benchKeyOf(step, 'quota'), 'claude-sub')
    assert.strictEqual(benchKeyOf(step, 'model'), 'claude-sub/claude-opus-5-5')
    const chain = fallbackChain(padrao)
    assert.deepStrictEqual(
      nextStep(chain, new Set(['claude-sub/claude-opus-5-5']), () => true),
      chain[1],
    )
    assert.deepStrictEqual(
      nextStep(chain, new Set(['claude-sub/claude-opus-5-5', 'claude-sub']), () => true),
      chain[2],
    )
  })

  it('⚖️ os passos entram como alvos: o provedor que o agente tem ganha o modelo; o novo herda o sandbox e a rede do padrão', () => {
    const merged = withGroupTargets(agent, padrao)
    assert.deepStrictEqual(merged.providers, [
      { provider: 'claude-sub', models: ['claude-opus-5-5', 'claude-sonnet-5-5'], sandbox: 'workspace-write', network: true },
      { provider: 'codex', models: ['gpt-6.1-sol'], sandbox: 'workspace-write', network: true },
    ])
    assert.deepStrictEqual(agent.providers[0].models, ['claude-opus-5-5'], 'o agente original não muda')
    assert.strictEqual(withGroupTargets(agent, undefined), agent)
  })

  it('os problemas: id, nome, passos, provedor desconhecido, repetido, falha que não existe', () => {
    const issues = modelGroupIssues(
      [
        { id: 'A', name: '', steps: [] },
        { ...padrao, steps: [{ provider: 'nao-existe', model: 'x' }], switchOn: ['other'] },
        { ...padrao, id: 'padrao' },
        { ...padrao, id: 'none' },
      ],
      (provider) => provider !== 'nao-existe',
    )
    assert.deepStrictEqual(
      issues.map((issue) => issue.field),
      ['modelGroups[0].id', 'modelGroups[0].name', 'modelGroups[1].steps[0].provider', 'modelGroups[1].switchOn', 'modelGroups[2].id', 'modelGroups[3].id'],
    )
  })

  it('⚖️ retireSteps tira o passo que não serve de todos os grupos; o vazio fica; nada a tirar devolve o mesmo array', () => {
    const groups: IModelGroup[] = [
      {
        ...padrao,
        id: 'a',
        steps: [
          { provider: 'p', model: 'm1' },
          { provider: 'p', model: 'm2' },
        ],
      },
      { ...padrao, id: 'b', steps: [{ provider: 'p', model: 'm1' }] },
    ]
    const out = retireSteps(groups, (step) => step.model !== 'm1')
    assert.deepStrictEqual(
      out.groups.map((group) => group.steps.length),
      [1, 0],
    )
    assert.deepStrictEqual(
      out.removed.map((item) => item.group),
      ['a', 'b'],
    )
    assert.strictEqual(retireSteps(groups, () => true).groups, groups)
  })
})
