import assert from 'node:assert'
import { describe, it } from 'node:test'
import { MCP_CONNECT_TIMEOUT_DEFAULT_MS, mcpConnectTimeoutMs, mcpPendingNote, mcpWaitEnv, unavailableMcpServers } from './McpConnection.Policy'

describe('McpConnection.Policy', () => {
  it('⚖️ o CLI espera os MCPs, com o teto em ms nas duas variáveis', () => {
    assert.deepStrictEqual(mcpWaitEnv(15000), { MCP_CONNECTION_NONBLOCKING: '0', MCP_CONNECT_TIMEOUT_MS: '15000', MCP_TIMEOUT: '15000' })
  })

  it('o teto vem do gateway quando é um número positivo; senão, o padrão', () => {
    assert.strictEqual(mcpConnectTimeoutMs({ CLAUDE_MCP_CONNECT_TIMEOUT_MS: '8000' }), 8000)
    assert.strictEqual(mcpConnectTimeoutMs({ CLAUDE_MCP_CONNECT_TIMEOUT_MS: 'x' }), MCP_CONNECT_TIMEOUT_DEFAULT_MS)
    assert.strictEqual(mcpConnectTimeoutMs({ CLAUDE_MCP_CONNECT_TIMEOUT_MS: '-1' }), MCP_CONNECT_TIMEOUT_DEFAULT_MS)
    assert.strictEqual(mcpConnectTimeoutMs({}), MCP_CONNECT_TIMEOUT_DEFAULT_MS)
  })

  it('só os servidores do agente que não ligaram: pendente, falho ou ausente do init', () => {
    const expected = new Map([
      ['mcp_agents_mcp', 'agents-mcp'],
      ['mcp_crm', 'CRM'],
      ['mcp_docs', 'Docs'],
    ])
    const reported = [
      { name: 'local', status: 'pending' },
      { name: 'mcp_agents_mcp', status: 'pending' },
      { name: 'mcp_crm', status: 'connected' },
    ]
    assert.deepStrictEqual(unavailableMcpServers(reported, expected), ['agents-mcp', 'Docs'])
    assert.deepStrictEqual(unavailableMcpServers([{ name: 'mcp_crm', status: 'connected' }], new Map([['mcp_crm', 'CRM']])), [])
  })

  it('o aviso diz que o servidor existe e só não chegou a tempo', () => {
    assert.match(mcpPendingNote(['agents-mcp']), /o servidor agents-mcp ainda está conectando; as ferramentas dele não estão disponíveis neste turno — não conclua que não existem/)
    assert.match(mcpPendingNote(['a', 'b']), /os servidores a, b ainda estão conectando/)
  })
})
