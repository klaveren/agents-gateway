import { sessionChoice } from '@domain/Agent.Policy'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { nativeToolsOf } from '@domain/Native.Tools'
import { IConnectionSource, requireConnection, UnavailableProviderError } from './support/Keyed.Client'
import { dataDir, workspaceFor, subscriptionEnv } from './support/Subscription.Workspace'
import { query, type CanUseTool, type EffortLevel, type Options, type HookCallback, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { IProjectSandbox, PATH_FIELDS, projectPathIssue, projectSandbox } from '@infra/sandbox/Project.Sandbox'
import { deniedPath } from '@infra/tools/File.Tools'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { reasoningLevel } from '@domain/Reasoning.Levels'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IFileAttachment, IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { sessionPrefix } from '@infra/session/Session.Key'
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'
import { buildClaudeMcpServers, claudeHiddenTools, claudeMcpServerName } from '@infra/tools/bridges/Claude.ToolBridge'
import { IAgentMcpServer, ToolCatalog } from '@infra/tools/Tool.Catalog'
import { composeSystemPrompt, maxToolTurns } from './support/Prompt.Helper'

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type TImageType = (typeof IMAGE_TYPES)[number]

type TQuery = typeof query

/**
 * O id que o CLI do Claude conhece. É um UUID nosso, plantado via `options.sessionId`
 * no primeiro turno e reapresentado via `options.resume` nos seguintes.
 */
interface IClaudeAgentNative {
  sdkSessionId: string
  started: boolean
}

export interface IClaudeAgentAdapterDeps {
  query?: TQuery
  /**
   * De onde vêm a chave e a URL em cada turno. Ausente = o subprocesso herda o ambiente, como antes.
   *
   * ⚠️ O CLI do Claude é um SUBPROCESSO: ele não vê a store, só o `env` que recebe. A chave vai em
   * `options.env` a cada turno — é o que faz a troca pela tela valer sem reiniciar.
   */
  connections?: IConnectionSource
  store?: SessionStore
  catalog?: ToolCatalog
  /**
   * Pela ASSINATURA (Claude Pro/Max), protocolo `claude-sub`: nenhuma chave de API vai ao CLI, que usa o
   * login do host — ou o `CLAUDE_CODE_OAUTH_TOKEN` (de `claude setup-token`) salvo no lugar da chave.
   * ⛔ O CLI recebe o ambiente mínimo, não o `.env` do gateway, e roda num diretório vazio por conversa.
   */
  subscription?: boolean
  /** O cerco do agente de projeto (ver `Project.Sandbox`). Ausente = o do processo. */
  sandbox?: IProjectSandbox
}

/**
 * Lane `agent` do Claude, sobre o `@anthropic-ai/claude-agent-sdk`.
 *
 * Quem conduz o loop agêntico é o SDK — ele fala com um subprocesso `claude` que o
 * pacote entrega junto (~310 MB, uma optionalDependency por plataforma). Não há
 * `while` de tool aqui, e é esse justamente o ponto do experimento.
 */
export class ClaudeAgentAdapter implements IAgentAdapter {
  private readonly query: TQuery
  private readonly store: SessionStore
  private readonly catalog?: ToolCatalog
  private readonly sandbox: IProjectSandbox

  private readonly connections?: IConnectionSource
  private readonly protocol: EProvider

  constructor(deps: IClaudeAgentAdapterDeps = {}) {
    this.query = deps.query ?? query
    this.connections = deps.connections
    this.protocol = deps.subscription ? EProvider.CLAUDE_SUB : EProvider.CLAUDE
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
    this.sandbox = deps.sandbox ?? projectSandbox()
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const choice = sessionChoice(agent, input)
    const record = this.store.create(sessionPrefix(this.protocol, EMode.AGENT), {
      agentId: agent.id,
      provider: choice.provider,
      protocol: this.protocol,
      mode: EMode.AGENT,
      // O modelo vem resolvido pelo provider de sessões (o pedido, ou o padrão do agente).
      model: choice.model,
      reasoning: input.reasoning,
      language: input.language,
      tools: false,
      systemPrompt: composeSystemPrompt(agent, input),
      metadata: input.metadata,
      // O SDK exige um UUID limpo aqui; o id do gateway leva prefixo e não serve.
      native: { sdkSessionId: randomUUID(), started: false },
    })

    return {
      id: record.id,
      provider: record.provider,
      mode: record.mode,
      createdAt: record.createdAt,
      metadata: record.metadata,
    }
  }

  async *sendMessage(agent: IAgent, sessionId: string, input: IMessageInput, context: IExecutionContext): AsyncIterable<IAgentEvent> {
    const record = this.store.get(sessionId)
    if (!record) {
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: `Session not found: ${sessionId}` } }
      return
    }

    const native = this.nativeOf(record)
    const abort = new AbortController()
    record.abort = abort

    const { blocks, warnings } = this.buildBlocks(input)

    yield { type: 'message.started', sessionId, timestamp: new Date() }
    for (const message of warnings) {
      yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message } }
    }

    let env: Record<string, string | undefined> | undefined
    try {
      env =
        this.protocol === EProvider.CLAUDE_SUB
          ? this.subscriptionEnv(record.provider)
          : this.connections
            ? cliEnv(requireConnection(record.provider, EProvider.CLAUDE, this.connections))
            : undefined
    } catch (error: unknown) {
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: error instanceof Error ? error.message : String(error) } }
      return
    }

    const local = this.catalog?.localFor(agent.allowedTools) ?? []
    const natives = nativeToolsOf(agent.allowedTools, EProvider.CLAUDE).flatMap((tool) => tool.sdkNames ?? [tool.sdkName])
    const remotes = (await this.catalog?.mcpServersFor(agent.allowedTools, context)) ?? []

    const project = agent.projectId ? { projectId: agent.projectId, dir: workspaceFor(agent.projectId, sessionId) } : undefined
    const gate = this.makeGate([...agent.allowedTools, ...natives, ...local.map((tool) => tool.name)], remotes, project)
    const options: Options = {
      model: record.model,
      systemPrompt: record.systemPrompt,
      // Os built-ins do Claude Code que ESTE agente tem ligados (ferramentas nativas, `sdk:*`) — e só
      // eles. Vazio = nenhum: sem isto o agente ganharia Bash/Read/Edit sobre a máquina do host. As
      // tools nossas (locais e do MCP) chegam por `mcpServers`.
      tools: natives,
      mcpServers: buildClaudeMcpServers(local, remotes, context.token, context),
      // ⛔ As ferramentas de um servidor que o agente NÃO escolheu saem do contexto do modelo: o SDK lista o servidor
      // inteiro, e o portão só recusava depois de o modelo tentar (uma ida perdida, e ele achando que podia).
      disallowedTools: claudeHiddenTools(remotes),
      // Nomes soltos em `allowedTools` aprovam antes de o callback rodar e o SDK
      // avisa que o `canUseTool` foi sombreado; por isso o gate fica só aqui.
      // As locais montadas entram pelo NOME — a `delegate_to_agent` vem de `agent:<id>`, não de um nome em `allowedTools`.
      canUseTool: gate,
      // ⛔ A MESMA decisão também no PreToolUse, que roda em toda ferramenta e em TODO agente — o SDK libera leitura
      // (Read, Glob, Grep) sem passar pelo `canUseTool`, e o filtro de caminho (projeto) e a lista protegida (.env,
      // chaves, dados do gateway) seriam pulados.
      hooks: { PreToolUse: [{ hooks: [preToolUse(gate)] }] },
      // Isolamento: sem isto o subprocesso lê o ~/.claude e o CLAUDE.md da máquina.
      settingSources: [],
      includePartialMessages: true,
      maxTurns: maxToolTurns(),
      abortController: abort,
      ...(native.started ? { resume: native.sdkSessionId } : { sessionId: native.sdkSessionId }),
      ...(env ? { env } : {}),
      // Toda lane num diretório vazio por conversa: o `cwd` do processo é a pasta do gateway (`.env`, banco).
      cwd: workspaceFor(agent.projectId, sessionId),
    }

    const effort = this.toEffort(record.reasoning)
    if (effort) options.effort = effort

    const stream = this.query({ prompt: this.buildPrompt(input, blocks), options })

    // O bloco `tool_result` só traz o `tool_use_id`. Sem guardar o nome da chamada, o
    // evento de resultado sairia identificado por um id opaco.
    const toolNames = new Map<string, string>()
    /** A entrada da última chamada ao modelo neste turno (ver `IUsage.contextTokens`). */
    let lastContext: number | undefined

    try {
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
          // O CLI é a autoridade sobre o id da sessão; adotamos o que ele devolve.
          native.sdkSessionId = message.session_id
          native.started = true

          // O `init` diz o que o CLI de fato ligou. Nativa pedida e ausente (um compatível que não a
          // suporta, uma versão do CLI que a renomeou) vira aviso — em vez de um agente que só não usa.
          const enabled = new Set((message as { tools?: string[] }).tools ?? [])
          const missing = natives.filter((name) => !enabled.has(name))
          if (missing.length) yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message: `O SDK do Claude não ligou: ${missing.join(', ')}.` } }
          continue
        }

        if (message.type === 'stream_event') {
          const event = message.event
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: event.delta.text } }
            } else if (event.delta.type === 'thinking_delta') {
              yield { type: 'reasoning.delta', sessionId, timestamp: new Date(), payload: { text: event.delta.thinking } }
            }
          }
          continue
        }

        // O texto já saiu pelos deltas; da mensagem inteira só aproveitamos as tools.
        if (message.type === 'assistant') {
          // O consumo DESTA chamada ao modelo: a entrada dela (com cache) é o contexto em uso agora. O `result`
          // traz a soma do turno, que não serve para isso.
          const call = message.message.usage
          if (call) lastContext = call.input_tokens + (call.cache_creation_input_tokens ?? 0) + (call.cache_read_input_tokens ?? 0)
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              const tool = this.bareToolName(block.name)
              toolNames.set(block.id, tool)
              yield {
                type: 'tool.started',
                sessionId,
                timestamp: new Date(),
                payload: { tool, args: this.toArgs(block.input) },
              }
            }
          }
          continue
        }

        if (message.type === 'user') {
          const content = message.message.content
          if (typeof content === 'string') continue
          for (const block of content) {
            if (block.type === 'tool_result') {
              const tool = toolNames.get(block.tool_use_id) ?? block.tool_use_id
              // ⚠️ Recusada pelo portão ou falhou (`is_error`): sai como erro — antes saía como resultado, e a tela
              // marcava ✓ numa chamada que nem rodou.
              if (block.is_error) {
                yield { type: 'tool.error', sessionId, timestamp: new Date(), payload: { tool, message: resultText(block.content) } }
                continue
              }
              yield {
                type: 'tool.result',
                sessionId,
                timestamp: new Date(),
                payload: { tool, result: block.content },
              }
            }
          }
          continue
        }

        if (message.type === 'result') {
          native.started = true

          yield {
            type: 'usage',
            sessionId,
            timestamp: new Date(),
            payload: {
              /**
               * ⚠️ A ENTRADA DO CLAUDE VEM EM TRÊS CAMPOS, e `input_tokens` é o MENOR deles: só o que não
               * passou pelo cache. O que já foi enviado antes vira `cache_read_input_tokens`, o que acabou
               * de entrar no cache vira `cache_creation_input_tokens`. Lendo só o primeiro, uma conversa
               * inteira aparecia com dezenas de tokens de entrada — um número plausível e errado.
               *
               * ⚖️ Somados como entrada porque entrada é o que são, e as duas parcelas saem também
               * SEPARADAS: o preço delas difere (leitura custa uma fração, gravação custa mais).
               */
              inputTokens: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
              cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
              outputTokens: message.usage.output_tokens,
              ...(lastContext !== undefined ? { contextTokens: lastContext } : {}),
            },
          }

          if (message.subtype !== 'success' || message.is_error) {
            const detail = message.subtype === 'success' ? message.result : message.errors.join('; ')
            yield {
              type: 'error',
              sessionId,
              timestamp: new Date(),
              payload: { message: detail || `Claude Agent SDK stopped: ${message.subtype}` },
            }
            return
          }
        }
      }

      yield { type: 'message.completed', sessionId, timestamp: new Date() }
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: new Date() }
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      console.error('[ClaudeAgent] Error:', message)
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message } }
    } finally {
      record.abort = undefined
      stream.return(undefined).catch(() => undefined)
    }
  }

  /**
   * Deixa passar o que o agente declarou e o que veio do MCP server — quem escolheu
   * subir aquele server foi o operador. Qualquer outra coisa é recusada com motivo.
   */
  /**
   * O store é compartilhado pelos seis adapters, então o slot nativo é `unknown`. Este é o
   * único ponto do adapter que sabe o formato do que ele guardou lá.
   */
  /** O id do CLI, depois que ele começou: é o que a retomada reapresenta com `options.resume`. */
  exportNative(sessionId: string): unknown {
    const native = this.store.get(sessionId)?.native as IClaudeAgentNative | undefined
    return native?.started ? { sdkSessionId: native.sdkSessionId } : undefined
  }

  /**
   * ⚖️ Planta o id guardado SÓ se o CLI ainda tem a conversa (`<config>/projects/<pasta>/<id>.jsonl`): sem o arquivo,
   * o `resume` falharia no meio do turno — e a transcrição é o que vale. A pasta é procurada em todas, sem depender de
   * como o CLI codifica o `cwd`.
   */
  restoreNative(sessionId: string, data: unknown): boolean {
    const record = this.store.get(sessionId)
    const id = (data as { sdkSessionId?: unknown } | undefined)?.sdkSessionId
    if (!record || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !cliSessionExists(id)) return false
    record.native = { sdkSessionId: id, started: true } satisfies IClaudeAgentNative
    return true
  }

  private nativeOf(record: ISessionRecord): IClaudeAgentNative {
    if (!record.native) record.native = { sdkSessionId: randomUUID(), started: false }
    return record.native as IClaudeAgentNative
  }

  /**
   * O nome da tool sem o prefixo do SDK.
   *
   * ⚖️ O SDK do Claude nomeia tool de MCP como `mcp__<servidor>__<tool>`. A execução já tirava isso;
   * o EVENTO não, então o turno gravava o nome cheio e quem agrega contava a mesma tool sob dois
   * nomes. Um ponto só, usado no gate e na emissão, mantém o nome consistente.
   */
  private bareToolName(name: string): string {
    if (!name.startsWith('mcp__')) return name
    const [, , ...rest] = name.split('__')
    return rest.join('__') || name
  }

  /**
   * ⛔ O portão: tool local ou nativa só se o agente a tem; de servidor MCP, só as escolhidas nele (ou
   * todas, com `mcp:<id>/*`). Servidor que o agente não escolheu nem é montado.
   */
  private makeGate(allowed: string[], remotes: readonly IAgentMcpServer[] = [], project?: { projectId: string; dir: string }): CanUseTool {
    const byServer = new Map(remotes.map((remote) => [claudeMcpServerName(remote.config.id), remote]))
    // Os comandos que ESTE portão já embrulhou: o hook e o `canUseTool` podem passar pelo mesmo Bash, e um
    // cerco dentro do outro falharia. ⛔ Pela linha exata, nunca por um marcador no texto (o modelo forjaria).
    const wrapped = new Set<string>()
    return async (toolName, input) => {
      const [, server] = toolName.split('__')
      const isMcp = toolName.startsWith('mcp__')
      const bare = this.bareToolName(toolName)

      const remote = isMcp ? byServer.get(server) : undefined
      if (remote && (!remote.tools || remote.tools.includes(bare))) return { behavior: 'allow' }
      if (!remote && allowed.includes(bare)) {
        // ⛔ Em qualquer agente, de projeto ou global: as nativas de arquivo nunca tocam .env, chaves nem os dados do gateway.
        const protectedPath = protectedPathOf(bare, input, project?.dir)
        if (protectedPath) return { behavior: 'deny', message: `${protectedPath}: este arquivo é protegido.` }
        return project ? this.confined(bare, input, project, wrapped) : { behavior: 'allow' }
      }

      return { behavior: 'deny', message: `Tool "${bare}" is not enabled for this agent.` }
    }
  }

  /**
   * ⛔ O AGENTE DE PROJETO SÓ ALCANÇA A PASTA DELE: o Bash roda embrulhado no cerco do sistema operacional
   * (sem cerco, não roda), e as ferramentas de arquivo passam pelo filtro de caminho.
   */
  private async confined(bare: string, input: Record<string, unknown>, project: { projectId: string; dir: string }, wrapped: Set<string>): Promise<PermissionResult> {
    if (bare === 'Bash') {
      const command = String(input.command ?? '')
      if (wrapped.has(command)) return { behavior: 'allow' }
      try {
        const line = await this.sandbox.wrap(command, project.projectId)
        wrapped.add(line)
        return { behavior: 'allow', updatedInput: { ...input, command: line } }
      } catch (error: unknown) {
        return { behavior: 'deny', message: `${error instanceof Error ? error.message : String(error)}. O Bash de agente de projeto fica bloqueado até o cerco funcionar.` }
      }
    }
    const issue = projectPathIssue(project.dir, project.dir, bare, input)
    return issue ? { behavior: 'deny', message: `${issue}: o agente deste projeto só lê e grava na pasta dele.` } : { behavior: 'allow' }
  }

  /** Sem chave de API: o login do host, ou o token OAuth salvo no lugar da chave. */
  private subscriptionEnv(providerId: string): Record<string, string> {
    const connection = this.connections?.connection(providerId)
    if (this.connections && !connection) throw new UnavailableProviderError(providerId)
    // ⛔ Sem os conectores da conta claude.ai de quem fez o login (Docs, Drive…): com o login do host o CLI
    // os carregava, e eles apareciam para os agentes do gateway.
    return subscriptionEnv({ HOME: process.env.HOME, CLAUDE_CODE_OAUTH_TOKEN: connection?.key, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' })
  }

  async cancel(sessionId: string): Promise<void> {
    // O objeto Query não expõe `.abort()` — o que existe é o AbortController e `.close()`.
    this.store.get(sessionId)?.abort?.abort()
  }

  /**
   * Sem anexos, um prompt de texto basta. Com anexos é preciso o modo de entrada em
   * streaming, que é o único caminho para mandar blocos `image` e `document`.
   */
  private buildPrompt(input: IMessageInput, blocks: SDKUserMessage['message']['content']): string | AsyncIterable<SDKUserMessage> {
    if (typeof blocks === 'string') return input.text

    async function* once(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null }
    }

    return once()
  }

  private buildBlocks(input: IMessageInput): { blocks: SDKUserMessage['message']['content']; warnings: string[] } {
    const files = input.files ?? []
    if (files.length === 0) return { blocks: input.text, warnings: [] }

    // Texto vazio não vira bloco: a API recusa bloco de texto vazio, e anexo sem frase é mensagem válida.
    const blocks: Exclude<SDKUserMessage['message']['content'], string> = input.text.trim() ? [{ type: 'text', text: input.text }] : []
    const warnings: string[] = []

    for (const file of files) {
      if (this.isImageType(file.mimeType)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mimeType, data: file.data } })
      } else if (file.mimeType === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } })
      } else {
        warnings.push(this.unsupported(file))
      }
    }

    return { blocks, warnings }
  }

  private unsupported(file: IFileAttachment): string {
    return `Attachment "${file.name}" (${file.mimeType}) is not supported by Claude and was skipped.`
  }

  private isImageType(mimeType: string): mimeType is TImageType {
    return (IMAGE_TYPES as readonly string[]).includes(mimeType)
  }

  private toArgs(input: unknown): Record<string, unknown> {
    return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  }

  private toEffort(reasoning: string | undefined): EffortLevel | undefined {
    return reasoningLevel(EProvider.CLAUDE, reasoning) as EffortLevel | undefined
  }
}

