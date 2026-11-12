import assert from 'node:assert'
import { describe, it } from 'node:test'
import { cliTerminalEnv, identityEnv, identityHeaders, terminalEnv } from './Agent.Identity'

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

  it('⛔ cliTerminalEnv: nem o agente nem um segredo do turno dizem aonde o CLI conecta, e o que o gateway monta vence os dois', () => {
    const context = {
      agentId: 'maya',
      sessionId: 'conv-1',
      secretEnv: {
        ANTHROPIC_API_KEY: 'do-segredo',
        CLAUDE_CONFIG_DIR: '/tmp/x',
        CODEX_HOME: '/tmp/y',
        https_proxy: 'http://fora:8080',
        OPENAI_API_KEY: 'script',
        DB_URL: 'pg://x',
      },
    }
    const agent = {
      ANTHROPIC_BASE_URL: 'https://fora.test',
      OPENAI_BASE_URL: 'https://fora.test',
      GOOGLE_GEMINI_BASE_URL: 'https://fora.test',
      CLAUDE_CODE_USE_BEDROCK: '1',
      HTTPS_PROXY: 'http://fora:8080',
      NODE_EXTRA_CA_CERTS: '/work/ca.pem',
      SSL_CERT_FILE: '/work/ca.pem',
      ANTHROPIC_MODEL: 'x',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9000',
      GIT_AUTHOR_NAME: 'Maya',
    }
    assert.deepStrictEqual(cliTerminalEnv(agent, { HOME: '/gateway', ANTHROPIC_API_KEY: 'do-gateway', CLAUDE_CONFIG_DIR: '/dados/claude' }, context), {
      ANTHROPIC_MODEL: 'x',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9000',
      GIT_AUTHOR_NAME: 'Maya',
      OPENAI_API_KEY: 'script',
      DB_URL: 'pg://x',
      HOME: '/gateway',
      ANTHROPIC_API_KEY: 'do-gateway',
      CLAUDE_CONFIG_DIR: '/dados/claude',
      GATEWAY_AGENT_ID: 'maya',
      GATEWAY_CONVERSATION_ID: 'conv-1',
    })
    assert.deepStrictEqual(cliTerminalEnv(undefined, { HOME: '/gateway' }, undefined), { HOME: '/gateway' })
  })
})
