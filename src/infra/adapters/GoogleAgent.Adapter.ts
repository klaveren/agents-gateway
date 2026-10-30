import { sessionChoice } from '@domain/Agent.Policy'
import { errorPayload } from '@domain/Provider.Failure'
import { randomUUID } from 'node:crypto'
import { nativeToolsOf } from '@domain/Native.Tools'
import { IConnectionSource, requireConnection } from './support/Keyed.Client'
import {
  BuiltInCodeExecutor,
  EventType,
  Gemini,
  GOOGLE_SEARCH,
  InMemorySessionService,
  LlmAgent,
  Runner,
  URL_CONTEXT,
  StreamingMode,
  toStructuredEvents,
  type BaseTool,
  type BaseToolset,
  type Event,
} from '@google/adk'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent, IUsage } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { sessionPrefix } from '@infra/session/Session.Key'
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'
import { buildAdkRemoteTools, buildAdkTools } from '@infra/tools/bridges/Adk.ToolBridge'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { composeSystemPrompt } from './support/Prompt.Helper'

const APP_NAME = 'agents-gateway'

interface IAdkPart {
  text?: string
  inlineData?: { data: string; mimeType: string }
}

export interface IAdkContent {
  role?: string
  parts?: IAdkPart[]
}

export interface IAdkRunParams {
  userId: string
  sessionId: string
  newMessage: IAdkContent
  abortSignal: AbortSignal
}

/**
 * A superfície mínima do ADK que este adapter usa. Existe para que o teste consiga
 * substituir o runtime inteiro sem subir `Runner`, `LlmAgent` nem tocar na rede.
 */
export interface IAdkRuntime {
  ensureSession(userId: string, sessionId: string): Promise<void>
  runAsync(params: IAdkRunParams): AsyncGenerator<Event, void, undefined>
}

/** O consumo cru do Gemini, como vem no `usageMetadata`. */
export interface IAdkUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
}

/** Uma resposta crua do modelo, do jeito que o `afterModelCallback` do ADK a entrega. */
export interface IAdkModelResponse {
  partial?: boolean
  finishReason?: unknown
  usageMetadata?: IAdkUsageMetadata
}

export interface IAdkRuntimeSpec {
  name: string
  model: string
  /**
   * O modelo EM VIGOR, lido a cada chamada. ⚖️ O runtime nasce uma vez por sessão (é ele que guarda o
   * histórico) com `model`; a troca no meio da conversa (`AgentProvider.reconfigure`) chega por aqui.
   */
  modelOf?: () => string
  /** A chave da sessão. Ausente = o ADK lê `GOOGLE_GENAI_API_KEY`/`GEMINI_API_KEY` do ambiente. */
  apiKey?: string
  /** As ferramentas nativas do Gemini ligadas (`Native.Tools`): buscas vão em `tools`; código, em `codeExecutor`. */
  natives?: string[]
  instruction: string
  tools: Array<BaseTool | BaseToolset>
  /**
   * Cada resposta crua do modelo — inclusive a ÚLTIMA de cada chamada, que o ADK não transforma em
   * evento quando a chamada termina pedindo ferramenta. É dela que sai o consumo (ver `finalUsageOf`).
   */
  onModelResponse?: (response: IAdkModelResponse) => void
}

export type TAdkRuntimeFactory = (spec: IAdkRuntimeSpec) => IAdkRuntime

/** O runtime do ADK vive por sessão: é ele que carrega o histórico entre turnos. */
interface IGoogleAgentNative {
  runtime: IAdkRuntime
  userId: string
  adkSessionId: string
  /** Consumo de chamadas já encerradas, ainda não repassado ao stream. */
  usage: IUsage[]
  /**
   * A credencial do turno EM CURSO. O runtime (e com ele o closure das tools) vive a sessão
   * inteira; capturar o contexto do 1º turno no closure congelava o token — renovado ou vencido,
   * o MCP seguia recebendo o primeiro. As tools leem daqui, e cada turno atualiza.
   */
  caller: { context: IExecutionContext }
}

