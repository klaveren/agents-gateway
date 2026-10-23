import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IMcpServerConfig } from '@domain/models/McpServer.Model'
import { IAgentMcpServer } from '../Tool.Catalog'
import { buildClaudeMcpServers } from './Claude.ToolBridge'
import { buildOpenAIMcpServers } from './OpenAI.ToolBridge'

const config = (id: string, over: Partial<IMcpServerConfig> = {}): IMcpServerConfig => ({
  id,
  name: id,
  url: `https://${id}.exemplo.com/mcp`,
  transport: 'auto',
  auth: 'caller',
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
})

describe('pontes MCP com vários servidores', () => {
  const remotes: IAgentMcpServer[] = [
    { config: config('crm') },
    { config: config('docs-int', { auth: 'header', transport: 'sse' }), tools: ['read'], header: { name: 'X-Api-Key', value: 'segredo' } },
    { config: config('aberto', { auth: 'none' }) },
  ]

  it('Claude Agent SDK: um servidor por MCP, cada um com a SUA credencial', () => {
    const servers = buildClaudeMcpServers([], remotes, 'token-de-quem-conversa') as Record<string, { type: string; url: string; headers?: Record<string, string> }>

    assert.deepStrictEqual(Object.keys(servers), ['mcp_crm', 'mcp_docs_int', 'mcp_aberto'])
    assert.deepStrictEqual(servers.mcp_crm.headers, { authorization: 'Bearer token-de-quem-conversa' })
    assert.deepStrictEqual([servers.mcp_docs_int.type, servers.mcp_docs_int.headers], ['sse', { 'X-Api-Key': 'segredo' }])
    assert.strictEqual(servers.mcp_aberto.headers, undefined)
  })

  it('OpenAI Agents: um servidor por MCP, com o filtro das ferramentas escolhidas', () => {
    const servers = buildOpenAIMcpServers(remotes, 'tk') as unknown as Array<{ name: string; constructor: { name: string } }>

    assert.deepStrictEqual(
      servers.map((server) => [server.name, server.constructor.name]),
      [
        ['mcp_crm', 'MCPServerStreamableHttp'],
        ['mcp_docs-int', 'MCPServerSSE'],
        ['mcp_aberto', 'MCPServerStreamableHttp'],
      ],
    )
  })
})