/**
 * O ambiente do subprocesso do CLI para uma conexão.
 *
 * ⚖️ OFICIAL: `ANTHROPIC_API_KEY`. COMPATÍVEL (OpenRouter e afins): `ANTHROPIC_BASE_URL` mais a chave
 * como `ANTHROPIC_AUTH_TOKEN` (Bearer), com `ANTHROPIC_API_KEY` VAZIA — é o que esses gateways
 * documentam, e o que impede o CLI de mandar a chave no cabeçalho da Anthropic a um terceiro.
 */
export function cliEnv(connection: { key: string; baseUrl?: string; compatible: boolean }): Record<string, string | undefined> {
  // ⛔ Ambiente MÍNIMO, nunca `{ ...process.env }`: com `sdk:Bash`/`sdk:Read` o CLI levaria as outras chaves,
  // o `AUTH_SECRET` e o `SECRETS_KEY`. O `cwd` é o da conversa.
  // ⚖️ `CLAUDE_CONFIG_DIR` no volume de dados: as conversas do CLI sobrevivem ao reinício (no pod o HOME é só
  // leitura) — é o que deixa a retomada continuar com a memória dele —, e ele não lê a configuração pessoal do
  // `~/.claude` de quem roda o gateway (MCPs, CLAUDE.md).
  const base = subscriptionEnv({ HOME: process.env.HOME, CLAUDE_CONFIG_DIR: claudeConfigDir(), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' })
  if (!connection.compatible) return { ...base, ANTHROPIC_API_KEY: connection.key }

  return { ...base, ANTHROPIC_BASE_URL: connection.baseUrl, ANTHROPIC_AUTH_TOKEN: connection.key, ANTHROPIC_API_KEY: '' }
}

/** O `PreToolUse` com a decisão do portão: nega o que o portão nega e aplica o `updatedInput` (o Bash cercado). */
function preToolUse(gate: CanUseTool): HookCallback {
  return async (input, _toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const decision = await gate(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, { signal, toolUseID: input.tool_use_id } as Parameters<CanUseTool>[2])
    if (decision?.behavior === 'allow')
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}) } }
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision && 'message' in decision ? decision.message : 'denied' },
    }
  }
}

