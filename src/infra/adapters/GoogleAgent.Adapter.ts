import { randomUUID } from 'node:crypto'
import { EventType, InMemorySessionService, LlmAgent, Runner, StreamingMode, toStructuredEvents, type BaseTool, type BaseToolset, type Event } from '@google/adk'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
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

const DEFAULT_MODEL = 'gemini-3.7-flash'
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

export interface IAdkRuntimeSpec {
  name: string
  model: string
  instruction: string
  tools: Array<BaseTool | BaseToolset>
}

export type TAdkRuntimeFactory = (spec: IAdkRuntimeSpec) => IAdkRuntime

/** O runtime do ADK vive por sessão: é ele que carrega o histórico entre turnos. */
interface IGoogleAgentNative {
  runtime: IAdkRuntime
  userId: string
  adkSessionId: string
}

export interface IGoogleAgentAdapterDeps {
  createRuntime?: TAdkRuntimeFactory
  store?: SessionStore
  catalog?: ToolCatalog
}

function defaultRuntimeFactory(spec: IAdkRuntimeSpec): IAdkRuntime {
  const sessionService = new InMemorySessionService()
  const agent = new LlmAgent({
    name: spec.name,
    model: spec.model,
    // O ADK 1.6 usa `instruction` (singular) e `model`; não existem `instructions` nem `llm`.
    instruction: spec.instruction,
    tools: spec.tools,
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

  constructor(deps: IGoogleAgentAdapterDeps = {}) {
    this.createRuntime = deps.createRuntime ?? defaultRuntimeFactory
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.GOOGLE, EMode.AGENT), {
      agentId: agent.id,
      provider: EProvider.GOOGLE,
      mode: EMode.AGENT,
      model: input.model || DEFAULT_MODEL,
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

  async *sendMessage(agent: IAgent, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
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
      const native = this.nativeOf(record, agent, await this.remoteTools(agent))
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

      for await (const event of stream) {
        const isPartial = event.partial === true

        for (const structured of toStructuredEvents(event)) {
          const carriesText = structured.type === EventType.CONTENT || structured.type === EventType.THOUGHT
          if (carriesText && !isPartial && sawPartialText) continue

          const mapped = this.toAgentEvent(structured, sessionId)
          if (mapped) yield mapped
        }

        /**
         * O uso vem NO EVENTO, e um turno agêntico produz vários.
         *
         * ⚠️ O `Event` do ADK estende `LlmResponse`, e é ali que mora o `usageMetadata` — o adapter
         * simplesmente não o lia, e o resultado era turno registrado com `usage` zerado: nenhuma
         * visibilidade de custo, e nenhum erro para denunciar.
         *
         * ⚠️ CADA CHAMADA AO MODELO TRAZ O SEU. Uma pergunta que usa três ferramentas passa quatro
         * vezes pelo modelo, e o consumo do turno é a SOMA — não o do último evento, que é o erro
         * fácil de cometer aqui e faria o custo parecer uma fração do que foi.
         *
         * Eventos parciais repetem o acumulado do mesmo passo; contá-los somaria o mesmo consumo
         * várias vezes.
         */
        const usage = !isPartial ? this.toUsage(event) : undefined
        if (usage) yield { type: 'usage', sessionId, timestamp: new Date(), payload: usage }

        if (isPartial) sawPartialText = true
        else sawPartialText = false
      }

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
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message } }
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
  private nativeOf(record: ISessionRecord, agent: IAgent, remote: BaseTool[]): IGoogleAgentNative {
    if (!record.native) {
      record.native = {
        runtime: this.createRuntime({
          name: this.toAdkName(agent.id),
          model: record.model,
          instruction: assertNoAdkTemplateCollision(record.systemPrompt),
          tools: this.buildTools(agent, remote),
        }),
        userId: `gateway-${record.id}`,
        adkSessionId: randomUUID(),
      } satisfies IGoogleAgentNative
    }
    return record.native as IGoogleAgentNative
  }

  /**
   * O runtime do ADK é criado uma vez por sessão e carrega o histórico, então o toolset é
   * decidido ali. Uma sessão aberta com o MCP fora do ar segue sem ele até ser recriada;
   * sessões novas pegam a reconexão.
   */
  private buildTools(agent: IAgent, remote: BaseTool[]): Array<BaseTool | BaseToolset> {
    return [...buildAdkTools(this.catalog?.localFor(agent.allowedTools) ?? []), ...remote]
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
  private async remoteTools(agent: IAgent): Promise<BaseTool[]> {
    if (!this.catalog) return []

    const local = new Set(this.catalog.localFor(agent.allowedTools).map((tool) => tool.name))
    const all = await this.catalog.list(agent.allowedTools)

    return buildAdkRemoteTools(
      all.filter((tool) => !local.has(tool.name)),
      (name, args) => this.catalog!.invoke(name, args),
    )
  }

  /**
   * Traduz o `usageMetadata` do ADK. `undefined` quando o evento não carrega consumo — a maioria
   * não carrega, e emitir zero poluiria o stream e o acumulado.
   */
  private toUsage(event: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } }): IUsage | undefined {
    const raw = event.usageMetadata
    if (!raw) return undefined

    const inputTokens = raw.promptTokenCount ?? 0
    const outputTokens = raw.candidatesTokenCount ?? 0
    // O raciocínio é cobrado como saída e não aparece em `candidatesTokenCount`. Ignorá-lo
    // subestimaria o custo justamente nos modelos que mais pensam.
    const reasoningTokens = raw.thoughtsTokenCount ?? 0

    if (!inputTokens && !outputTokens && !reasoningTokens) return undefined

    return { inputTokens, outputTokens, reasoningTokens }
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
    const parts: IAdkPart[] = [{ text: input.text }]
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
