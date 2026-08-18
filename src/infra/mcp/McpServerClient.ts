export interface IMcpTool {
  name: string
  description: string
  inputSchema: any
}

export class McpServerClient {
  constructor(private serverUrl: string) {}

  async connect() {
    console.log(`Connecting to MCP Server at ${this.serverUrl}`)
    // Stub: Inicializa a conexão MCP.
  }

  async getTools(): Promise<IMcpTool[]> {
    return [
      {
        name: 'search_web',
        description: 'Searches the internet for up-to-date information.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
          },
          required: ['query'],
        },
      },
      {
        name: 'run_bash',
        description: 'Executes a bash command on the host system.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to run' },
          },
          required: ['command'],
        },
      },
    ]
  }

  async invokeTool(toolName: string, params: any) {
    console.log(`Invoking tool ${toolName} with params:`, params)

    if (toolName === 'search_web') {
      try {
        const axios = require('axios')
        const cheerio = require('cheerio')

        const response = await axios.get('https://html.duckduckgo.com/html/', {
          params: { q: params.query },
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        })

        const $ = cheerio.load(response.data)
        const results: string[] = []

        $('.result__body').each((i: number, el: any) => {
          if (i >= 5) return
          const title = $(el).find('.result__title').text().trim()
          const snippet = $(el).find('.result__snippet').text().trim()
          if (title && snippet) {
            results.push(`Title: ${title}\nSnippet: ${snippet}`)
          }
        })

        const searchResult = results.join('\n\n') || 'No results found.'
        return { status: 'success', result: searchResult }
      } catch (err: any) {
        return { status: 'error', result: `Search failed: ${err.message}` }
      }
    }

    if (toolName === 'run_bash') {
      try {
        const { exec } = require('child_process')
        const util = require('util')
        const execPromise = util.promisify(exec)

        const { stdout, stderr } = await execPromise(params.command)
        let resultOutput = stdout || stderr
        if (!resultOutput) resultOutput = 'Command executed successfully with no output.'

        // Truncate if too long
        if (resultOutput.length > 4000) {
          resultOutput = resultOutput.substring(0, 4000) + '\n...[Truncated]'
        }

        return { status: 'success', result: resultOutput }
      } catch (err: any) {
        return { status: 'error', result: `Execution failed: ${err.message}` }
      }
    }

    return { status: 'error', result: `Tool ${toolName} not found.` }
  }
}
