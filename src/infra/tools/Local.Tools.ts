import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { bashPolicy, denyReason, truncate, type IBashPolicy } from './Bash.Guard'
import { subscriptionEnv, workspaceFor } from '@infra/adapters/support/Subscription.Workspace'
import { IProjectSandbox, projectSandbox, SANDBOX_SHELL } from '@infra/sandbox/Project.Sandbox'
import { IProjectDoc, READ_DOC_TOOL } from '@domain/models/ProjectDoc.Model'
import { USE_SKILL_TOOL } from '@domain/models/Resource.Model'
import { ILocalTool, IToolResult } from './Tool.Types'

export interface IExecOptions {
  cwd: string
  timeout: number
  maxBuffer: number
  env: Record<string, string>
  /** O shell da linha; o comando cercado (`Project.Sandbox`) é montado para o bash. */
  shell?: string
}

export type TExec = (command: string, options: IExecOptions) => Promise<{ stdout: string; stderr: string }>
export type TFetchHtml = (query: string) => Promise<string>

/** Quem lê um documento para a conversa (o `GuidanceService`). */
export interface IDocReader {
  readDoc(id: string, projectId?: string): IProjectDoc | undefined
}

/** Quem carrega uma skill para o agente (o `GuidanceService`). */
export interface ISkillLoader {
  loadSkill(id: string, agentId?: string): string | undefined
}

export interface ILocalToolDeps {
  exec?: TExec
  fetchHtml?: TFetchHtml
  policy?: IBashPolicy
  /** O cerco do agente de projeto (ver `Project.Sandbox`). Ausente = o do processo. */
  sandbox?: IProjectSandbox
  /** As skills liberadas ao agente. Ausente = sem `use_skill`. */
  skills?: ISkillLoader
  /** Os documentos (specs e ADRs). Ausente = sem `read_doc`. */
  docs?: IDocReader
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
  const sandbox = deps.sandbox ?? projectSandbox()

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
      async execute(args, context): Promise<IToolResult> {
        const command = String(args.command ?? '')

        const denied = denyReason(command)
        if (denied) {
          return { status: 'error', result: `Refused by the gateway tool policy: ${denied}.` }
        }

        // ⛔ Agente de projeto: o comando roda PRESO à pasta do projeto, ou não roda (sem cerco, recusa).
        let line = command
        if (context?.projectId) {
          try {
            line = await sandbox.wrap(command, context.projectId)
          } catch (error: unknown) {
            return { status: 'error', result: `${toMessage(error)}. O run_bash de agente de projeto fica bloqueado até o cerco funcionar.` }
          }
        }

        try {
          // ⛔ Ambiente MÍNIMO: o shell herdava o `process.env` inteiro — chaves de API, `AUTH_SECRET`,
          // `SECRETS_KEY` —, e um `env` bastava para levar tudo. E o `cwd` é o diretório vazio da conversa —
          // ou, no agente de projeto, a pasta do projeto (que vence o `BASH_CWD`: é nela que o cerco deixa gravar).
          const cwd = context?.projectId ? workspaceFor(context.projectId, '') : policy.cwd || workspaceFor(undefined, context?.sessionId ?? 'run_bash')
          const { stdout, stderr } = await run(line, {
            cwd,
            timeout: policy.timeoutMs,
            maxBuffer: EXEC_BUFFER_BYTES,
            env: subscriptionEnv({ HOME: cwd }),
            ...(context?.projectId ? { shell: SANDBOX_SHELL } : {}),
          })
          const output = stdout || stderr || 'Command executed successfully with no output.'
          return { status: 'success', result: truncate(output, policy.maxOutputChars) }
        } catch (error: unknown) {
          // Comando cercado: a linha embrulhada (a política do cerco) não interessa a quem lê; a saída de erro, sim.
          const failure = error as { stderr?: string; code?: number }
          if (context?.projectId && failure.stderr) return { status: 'error', result: truncate(`Exit code ${failure.code ?? 1}: ${failure.stderr.trim()}`, policy.maxOutputChars) }
          return { status: 'error', result: `Execution failed: ${toMessage(error)}` }
        }
      },
    },
    ...(deps.docs ? [readDocTool(deps.docs)] : []),
    ...(deps.skills ? [useSkillTool(deps.skills)] : []),
  ]
}

/**
 * `use_skill`: a skill inteira (e os documentos anexados a ela), das que o índice "## Skills" do prompt lista.
 * ⛔ Só uma skill liberada a ESTE agente (o `agentId` do contexto); outra responde como inexistente.
 */
function useSkillTool(skills: ISkillLoader): ILocalTool {
  return {
    origin: 'local',
    name: USE_SKILL_TOOL,
    description:
      'Loads the full instructions of a skill listed under "Skills" in your instructions, by its id, with the documents attached to it. Load it before doing what the skill covers.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The skill id, as listed' } },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const skill = id ? skills.loadSkill(id, context?.agentId) : undefined
      if (!skill) return { status: 'error', result: `Skill not found: ${id || '(no id)'}` }
      return { status: 'success', result: skill }
    },
  }
}

/**
 * `read_doc`: o documento inteiro (markdown) de uma spec ou ADR do índice que a conversa recebeu no prompt.
 * ⛔ Só o global ou o do projeto da conversa; o de outro projeto responde como inexistente.
 */
function readDocTool(docs: IDocReader): ILocalTool {
  return {
    origin: 'local',
    name: READ_DOC_TOOL,
    description: 'Reads the full markdown of a spec or ADR listed under "Documentos de referência" in your instructions, by its id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The document id, as listed' } },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const doc = id ? docs.readDoc(id, context?.conversationProjectId) : undefined
      if (!doc) return { status: 'error', result: `Document not found: ${id || '(no id)'}` }
      return { status: 'success', result: `# ${doc.title} [${doc.kind}]\n\n${doc.body}` }
    },
  }
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
