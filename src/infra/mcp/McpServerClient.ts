import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import EventSource from 'eventsource'

// Polyfill EventSource for Node.js
;(global as any).EventSource = EventSource

export interface IMcpTool {
  name: string
  description?: string
  inputSchema: any
}

export class McpServerClient {
  private client: Client

  constructor(private serverUrl: string) {
    this.client = new Client(
      {
        name: 'agents-gateway',
        version: '1.0.0-alpha',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    )
  }

  async connect() {
    console.log(`Connecting to MCP Server at ${this.serverUrl}`)
    const transport = new SSEClientTransport(new URL(this.serverUrl))
    await this.client.connect(transport)
  }

  async getTools(): Promise<IMcpTool[]> {
    const response = await this.client.listTools()
    return response.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  }

  async invokeTool(toolName: string, params: any) {
    console.log(`Invoking tool ${toolName} with params:`, params)

    try {
      const response = await this.client.callTool({
        name: toolName,
        arguments: params,
      })

      const textContent = response.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')

      if (response.isError) {
        return { status: 'error', result: textContent || 'Unknown error' }
      }

      return { status: 'success', result: textContent }
    } catch (err: any) {
      return { status: 'error', result: `Execution failed: ${err.message}` }
    }
  }
}
