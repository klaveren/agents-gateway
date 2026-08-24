import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { bashPolicy, denyReason, truncate, type IBashPolicy } from './Bash.Guard'
import { ILocalTool, IToolResult } from './Tool.Types'

export interface IExecOptions {
  cwd: string
  timeout: number
  maxBuffer: number
}

export type TExec = (command: string, options: IExecOptions) => Promise<{ stdout: string; stderr: string }>
export type TFetchHtml = (query: string) => Promise<string>

export interface ILocalToolDeps {
  exec?: TExec
  fetchHtml?: TFetchHtml
  policy?: IBashPolicy
}

const EXEC_BUFFER_BYTES = 1024 * 1024

const defaultExec: TExec = promisify(exec) as unknown as TExec

const defaultFetchHtml: TFetchHtml = async (query) => {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  })
  if (!response.ok) throw new Error(`DuckDuckGo answered ${response.status}`)
  return response.text()
}

/**
 * O toolset embutido do gateway.
 *
 * Existe para que o gateway continue útil sem nenhum MCP server no ar — foi a falta
 * disso que motivou o revert da primeira tentativa de MCP real. Cada Agents SDK
 * registra estas mesmas implementações no seu próprio formato.
 */
export function makeLocalTools(deps: ILocalToolDeps = {}): ILocalTool[] {
  const run = deps.exec ?? defaultExec
  const fetchHtml = deps.fetchHtml ?? defaultFetchHtml
  const policy = deps.policy ?? bashPolicy()

  return [
    {
      origin: 'local',
      name: 'search_web',
      description: 'Searches the internet for up-to-date information.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query' } },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args): Promise<IToolResult> {
        const query = String(args.query ?? '').trim()
        if (!query) return { status: 'error', result: 'search_web requires a non-empty query.' }

        try {
          return { status: 'success', result: parseResults(await fetchHtml(query)) }
        } catch (error: unknown) {
          return { status: 'error', result: `Search failed: ${toMessage(error)}` }
        }
      },
    },
    {
      origin: 'local',
      name: 'run_bash',
      description: 'Executes a bash command on the host system.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The bash command to run' } },
        required: ['command'],
        additionalProperties: false,
      },
      async execute(args): Promise<IToolResult> {
        const command = String(args.command ?? '')

        const denied = denyReason(command)
        if (denied) {
          return { status: 'error', result: `Refused by the gateway tool policy: ${denied}.` }
        }

        try {
          const { stdout, stderr } = await run(command, {
            cwd: policy.cwd,
            timeout: policy.timeoutMs,
            maxBuffer: EXEC_BUFFER_BYTES,
          })
          const output = stdout || stderr || 'Command executed successfully with no output.'
          return { status: 'success', result: truncate(output, policy.maxOutputChars) }
        } catch (error: unknown) {
          return { status: 'error', result: `Execution failed: ${toMessage(error)}` }
        }
      },
    },
  ]
}

/** O HTML do DuckDuckGo é estável o bastante para os cinco primeiros resultados. */
function parseResults(html: string): string {
  const results: string[] = []
  const blocks = html.split('result__body').slice(1, 6)

  for (const block of blocks) {
    const title = stripTags(match(block, /class="result__a"[^>]*>([\s\S]*?)<\/a>/))
    const snippet = stripTags(match(block, /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/))
    if (title && snippet) results.push(`Title: ${title}\nSnippet: ${snippet}`)
  }

  return results.join('\n\n') || 'No results found.'
}

function match(source: string, pattern: RegExp): string {
  return pattern.exec(source)?.[1] ?? ''
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
