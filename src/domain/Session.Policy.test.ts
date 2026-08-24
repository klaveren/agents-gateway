import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { ModeNotSupportedError, ToolsNotSupportedError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { resolveSessionMode } from './Session.Policy'

const agentWith = (modes: EMode[]): IAgent => ({
  id: 'sysops-agent',
  name: 'SysOps',
  provider: EProvider.CLAUDE,
  systemPrompt: 'prompt',
  models: ['claude-sonnet-5'],
  modes,
  allowedTools: ['run_bash'],
})

describe('resolveSessionMode', () => {
  const both = agentWith([EMode.CHAT, EMode.AGENT])

  it('abre em chat quando a lane não é dita', () => {
    assert.strictEqual(resolveSessionMode(both, { agentId: 'sysops-agent' }), EMode.CHAT)
  })

  it('respeita a lane pedida', () => {
    assert.strictEqual(resolveSessionMode(both, { agentId: 'sysops-agent', mode: EMode.AGENT }), EMode.AGENT)
  })

  it('recusa lane que o agente não declara', () => {
    const chatOnly = agentWith([EMode.CHAT])

    assert.throws(() => resolveSessionMode(chatOnly, { agentId: 'sysops-agent', mode: EMode.AGENT }), ModeNotSupportedError)
    assert.throws(() => resolveSessionMode(both, { agentId: 'sysops-agent', mode: 'telepathy' as EMode }), ModeNotSupportedError)
  })

  it('recusa o loop manual fora da lane chat', () => {
    assert.throws(() => resolveSessionMode(both, { agentId: 'sysops-agent', mode: EMode.AGENT, tools: true }), ToolsNotSupportedError)
  })

  it('aceita o loop manual na lane chat, inclusive por omissão da lane', () => {
    assert.strictEqual(resolveSessionMode(both, { agentId: 'sysops-agent', tools: true }), EMode.CHAT)
    assert.strictEqual(resolveSessionMode(both, { agentId: 'sysops-agent', mode: EMode.CHAT, tools: true }), EMode.CHAT)
  })

  it('tools falso não bloqueia a lane agent', () => {
    assert.strictEqual(resolveSessionMode(both, { agentId: 'sysops-agent', mode: EMode.AGENT, tools: false }), EMode.AGENT)
  })
})
