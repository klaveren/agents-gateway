import { sessionChoice } from '@domain/Agent.Policy'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Codex, CodexOptions, ThreadEvent, ThreadItem, ThreadOptions, UserInput } from '@openai/codex-sdk'
import { nativeToolsOf } from '@domain/Native.Tools'
import { sandboxOf, TSandboxLevel } from '@domain/Sandbox.Policy'
import { reasoningLevel } from '@domain/Reasoning.Levels'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { sessionPrefix } from '@infra/session/Session.Key'
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'
import { mcpHeaders } from '@infra/tools/bridges/Claude.ToolBridge'
import { IAgentMcpServer, ToolCatalog } from '@infra/tools/Tool.Catalog'
import { untestedCodex } from './support/Codex.Binary'
import { esmImport } from './support/Esm.Import'
import { IConnectionSource, UnavailableProviderError } from './support/Keyed.Client'
import { composeSystemPrompt } from './support/Prompt.Helper'
import { sessionWorkspace, subscriptionEnv, subscriptionHome } from './support/Subscription.Workspace'

type TCodexClass = new (options?: CodexOptions) => Codex

/** O id da thread que o Codex devolve no primeiro turno — é por ele que os seguintes retomam. */
interface ICodexNative {
  threadId?: string
}

/** O que o turno já emitiu: o Codex manda a resposta em várias mensagens, e coladas elas viram "fim.Começo". */
interface ICodexTurn {
  texted: boolean
}

export interface ICodexAgentAdapterDeps {
  store?: SessionStore
  catalog?: ToolCatalog
  connections?: IConnectionSource
  /** Injetável para o teste não subir o binário. */
  load?: () => Promise<TCodexClass>
  /** O `CODEX_HOME` do gateway (ver `subscriptionHome`). */
  home?: () => string
  /** A conferência da versão do binário (ver `untestedCodex`). */
  versionIssue?: () => string | undefined
}

/**
 * ⛔ O QUE O CODEX NÃO TEM AQUI, a não ser que o agente ligue a nativa (`sdk:codex:shell` destrava
 * `shell_tool` e `unified_exec`; ver `codexFeatures`). Ligado por padrão no CLI e desligado à força: terminal (`shell_tool`,
 * `unified_exec`), conectores da conta ChatGPT (`apps`: Figma, Drive…), navegador, computer use,
 * plugins, skills, hooks, subagentes, geração de imagem. Verificado na 0.163: sem o `shell_tool` não há
 * comando; o `exec` do code mode sobra para chamar MCP, e nele `import 'node:fs'` falha
 * ("unsupported import in exec").
 *
 * ⚠️ O `code_mode_host` FICA LIGADO de propósito: é por ele que as ferramentas de MCP chegam ao modelo.
 */
/** As features do CLI para o agente: as travadas, menos as que as nativas dele destravam. */
export function codexFeatures(allowedTools: readonly string[]): Record<string, boolean> {
  const unlocked = nativeToolsOf(allowedTools, EProvider.CODEX).flatMap((tool) => tool.sdkNames ?? [tool.sdkName])
  return Object.fromEntries(Object.entries(CODEX_LOCKED_FEATURES).map(([name, value]) => [name, unlocked.includes(name) || value]))
}

const CODEX_SANDBOX: Readonly<Record<TSandboxLevel, NonNullable<ThreadOptions['sandboxMode']>>> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  full: 'danger-full-access',
}

export const CODEX_LOCKED_FEATURES: Readonly<Record<string, boolean>> = {
  shell_tool: false,
  unified_exec: false,
  apps: false,
  browser_use: false,
  browser_use_external: false,
  browser_use_full_cdp_access: false,
  computer_use: false,
  in_app_browser: false,
  in_app_local_automation: false,
  goals: false,
  hooks: false,
  image_generation: false,
  multi_agent: false,
  plugins: false,
  remote_plugin: false,
  skill_search: false,
  skill_mcp_dependency_install: false,
  sleep_tool: false,
  tool_suggest: false,
  view_image: false,
  workspace_dependencies: false,
  worktrees: false,
  tool_search_always_defer_mcp_tools: false,
}

/**
 * Lane `agent` do ChatGPT pela ASSINATURA, sobre o `@openai/codex-sdk` (que roda o binário `codex`).
 *
 * ⛔ Cada conversa num diretório vazio, `approvalPolicy: never`, com o sandbox e a rede que o agente
 * escolheu para este provider (padrão `read-only` e sem rede, ver `Sandbox.Policy`), com o `CODEX_HOME` do gateway (nunca o `~/.codex` da pessoa, com os MCPs e conectores dela)
 * e o ambiente mínimo. As ferramentas do agente chegam só por MCP (`mcp:<servidor>/…`); as locais
 * in-process (busca, delegação) não existem para o Codex.
 */
export class CodexAgentAdapter implements IAgentAdapter {
  private readonly store: SessionStore
  private readonly catalog?: ToolCatalog
  private readonly connections?: IConnectionSource
  private readonly load: () => Promise<TCodexClass>
  private readonly home: () => string
  private readonly versionIssue: () => string | undefined