/** Onde o CLI do Claude guarda configuração e conversas: `<dados>/claude-cli` (no pod, o PVC). O CLI cria a pasta. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'claude-cli')
}

/** O CLI ainda tem a conversa `id`? (`<config>/projects/<qualquer pasta>/<id>.jsonl`). */
export function cliSessionExists(id: string, root = claudeConfigDir()): boolean {
  const projects = join(root, 'projects')
  if (!existsSync(projects)) return false
  return readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${id}.jsonl`)))
}

/** O texto de um `tool_result` (string ou blocos), para a mensagem de erro. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return (
      content
        .map((block) => (block && typeof block === 'object' && 'text' in block ? String(block.text) : ''))
        .join('\n')
        .trim() || 'tool failed'
    )
  return 'tool failed'
}

/** O caminho protegido que uma nativa de arquivo do Claude pediu (ver `deniedPath`), ou nada. Glob relativo não aponta para fora. */
function protectedPathOf(toolName: string, input: Record<string, unknown>, root = PROTECTED_ROOT): string | undefined {
  for (const field of PATH_FIELDS[toolName] ?? []) {
    const value = input[field]
    if (typeof value !== 'string' || !value || ((field === 'pattern' || field === 'glob') && !isAbsolute(value))) continue
    const reason = deniedPath(resolve(root === PROTECTED_ROOT ? process.cwd() : root, value), root)
    if (reason) return `${toolName}: ${value} (${reason})`
  }
  return undefined
}

/** Agente global: nenhuma pasta liberada dentro dos dados do gateway. O de projeto libera a pasta dele (o cerco faz o resto). */
const PROTECTED_ROOT = '/nonexistent-root'
