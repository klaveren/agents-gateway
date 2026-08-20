export interface IMcpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface IMcpToolResult {
  status: 'success' | 'error'
  result: string
}

const MAX_OUTPUT_CHARS = 4000

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Stub: fala com um catálogo fixo e executa as tools localmente.
 *
 * A fase 2 troca isto por um cliente MCP de verdade, mantendo as tools locais como
 * fallback para o gateway continuar útil sem nenhum MCP server no ar.
 */
export class McpServerClient {
  constructor(private serverUrl: string) {}

  async connect(): Promise<void> {
    console.log(`Connecting to MCP Server at ${this.serverUrl}`)
  }

  async getTools(): Promise<IMcpTool[]> {
    return [
      {
        name: 'search_web',
        description: 'Searches the internet for up-to-date information.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The search query' } },
          required: ['query'],
        },
      },
      {
        name: 'run_bash',
        description: 'Executes a bash command on the host system.',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string', description: 'The bash command to run' } },
          required: ['command'],
        },
      },
    ]
  }

  async invokeTool(toolName: string, params: Record<string, unknown>): Promise<IMcpToolResult> {
    console.log(`Invoking tool ${toolName} with params:`, params)

    if (toolName === 'search_web') return this.searchWeb(String(params.query ?? ''))
    if (toolName === 'run_bash') return this.runBash(String(params.command ?? ''))

    return { status: 'error', result: `Tool ${toolName} not found.` }
  }

  private async searchWeb(query: string): Promise<IMcpToolResult> {
    try {
      const axios = require('axios')
      const cheerio = require('cheerio')

      const response = await axios.get('https://html.duckduckgo.com/html/', {
        params: { q: query },
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      })

      const $ = cheerio.load(response.data)
      const results: string[] = []

      $('.result__body').each((index: number, element: unknown) => {
        if (index >= 5) return
        const title = $(element).find('.result__title').text().trim()
        const snippet = $(element).find('.result__snippet').text().trim()
        if (title && snippet) results.push(`Title: ${title}\nSnippet: ${snippet}`)
      })

      return { status: 'success', result: results.join('\n\n') || 'No results found.' }
    } catch (err: unknown) {
      return { status: 'error', result: `Search failed: ${toMessage(err)}` }
    }
  }

  private async runBash(command: string): Promise<IMcpToolResult> {
    try {
      const { exec } = require('child_process')
      const { promisify } = require('util')
      const execPromise = promisify(exec)

      const { stdout, stderr } = await execPromise(command)
      let output: string = stdout || stderr || 'Command executed successfully with no output.'

      if (output.length > MAX_OUTPUT_CHARS) {
        output = `${output.substring(0, MAX_OUTPUT_CHARS)}\n...[Truncated]`
      }

      return { status: 'success', result: output }
    } catch (err: unknown) {
      return { status: 'error', result: `Execution failed: ${toMessage(err)}` }
    }
  }
}