  constructor(deps: ICodexAgentAdapterDeps = {}) {
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
    this.connections = deps.connections
    this.load = deps.load ?? (async () => (await esmImport<{ Codex: TCodexClass }>('@openai/codex-sdk')).Codex)
    this.home = deps.home ?? (() => subscriptionHome('codex'))
    this.versionIssue = deps.versionIssue ?? (deps.load ? () => undefined : () => untestedCodex())
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const choice = sessionChoice(agent, input)
    const record = this.store.create(sessionPrefix(EProvider.CODEX, EMode.AGENT), {
      agentId: agent.id,
      provider: choice.provider,
      protocol: EProvider.CODEX,
      mode: EMode.AGENT,
      model: choice.model,
      reasoning: input.reasoning,
      language: input.language,
      tools: false,
      systemPrompt: composeSystemPrompt(agent, input),
      metadata: input.metadata,
      native: {},
    })
    return { id: record.id, provider: record.provider, mode: record.mode, createdAt: record.createdAt, metadata: record.metadata }
  }

  async *sendMessage(agent: IAgent, sessionId: string, input: IMessageInput, context: IExecutionContext): AsyncIterable<IAgentEvent> {
    const now = () => new Date()
    const record = this.store.get(sessionId)
    if (!record) {
      yield { type: 'error', sessionId, timestamp: now(), payload: { message: `Session not found: ${sessionId}` } }
      return
    }
    if (this.connections && !this.connections.connection(record.provider)) {
      yield { type: 'error', sessionId, timestamp: now(), payload: { message: new UnavailableProviderError(record.provider).message } }
      return
    }

    const untested = this.versionIssue()
    if (untested) {
      yield { type: 'error', sessionId, timestamp: now(), payload: { message: untested } }
      return
    }

    const native = this.nativeOf(record)
    const abort = new AbortController()
    record.abort = abort
    yield { type: 'message.started', sessionId, timestamp: now() }

    const workspace = sessionWorkspace(sessionId)
    const { prompt, warnings } = this.buildInput(input, workspace)
    for (const message of warnings) yield { type: 'warning', sessionId, timestamp: now(), payload: { message } }
    if (this.catalog?.localFor(agent.allowedTools).length) {
      yield { type: 'warning', sessionId, timestamp: now(), payload: { message: 'O Codex usa só ferramentas de MCP: as locais deste agente ficam de fora.' } }
    }

    try {
      const remotes = (await this.catalog?.mcpServersFor(agent.allowedTools, context)) ?? []
      const Codex = await this.load()
      const home = this.home()
      const codex = new Codex({
        env: subscriptionEnv({ HOME: workspace, CODEX_HOME: home }),
        config: {
          developer_instructions: withMcpHint(record.systemPrompt, remotes),
          features: codexFeatures(agent.allowedTools),
          // ⛔ Login em ARQUIVO no CODEX_HOME do gateway, nunca no Keychain da pessoa.
          cli_auth_credentials_store: 'file',
          mcp_servers: codexMcpServers(remotes, context.token),
        } as NonNullable<CodexOptions['config']>,
      })

      const webSearch = nativeToolsOf(agent.allowedTools, EProvider.CODEX).some((tool) => tool.sdkName === 'web_search')
      const target = agent.providers.find((candidate) => candidate.provider === record.provider)
      const options: ThreadOptions = {
        model: record.model || undefined,
        workingDirectory: workspace,
        skipGitRepoCheck: true,
        sandboxMode: CODEX_SANDBOX[sandboxOf(EProvider.CODEX, target?.sandbox)],
        approvalPolicy: 'never',
        networkAccessEnabled: !!target?.network,
        webSearchMode: webSearch ? 'live' : 'disabled',
        modelReasoningEffort: reasoningLevel(EProvider.CODEX, record.reasoning) as ThreadOptions['modelReasoningEffort'],
      }
      const thread = native.threadId ? codex.resumeThread(native.threadId, options) : codex.startThread(options)
      const { events } = await thread.runStreamed(prompt, { signal: abort.signal })

      const turn: ICodexTurn = { texted: false }
      for await (const event of events) {
        for (const mapped of codexEvents(event, sessionId, native, turn)) {
          yield mapped
          if (mapped.type === 'error') return
        }
      }
      yield { type: 'message.completed', sessionId, timestamp: now() }
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: now() }
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error('[CodexAgent] Error:', message)
      yield { type: 'error', sessionId, timestamp: now(), payload: { message } }
    } finally {
      record.abort = undefined
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.store.get(sessionId)?.abort?.abort()
  }

  private nativeOf(record: ISessionRecord): ICodexNative {
    if (!record.native) record.native = {}
    return record.native as ICodexNative
  }