export interface IGoogleAgentAdapterDeps {
  /**
   * De onde vem a chave. ⚠️ Vale ao NASCER a sessão: o runtime do ADK é da sessão inteira (carrega o
   * histórico), então trocar a chave pela tela vale para as conversas que começam depois.
   */
  connections?: IConnectionSource
  createRuntime?: TAdkRuntimeFactory
  store?: SessionStore
  catalog?: ToolCatalog
}

/** As buscas nativas do Gemini, que entram em `tools` (a execução de código vai em `codeExecutor`). */
function nativeAdkTools(natives: readonly string[]): BaseTool[] {
  const tools: BaseTool[] = []
  if (natives.includes('google_search')) tools.push(GOOGLE_SEARCH)
  if (natives.includes('url_context')) tools.push(URL_CONTEXT)
  return tools
}

function defaultRuntimeFactory(spec: IAdkRuntimeSpec): IAdkRuntime {
  const sessionService = new InMemorySessionService()
  const agent = new LlmAgent({
    name: spec.name,
    model: spec.apiKey ? new Gemini({ model: spec.model, apiKey: spec.apiKey }) : spec.model,
    ...(spec.natives?.includes('code_execution') ? { codeExecutor: new BuiltInCodeExecutor() } : {}),
    // ⚠️ A API do Gemini RECUSA (400) ferramenta nativa junto de function tools sem esta flag — e com ela
    // devolve também as chamadas que o servidor fez, que é o que deixa a busca aparecer no stream.
    ...(spec.natives?.length ? { generateContentConfig: { toolConfig: { includeServerSideToolInvocations: true } } } : {}),
    // O ADK 1.6 usa `instruction` (singular) e `model`; não existem `instructions` nem `llm`.
    instruction: spec.instruction,
    tools: [...spec.tools, ...nativeAdkTools(spec.natives ?? [])],
    // O modelo em vigor sobrepõe o do agente na requisição; `undefined` = a chamada segue.
    beforeModelCallback: ({ request }) => {
      const model = spec.modelOf?.()
      if (model) request.model = model
      return undefined
    },
    // Só observa: devolver `undefined` mantém a resposta do modelo como veio.
    afterModelCallback: ({ response }) => {
      spec.onModelResponse?.(response as IAdkModelResponse)
      return undefined
    },
  })
  const runner = new Runner({ appName: APP_NAME, agent, sessionService })

  return {
    async ensureSession(userId, sessionId) {
      // `runAsync` não cria sessão: sem isto ele lança "Session not found".
      await sessionService.getOrCreateSession({ appName: APP_NAME, userId, sessionId })
    },
    runAsync(params) {
      return runner.runAsync({
        userId: params.userId,
        sessionId: params.sessionId,
        newMessage: params.newMessage,
        // O default do ADK é StreamingMode.NONE — sem isto não há token a token.
        runConfig: { streamingMode: StreamingMode.SSE },
        abortSignal: params.abortSignal,
      })
    },
  }
}

/**
 * Lane `agent` do Gemini, sobre o `@google/adk`.
 *
 * O ADK usa `@google/genai` v2 por baixo, enquanto a lane chat usa o legado
 * `@google/generative-ai` v0.24 — dois clientes Gemini no mesmo processo, e é
 * exatamente o contraste que o estudo quer mostrar.
 */
/**
 * Detecta `{identificador}` solto em `instruction` ANTES de entregar ao ADK — e falha com o texto
 * certo, em vez de deixar o erro do ADK aparecer no meio de um turno.
 *
 * ⚖️ POR QUE ISTO É DETECÇÃO, E NÃO ESCAPE. O `@google/adk` interpola `{var}` dentro de
 * `instruction` como variável de ESTADO da sessão (padrão Jinja), e não existe forma de marcar a
 * chave como literal: `{{id}}` NÃO escapa nada — o regex do ADK (`/\{+[^{}]*}+/g`) engole `{`,
 * `{{` ou `{{{` igual, então `{{id}}` é interpretado exatamente como `{id}`. Confirmado lendo o
 * source do pacote (`@google/adk/dist/cjs/agents/instructions.js`) depois que a "correção" com
 * chave dupla não teve efeito nenhum e o mesmo `Context variable not found: \`id\`.` continuou
 * aparecendo.
 *
 * Por isso a correção de verdade é no CONTEÚDO do `systemPrompt` — trocar `{id}` por `<id>` na
 * fonte do prompt. Esta função é a rede de segurança: falha no boot da sessão, apontando o padrão
 * exato, em vez de estourar em runtime sem dizer de onde veio.
 *
 * ⚠️ O detector é mais ESTREITO que o do ADK de propósito. O ADK casa `{qualquer coisa}`, o que
 * inclui um exemplo de JSON dentro do prompt; aqui só casa o que parece identificador. Um prompt
 * com `{"chave": 1}` ainda quebra no ADK e passa por aqui — o preço de não recusar no boot um
 * prompt que só tem um exemplo de JSON no meio.
 */
