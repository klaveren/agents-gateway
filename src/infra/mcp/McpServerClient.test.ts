import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { McpServerClient } from './McpServerClient'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

describe('McpServerClient', () => {
  it('should connect and get tools correctly via SDK', async () => {
    const client = new McpServerClient('http://test/sse')

    mock.method(Client.prototype, 'connect', async () => {})
    mock.method(Client.prototype, 'listTools', async () => {
      return {
        tools: [
          { name: 'test_tool', description: 'A test tool', inputSchema: {} },
        ],
      }
    })

    await client.connect()
    const tools = await client.getTools()

    assert.strictEqual(tools.length, 1)
    assert.strictEqual(tools[0].name, 'test_tool')
  })

  it('should invoke a tool and return success via SDK', async () => {
    const client = new McpServerClient('http://test/sse')

    mock.method(Client.prototype, 'callTool', async () => {
      return {
        content: [{ type: 'text', text: 'Tool output' }],
        isError: false,
      }
    })

    const result = await client.invokeTool('test_tool', { arg: 'val' })
    assert.strictEqual(result.status, 'success')
    assert.strictEqual(result.result, 'Tool output')
  })

  it('should handle tool execution error via SDK', async () => {
    const client = new McpServerClient('http://test/sse')

    mock.method(Client.prototype, 'callTool', async () => {
      return {
        content: [{ type: 'text', text: 'Tool failed' }],
        isError: true,
      }
    })

    const result = await client.invokeTool('test_tool', { arg: 'val' })
    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.result, 'Tool failed')
  })

  it('should handle exceptions thrown by SDK', async () => {
    const client = new McpServerClient('http://test/sse')

    mock.method(Client.prototype, 'callTool', async () => {
      throw new Error('Network error')
    })

    const result = await client.invokeTool('test_tool', { arg: 'val' })
    assert.strictEqual(result.status, 'error')
    assert.ok(result.result.includes('Execution failed: Network error'))
  })
})
