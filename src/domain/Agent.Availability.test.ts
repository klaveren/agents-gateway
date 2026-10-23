import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentUnavailable } from './Agent.Availability'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { IAgent } from './models/Agent.Model'
import { IProviderConfig } from './models/Provider.Model'

describe('agentUnavailable', () => {
  const agent: IAgent = { id: 'a', name: 'A', provider: 'openai', systemPrompt: 'p', models: ['gpt-x'], modes: [EMode.CHAT], allowedTools: [] }
  const provider = { id: 'openai', name: 'OpenAI', protocol: EProvider.OPENAI, enabled: true } as IProviderConfig
  const sub = { id: 'claude-sub', name: 'Claude', protocol: EProvider.CLAUDE_SUB, enabled: true } as IProviderConfig

  it('ativo: provider ligado, modelo utilizável e chave', () => {
    assert.strictEqual(agentUnavailable(agent, { provider, hasKey: true, admin: false }), undefined)
  })

  it('cada motivo, na ordem em que a pessoa resolve', () => {
    assert.strictEqual(agentUnavailable(agent, { provider: undefined, hasKey: true, admin: true }), 'provider_disabled')
    assert.strictEqual(agentUnavailable(agent, { provider: { ...provider, enabled: false }, hasKey: true, admin: true }), 'provider_disabled')
    assert.strictEqual(agentUnavailable({ ...agent, models: [] }, { provider, hasKey: true, admin: true }), 'no_model')
    assert.strictEqual(agentUnavailable(agent, { provider, hasKey: false, admin: true }), 'no_key')
  })

  it('assinatura não precisa de chave, mas é só de admin (por padrão)', () => {
    const subAgent = { ...agent, provider: 'claude-sub' }
    assert.strictEqual(agentUnavailable(subAgent, { provider: sub, hasKey: false, admin: true }), undefined)
    assert.strictEqual(agentUnavailable(subAgent, { provider: sub, hasKey: false, admin: false }), 'admin_only')
  })

  it('⛔ ferramenta que alcança o servidor: só admin', () => {
    const bash = { ...agent, allowedTools: ['run_bash'] }
    assert.strictEqual(agentUnavailable(bash, { provider, hasKey: true, admin: false }), 'admin_only')
    assert.strictEqual(agentUnavailable(bash, { provider, hasKey: true, admin: true }), undefined)
  })
})
