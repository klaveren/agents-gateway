import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { McpServerClient } from '@infra/mcp/McpServer.Client'
import { ToolCatalog } from './Tool.Catalog'
import { ILocalTool, IToolDefinition, IToolResult } from './Tool.Types'

function localTool(name: string, result: string): ILocalTool {
  return {
    origin: 'local',
    name,
    description: `local ${name}`,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(): Promise<IToolResult> {
      return { status: 'success', result }
    },
  }
}

function mcpTool(name: string): IToolDefinition {
  return {
    origin: 'mcp',
    name,
    description: `remote ${name}`,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  }
}

function fakeMcp(options: { connected: boolean; tools?: IToolDefinition[]; onCall?: (name: string) => void }): McpServerClient {
  return {
    serverUrl: 'http://localhost:8000/mcp',
    isConnected: () => options.connected,
    listTools: async () => (options.connected ? (options.tools ?? []) : []),
    callTool: async (name: string) => {
      options.onCall?.(name)
      return { status: 'success' as const, result: `mcp:${name}` }
    },
  } as unknown as McpServerClient
}

describe('ToolCatalog', () => {
  const local = [localTool('search_web', 'searched'), localTool('run_bash', 'ran')]

  it('filters the local toolset by what the agent declared', () => {
    const catalog = new ToolCatalog(fakeMcp({ connected: false }), local)

    assert.deepStrictEqual(
      catalog.localFor(['run_bash']).map((tool) => tool.name),
      ['run_bash'],
    )
  })

  it('merges MCP tools with the local ones', async () => {
    const catalog = new ToolCatalog(fakeMcp({ connected: true, tools: [mcpTool('read_file')] }), local)
    const listed = await catalog.list(['search_web', 'run_bash'])

    assert.deepStrictEqual(
      listed.map((tool) => `${tool.origin}:${tool.name}`),
      ['local:search_web', 'local:run_bash', 'mcp:read_file'],
    )
  })

  it('keeps the gateway useful when the MCP server is down', async () => {
    const catalog = new ToolCatalog(fakeMcp({ connected: false, tools: [mcpTool('read_file')] }), local)
    const listed = await catalog.list(['search_web', 'run_bash'])

    assert.strictEqual(catalog.mcpConnected, false)
    assert.deepStrictEqual(
      listed.map((tool) => tool.name),
      ['search_web', 'run_bash'],
    )
  })

  it('lets a local tool shadow a remote one with the same name', async () => {
    const catalog = new ToolCatalog(fakeMcp({ connected: true, tools: [mcpTool('run_bash')] }), local)
    const listed = await catalog.list(['run_bash'])

    assert.strictEqual(listed.length, 1)
    assert.strictEqual(listed[0].origin, 'local')
  })

  it('runs local tools in process and forwards the rest to MCP', async () => {
    const calls: string[] = []
    const catalog = new ToolCatalog(fakeMcp({ connected: true, onCall: (name) => calls.push(name) }), local)

    assert.deepStrictEqual(await catalog.invoke('run_bash', {}), { status: 'success', result: 'ran' })
    assert.strictEqual(calls.length, 0)

    assert.deepStrictEqual(await catalog.invoke('read_file', {}), { status: 'success', result: 'mcp:read_file' })
    assert.deepStrictEqual(calls, ['read_file'])
  })
})