export function assertNoAdkTemplateCollision(prompt: string): string {
  const matches = prompt.match(/\{+[a-zA-Z_][a-zA-Z0-9_]*\??}+/g)
  if (matches?.length) {
    throw new Error(
      `systemPrompt contém ${matches.length} padrão(ões) que o @google/adk vai tentar resolver como variável de sessão e vai falhar: ${matches.slice(0, 5).join(', ')}. ` +
        `O ADK não tem escape para chave literal — troque por outra notação (ex.: <id> em vez de {id}) na fonte do prompt.`,
    )
  }
  return prompt
}

export class GoogleAgentAdapter implements IAgentAdapter {
  private readonly createRuntime: TAdkRuntimeFactory
  private readonly store: SessionStore
  private readonly catalog?: ToolCatalog
  private readonly connections?: IConnectionSource

  constructor(deps: IGoogleAgentAdapterDeps = {}) {
    this.createRuntime = deps.createRuntime ?? defaultRuntimeFactory
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
    this.connections = deps.connections
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const choice = sessionChoice(agent, input)
    const record = this.store.create(sessionPrefix(EProvider.GOOGLE, EMode.AGENT), {
      agentId: agent.id,
      provider: choice.provider,
      protocol: EProvider.GOOGLE,
      mode: EMode.AGENT,
      // O modelo vem resolvido pelo provider de sessões (o pedido, ou o padrão do agente).
      model: choice.model,
      reasoning: input.reasoning,
      language: input.language,
      tools: false,
      systemPrompt: composeSystemPrompt(agent, input),
      metadata: input.metadata,
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

    const abort = new AbortController()
    record.abort = abort

    yield { type: 'message.started', sessionId, timestamp: new Date() }

    if (record.reasoning) {
      yield {
        type: 'warning',
        sessionId,
        timestamp: new Date(),
        payload: { message: '@google/adk 1.6 has no reasoning-effort knob; the setting was ignored.' },
      }
    }

    try {
      const native = await this.nativeOf(record, agent, context)
      native.caller.context = context
      await native.runtime.ensureSession(native.userId, native.adkSessionId)

      const stream = native.runtime.runAsync({
        userId: native.userId,
        sessionId: native.adkSessionId,
        newMessage: this.buildContent(input),
        abortSignal: abort.signal,
      })

      // Em StreamingMode.SSE o ADK manda os pedaços com `partial: true` e depois um
      // evento agregado com o texto inteiro. Repassar os dois duplicaria a resposta.
      let sawPartialText = false
      // Sobra de um turno interrompido não pode entrar na conta deste.
      native.usage.length = 0

      for await (const event of stream) {
        const isPartial = event.partial === true

        for (const structured of toStructuredEvents(event)) {
          const carriesText = structured.type === EventType.CONTENT || structured.type === EventType.THOUGHT
          if (carriesText && !isPartial && sawPartialText) continue

          const mapped = this.toAgentEvent(structured, sessionId)
          if (mapped) yield mapped
        }

        yield* this.drainUsage(native, sessionId)

        if (isPartial) sawPartialText = true
        else sawPartialText = false
      }

      yield* this.drainUsage(native, sessionId)

      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: new Date() }
        return
      }

      yield { type: 'message.completed', sessionId, timestamp: new Date() }
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: new Date() }
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      console.error('[GoogleAgent] Error:', message)
      yield { type: 'error', sessionId, timestamp: new Date(), payload: errorPayload(error, message) }
    } finally {
      record.abort = undefined
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.store.get(sessionId)?.abort?.abort()
  }

