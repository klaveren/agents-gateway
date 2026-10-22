import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentIssues, IAgentRules } from './Agent.Policy'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { IAgent } from './models/Agent.Model'

describe('agentIssues', () => {
  const rules: IAgentRules = {
    takenIds: ['sysops-agent'],
    knownTools: ['search_web'],
    providerOf: (model) => (model.startsWith('gemini') ? EProvider.GOOGLE : model.startsWith('gpt') ? EProvider.OPENAI : undefined),
  }

  const agent = (over: Partial<IAgent> = {}): IAgent => ({
    id: 'pesquisa-juridica',
    name: 'Pesquisa jurídica',
    provider: EProvider.GOOGLE,
    systemPrompt: 'Você pesquisa jurisprudência.',
    models: ['gemini-3.7-flash'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['search_web'],
    ...over,
  })

  const fields = (issues: Array<{ field: string }>) => issues.map((issue) => issue.field)

  it('um agente certo não tem problema nenhum', () => {
    assert.deepStrictEqual(agentIssues(agent(), rules), [])
  })

  it('devolve TODOS os problemas de uma vez, campo a campo', () => {
    const issues = agentIssues(agent({ id: 'X', name: ' ', models: [], modes: [], systemPrompt: '' }), rules)

    assert.deepStrictEqual(fields(issues), ['id', 'name', 'models', 'modes', 'systemPrompt'])
  })

  it('recusa id que já existe', () => {
    assert.deepStrictEqual(fields(agentIssues(agent({ id: 'sysops-agent' }), rules)), ['id'])
  })

  it('⚠️ recusa modelo de outro provider, e modelo que ninguém reconhece', () => {
    const issues = agentIssues(agent({ models: ['gpt-5.6-sol', 'llama-9'] }), rules)

    assert.deepStrictEqual(
      issues.map((issue) => issue.message),
      ['gpt-5.6-sol is a openai model', 'unknown model: llama-9'],
    )
  })

  it('⛔ recusa tool fora do perímetro (ex.: run_bash com o sysops desabilitado)', () => {
    assert.deepStrictEqual(fields(agentIssues(agent({ allowedTools: ['search_web', 'run_bash'] }), rules)), ['allowedTools'])
  })

  it('o problema de prompt do provider vira problema do campo', () => {
    const issues = agentIssues(agent(), { ...rules, promptIssue: () => 'chaves viram variável' })

    assert.deepStrictEqual(issues, [{ field: 'systemPrompt', message: 'chaves viram variável' }])
  })
})
