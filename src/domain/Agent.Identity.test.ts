import assert from 'node:assert'
import { describe, it } from 'node:test'
import { identityEnv, identityHeaders, terminalEnv } from './Agent.Identity'

describe('Agent.Identity', () => {
  it('as variáveis e os cabeçalhos de quem chama; o projeto é o da conversa, ou o do agente', () => {
    const context = { agentId: 'maya', sessionId: 'conv-1', projectId: 'logiccus' }
    assert.deepStrictEqual(identityEnv(context), { GATEWAY_AGENT_ID: 'maya', GATEWAY_CONVERSATION_ID: 'conv-1', GATEWAY_PROJECT_ID: 'logiccus' })
    assert.deepStrictEqual(identityHeaders({ ...context, conversationProjectId: 'outro' }), {
      'x-gateway-agent': 'maya',
      'x-gateway-conversation': 'conv-1',
      'x-gateway-project': 'outro',
    })
    assert.deepStrictEqual(identityEnv(undefined), {})
  })

  it('⛔ terminalEnv: as variáveis do agente por baixo, o gateway por cima e a identidade por último', () => {
    const context = { agentId: 'maya', sessionId: 'conv-1' }
    const env = terminalEnv({ GIT_AUTHOR_NAME: 'Maya', HOME: '/agente', GATEWAY_AGENT_ID: 'impostora' }, { HOME: '/gateway', PATH: '/usr/bin' }, context)
    assert.deepStrictEqual(env, { GIT_AUTHOR_NAME: 'Maya', HOME: '/gateway', PATH: '/usr/bin', GATEWAY_AGENT_ID: 'maya', GATEWAY_CONVERSATION_ID: 'conv-1' })
    assert.deepStrictEqual(terminalEnv(undefined, { HOME: '/gateway' }, undefined), { HOME: '/gateway' })
  })
})
