import assert from 'node:assert'
import { describe, it } from 'node:test'
import { targetUnavailable } from './Agent.Availability'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { IAgent } from './models/Agent.Model'
import { IProviderConfig } from './models/Provider.Model'

describe('targetUnavailable', () => {
  const agent: IAgent = { id: 'a', name: 'A', systemPrompt: 'p', providers: [{ provider: 'openai', models: ['gpt-x'] }], modes: [EMode.CHAT], allowedTools: [] }
  const provider = { id: 'openai', name: 'OpenAI', protocol: EProvider.OPENAI, enabled: true } as IProviderConfig
  const sub = { id: 'claude-sub', name: 'Claude', protocol: EProvider.CLAUDE_SUB, enabled: true } as IProviderConfig

  it('ativo: provider ligado, modelo utilizável e chave', () => {
    assert.strictEqual(targetUnavailable(agent, agent.providers[0], { provider, hasKey: true, admin: false }), undefined)
  })

  it('cada motivo, na ordem em que a pessoa resolve', () => {
    assert.strictEqual(targetUnavailable(agent, agent.providers[0], { provider: undefined, hasKey: true, admin: true }), 'provider_disabled')
    assert.strictEqual(targetUnavailable(agent, agent.providers[0], { provider: { ...provider, enabled: false }, hasKey: true, admin: true }), 'provider_disabled')
    const empty = { ...agent, providers: [{ provider: 'openai', models: [] }] }
    assert.strictEqual(targetUnavailable(empty, empty.providers[0], { provider, hasKey: true, admin: true }), 'no_model')
    assert.strictEqual(targetUnavailable(agent, agent.providers[0], { provider, hasKey: false, admin: true }), 'no_key')
  })

  it('assinatura não precisa de chave, mas é só de admin (por padrão)', () => {
    const subAgent = { ...agent, providers: [{ provider: 'claude-sub', models: ['gpt-x'] }] }
    assert.strictEqual(targetUnavailable(subAgent, subAgent.providers[0], { provider: sub, hasKey: false, admin: true }), undefined)
    assert.strictEqual(targetUnavailable(subAgent, subAgent.providers[0], { provider: sub, hasKey: false, admin: false }), 'admin_only')
  })

  it('⛔ ferramenta que alcança o servidor: só admin', () => {
    const bash = { ...agent, allowedTools: ['run_bash'] }
    assert.strictEqual(targetUnavailable(bash, bash.providers[0], { provider, hasKey: true, admin: false }), 'admin_only')
    assert.strictEqual(targetUnavailable(bash, bash.providers[0], { provider, hasKey: true, admin: true }), undefined)
  })
})