  /**
   * O store é compartilhado pelos seis adapters, então o slot nativo é `unknown`. Este é o
   * único ponto do adapter que sabe o formato do que ele guardou lá.
   *
   * O runtime do ADK vive aqui porque é ele que carrega o histórico entre turnos: recriá-lo
   * a cada turno apagaria a conversa.
   */
  private async nativeOf(record: ISessionRecord, agent: IAgent, context: IExecutionContext): Promise<IGoogleAgentNative> {
    if (!record.native) {
      const usage: IUsage[] = []
      const caller = { context }
      // As tools remotas só são listadas quando o runtime nasce: depois, o resultado seria descartado.
      const remote = await this.remoteTools(agent, caller)
      record.native = {
        runtime: this.createRuntime({
          natives: nativeToolsOf(agent.allowedTools, EProvider.GOOGLE).map((tool) => tool.sdkName),
          apiKey: this.connections ? requireConnection(record.provider, EProvider.GOOGLE, this.connections).key : undefined,
          name: this.toAdkName(agent.id),
          model: record.model,
          modelOf: () => record.model,
          instruction: assertNoAdkTemplateCollision(record.systemPrompt),
          tools: this.buildTools(agent, remote, caller),
          onModelResponse: (response) => {
            const counted = this.finalUsageOf(response)
            if (counted) usage.push(counted)
          },
        }),
        userId: `gateway-${record.id}`,
        adkSessionId: randomUUID(),
        usage,
        caller,
      } satisfies IGoogleAgentNative
    }
    return record.native as IGoogleAgentNative
  }

  /**
   * O runtime do ADK é criado uma vez por sessão e carrega o histórico, então o toolset é
   * decidido ali. Uma sessão aberta com o MCP fora do ar segue sem ele até ser recriada;
   * sessões novas pegam a reconexão.
   */
  private buildTools(agent: IAgent, remote: BaseTool[], caller?: { context: IExecutionContext }): Array<BaseTool | BaseToolset> {
    return [...buildAdkTools(this.catalog?.localFor(agent.allowedTools) ?? [], () => caller?.context), ...remote]
  }

  /**
   * As tools do MCP, declaradas por nós em vez de pelo `MCPToolset` do ADK.
   *
   * ⚖️ O `MCPToolset` conecta ao MCP sozinho e repassa o JSON Schema como veio; a API do Gemini
   * recusa `$schema`, `additionalProperties` e `exclusiveMinimum` com HTTP 400, e o ADK entrega
   * isso ao chamador como `MALFORMED_FUNCTION_CALL` — apontando para o modelo em vez do schema.
   * Montando aqui, a declaração passa pela sanitização e a execução segue pelo `ToolCatalog`,
   * como em qualquer outro caminho.
   *
   * Sem MCP conectado devolve lista vazia: o agente fica só com as tools locais, sem quebrar.
   */
  private async remoteTools(agent: IAgent, caller: { context: IExecutionContext }): Promise<BaseTool[]> {
    if (!this.catalog) return []

    // ⛔ Só os servidores e as ferramentas que ESTE agente escolheu (ver `ToolCatalog.toolbox`).
    const toolbox = await this.catalog.toolbox(agent.allowedTools, caller.context)

    return buildAdkRemoteTools(
      toolbox.tools.filter((tool) => tool.origin === 'mcp'),
      // A credencial vem do provider e é lida NA EXECUÇÃO, do turno em curso — nunca a do 1º turno.
      (name, args) => toolbox.invoke(name, args, caller.context),
    )
  }