  /** Imagem vira arquivo no diretório da conversa (o Codex lê `local_image` por caminho); o resto, aviso. */
  private buildInput(input: IMessageInput, workspace: string): { prompt: string | UserInput[]; warnings: string[] } {
    const files = input.files ?? []
    if (!files.length) return { prompt: input.text, warnings: [] }

    const parts: UserInput[] = input.text.trim() ? [{ type: 'text', text: input.text }] : []
    const warnings: string[] = []
    files.forEach((file, index) => {
      if (!file.mimeType.startsWith('image/')) {
        warnings.push(`Attachment "${file.name}" (${file.mimeType}) is not supported by Codex and was skipped.`)
        return
      }
      const path = join(workspace, `anexo-${Date.now()}-${index}.${file.mimeType.split('/')[1] ?? 'png'}`)
      writeFileSync(path, Buffer.from(file.data, 'base64'))
      parts.push({ type: 'local_image', path })
    })
    return { prompt: parts, warnings }
  }
}

/**
 * ⚠️ O Codex tem ferramentas internas com nome de ferramenta nossa (`list_agents`, da colaboração dele),
 * e modelo menor escolhe a interna — verificado com o GPT-5.6 Terra, que respondia "1 agente: /root".
 * Dizer quais vêm do MCP resolve.
 */
export function withMcpHint(systemPrompt: string, remotes: readonly IAgentMcpServer[]): string {
  if (!remotes.length) return systemPrompt
  const lines = remotes.map((remote) => `- servidor MCP \`${remote.config.id}\`: ${remote.tools?.join(', ') ?? 'todas as ferramentas dele'}`)
  return `${systemPrompt}\n\n## Ferramentas\nAs ferramentas deste agente chegam por MCP:\n${lines.join('\n')}\nQuando o pedido citar uma delas, chame a do MCP, nunca uma ferramenta interna de mesmo nome.`
}

/** `mcp_servers` da config do Codex: URL, headers (a credencial de quem conversa) e o filtro de ferramentas. */
export function codexMcpServers(remotes: readonly IAgentMcpServer[], token?: string): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {}
  for (const remote of remotes) {
    const headers = mcpHeaders(remote, token)
    servers[remote.config.id.replace(/[^a-zA-Z0-9_-]/g, '_')] = {
      url: remote.config.url,
      ...(headers ? { http_headers: headers } : {}),
      ...(remote.tools ? { enabled_tools: remote.tools } : {}),
    }
  }
  return servers
}

/** Um evento do Codex nos eventos do gateway. */
export function codexEvents(event: ThreadEvent, sessionId: string, native: ICodexNative, turn: ICodexTurn = { texted: false }): IAgentEvent[] {
  const timestamp = new Date()
  switch (event.type) {
    case 'thread.started':
      native.threadId = event.thread_id
      return []
    case 'item.started':
      return event.item.type === 'mcp_tool_call' ? [{ type: 'tool.started', sessionId, timestamp, payload: { tool: event.item.tool, args: toArgs(event.item.arguments) } }] : []
    case 'item.completed':
      return itemEvents(event.item, sessionId, timestamp, turn)
    case 'turn.completed':
      return [
        {
          type: 'usage',
          sessionId,
          timestamp,
          payload: {
            // ⚖️ Como na OpenAI: `cached_input_tokens` é PARCELA de `input_tokens`, não soma a ela.
            inputTokens: event.usage.input_tokens,
            cacheReadTokens: event.usage.cached_input_tokens ?? 0,
            cacheWriteTokens: event.usage.cache_write_input_tokens ?? 0,
            outputTokens: event.usage.output_tokens,
            reasoningTokens: event.usage.reasoning_output_tokens ?? 0,
          },
        },
      ]
    case 'turn.failed':
      return [{ type: 'error', sessionId, timestamp, payload: { message: event.error.message } }]
    case 'error':
      return [{ type: 'error', sessionId, timestamp, payload: { message: event.message } }]
    default:
      return []
  }
}

function itemEvents(item: ThreadItem, sessionId: string, timestamp: Date, turn: ICodexTurn): IAgentEvent[] {
  switch (item.type) {
    case 'agent_message': {
      const text = turn.texted ? `\n\n${item.text}` : item.text
      turn.texted = true
      return [{ type: 'text.delta', sessionId, timestamp, payload: { text } }]
    }
    case 'reasoning':
      return [{ type: 'reasoning.delta', sessionId, timestamp, payload: { text: item.text } }]
    case 'mcp_tool_call':
      return [{ type: 'tool.result', sessionId, timestamp, payload: { tool: item.tool, result: item.error?.message ?? item.result?.content ?? null } }]
    case 'command_execution':
      return [
        { type: 'tool.started', sessionId, timestamp, payload: { tool: 'command', args: { command: item.command } } },
        { type: 'tool.result', sessionId, timestamp, payload: { tool: 'command', result: item.aggregated_output } },
      ]
    case 'web_search':
      return [{ type: 'tool.started', sessionId, timestamp, payload: { tool: 'web_search', args: { query: item.query } } }]
    // ⚠️ O Codex avisa de config ignorada e de recurso desligado como `error` NÃO FATAL: vira aviso.
    case 'error':
      return [{ type: 'warning', sessionId, timestamp, payload: { message: item.message } }]
    default:
      return []
  }
}

function toArgs(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