  /**
   * O consumo de UMA chamada ao modelo, contado uma vez só.
   *
   * ⚠️ NÃO SE LÊ O CONSUMO DOS EVENTOS:
   *  · cada pedaço do stream traz o consumo ACUMULADO da chamada, e quando o modelo pede duas
   *    ferramentas na mesma resposta o ADK emite um evento por pedido, cada um com o mesmo
   *    `promptTokenCount` — somar os eventos contava a entrada da chamada duas, três vezes;
   *  · o consumo definitivo, e o único com `cachedContentTokenCount`, vem no ÚLTIMO pedaço. Numa
   *    chamada que termina em ferramenta esse pedaço não tem conteúdo e o ADK não o vira evento —
   *    o cache dessas chamadas simplesmente não aparecia.
   *
   * O `afterModelCallback` recebe todos os pedaços, inclusive esse. O que fecha a chamada é o que
   * não é parcial e traz `finishReason`: um por chamada, com o número final.
   */
  private finalUsageOf(response: IAdkModelResponse): IUsage | undefined {
    if (response.partial === true || response.finishReason === undefined) return undefined

    return this.toUsage({ usageMetadata: response.usageMetadata })
  }

  /** Repassa ao stream o consumo das chamadas que já fecharam. */
  private *drainUsage(native: IGoogleAgentNative, sessionId: string): Generator<IAgentEvent> {
    for (const payload of native.usage.splice(0)) yield { type: 'usage', sessionId, timestamp: new Date(), payload }
  }

  /**
   * Traduz o `usageMetadata` do ADK. `undefined` quando não há consumo — emitir zero poluiria o
   * stream e o acumulado.
   */
  private toUsage(event: { usageMetadata?: IAdkUsageMetadata }): IUsage | undefined {
    const raw = event.usageMetadata
    if (!raw) return undefined

    const inputTokens = raw.promptTokenCount ?? 0
    const outputTokens = raw.candidatesTokenCount ?? 0
    // O raciocínio é cobrado como saída e não aparece em `candidatesTokenCount`. Ignorá-lo
    // subestimaria o custo justamente nos modelos que mais pensam.
    const reasoningTokens = raw.thoughtsTokenCount ?? 0

    if (!inputTokens && !outputTokens && !reasoningTokens) return undefined

    // Cache implícito: a parte lida vem em `cachedContentTokenCount`, já DENTRO de
    // `promptTokenCount`. Gravação de cache não existe nesse modo — não é cobrada à parte.
    // Um evento por resposta do modelo: a entrada dela é o contexto em uso.
    return {
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens: raw.cachedContentTokenCount ?? 0,
      cacheWriteTokens: 0,
      ...(inputTokens ? { contextTokens: inputTokens } : {}),
    }
  }

  private toAgentEvent(event: ReturnType<typeof toStructuredEvents>[number], sessionId: string): IAgentEvent | undefined {
    const timestamp = new Date()

    switch (event.type) {
      case EventType.CONTENT:
        return { type: 'text.delta', sessionId, timestamp, payload: { text: event.content } }
      case EventType.THOUGHT:
        return { type: 'reasoning.delta', sessionId, timestamp, payload: { text: event.content } }
      case EventType.TOOL_CALL:
        return {
          type: 'tool.started',
          sessionId,
          timestamp,
          payload: { tool: event.call.name ?? 'unknown', args: event.call.args ?? {} },
        }
      case EventType.TOOL_RESULT:
        return {
          type: 'tool.result',
          sessionId,
          timestamp,
          payload: { tool: event.result.name ?? 'unknown', result: event.result.response },
        }
      case EventType.ERROR:
        return { type: 'error', sessionId, timestamp, payload: { message: event.error.message } }
      default:
        return undefined
    }
  }

  private buildContent(input: IMessageInput): IAdkContent {
    // ⛔ Texto vazio NÃO entra como parte. O ADK descarta a mensagem inteira quando a primeira parte
    // é `text: ""` (`getContents`, @google/adk 1.6) — anexo enviado sem frase chegava ao modelo como
    // nada, e ele respondia "aguardando o arquivo" com o arquivo já enviado.
    const parts: IAdkPart[] = input.text.trim() ? [{ text: input.text }] : []
    for (const file of input.files ?? []) {
      parts.push({ inlineData: { data: file.data, mimeType: file.mimeType } })
    }
    return { role: 'user', parts }
  }

  /** O ADK exige um nome de agente em forma de identificador. */
  private toAdkName(agentId: string): string {
    return agentId.replace(/[^A-Za-z0-9_]/g, '_')
  }
}
