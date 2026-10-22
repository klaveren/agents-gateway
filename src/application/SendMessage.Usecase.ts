import { IAgentEvent, IUsage } from '@domain/models/AgentEvent.Model'
import { IStoredUsage } from '@domain/models/Conversation.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { aggregateTurn } from './Turn.Aggregator'

const TITLE_MAX = 60

/**
 * Normaliza o consumo para o formato gravado: os campos, mais o total.
 *
 * O total NÃO soma o cache: ele já está dentro de `inputTokens` (ver `IStoredUsage`).
 */
function usageOf(usage?: IUsage): IStoredUsage {
  const inputTokens = usage?.inputTokens ?? 0
  const outputTokens = usage?.outputTokens ?? 0
  const reasoningTokens = usage?.reasoningTokens ?? 0

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
  }
}

/** Bytes do arquivo a partir do base64, sem decodificar o conteúdo. */
function base64Size(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0

  return Math.max(Math.floor((data.length * 3) / 4) - padding, 0)
}

/**
 * Descritivo dos anexos, para o registro.
 *
 * ⛔ SEM o `data`: o turno gravado é lido por quem monitora, e o conteúdo de um arquivo não precisa
 * morar no banco para provar que ele chegou. Nome, tipo e tamanho bastam — e é o que responde, depois,
 * "a imagem chegou ao agente?".
 */
function filesOf(input: IMessageInput): Array<{ name: string; mimeType: string; size: number }> | undefined {
  if (!input.files?.length) return undefined

  return input.files.map((file) => ({ name: file.name, mimeType: file.mimeType, size: base64Size(file.data ?? '') }))
}

/** Tempo do turno, medido pelos próprios eventos: até o último, e até o primeiro texto. */
function timingOf(startedAt: number, events: IAgentEvent[]): { durationMs?: number; firstTextMs?: number } {
  const last = events[events.length - 1]?.timestamp
  const firstText = events.find((event) => event.type === 'text.delta')?.timestamp

  return {
    durationMs: last ? Math.max(last.getTime() - startedAt, 0) : undefined,
    firstTextMs: firstText ? Math.max(firstText.getTime() - startedAt, 0) : undefined,
  }
}

/** Primeira linha da pergunta, cortada. Vazio vira `undefined` para não gravar título em branco. */
function titleFrom(text?: string): string | undefined {
  const first = (text ?? '').trim().split('\n')[0]?.trim()
  if (!first) return undefined

  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first
}

export class SendMessageUseCase {
  constructor(
    private agentProvider: IAgentProvider,
    private conversations: IConversationRepository,
  ) {}

  /**
   * Repassa os eventos e, ao final, registra o turno.
   *
   * ⚖️ O REGISTRO MORA AQUI, e não no controller, porque é aqui que os dois caminhos de entrega se
   * encontram. O controller agrega o turno só na resposta JSON; a lane SSE não passa por
   * `aggregateTurn` nenhuma. Registrar lá gravaria exatamente as conversas que ninguém tem, e
   * perderia as de verdade.
   *
   * ⚠️ O `finally` é o ponto: cliente que fecha a aba encerra o gerador por fora (o `return()` do
   * iterador), e sem ele o turno interrompido não seria gravado — justamente o que alguém vai
   * querer investigar depois.
   */
  async *execute(sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    const events: IAgentEvent[] = []
    const startedAt = Date.now()

    // `input` sem o contexto é o que se REGISTRA; `sent` é o que vai ao modelo. Decidido antes do
    // primeiro evento: o provider soma o turno ao começar, e depois disso a sessão já não tem zero.
    const recorded: IMessageInput = { ...input }
    delete recorded.context
    const sent = this.withContext(sessionId, input)

    try {
      for await (const event of this.agentProvider.sendMessage(sessionId, sent)) {
        events.push(event)
        yield event
      }
    } finally {
      // `void`: gravação não segura a resposta de quem está lendo o stream, e o repositório já
      // engole o próprio erro — banco fora do ar não pode derrubar a conversa.
      void this.record(sessionId, recorded, events, startedAt)
    }
  }

  /**
   * O contexto do sistema vai na PRIMEIRA mensagem só: dali em diante ele já está no histórico do
   * modelo, e repeti-lo pagaria os mesmos tokens a cada turno para dizer a mesma coisa.
   *
   * ⚠️ Sessão que não se consegue descrever (saiu do store) conta como "já tem turno": na dúvida não
   * se injeta nada — o provider vai recusar a sessão de qualquer forma.
   */
  private withContext(sessionId: string, input: IMessageInput): IMessageInput {
    const { context, ...rest } = input
    if (!context) return rest

    const session = this.describeQuietly(sessionId)
    if (!session || session.turns > 0) return rest

    return { ...rest, text: rest.text.trim() ? `${context}\n\n${rest.text}` : context }
  }

  private async record(sessionId: string, input: IMessageInput, events: IAgentEvent[], startedAt: number): Promise<void> {
    if (!events.length) return

    const turn = aggregateTurn(sessionId, events)
    const session = this.describeQuietly(sessionId)

    /**
     * O índice vem do contador do PROVIDER, não de um `listTurns` no banco.
     *
     * Contar no banco custaria uma leitura por turno e, com o repositório nulo, sempre devolveria
     * zero — todo turno sobrescreveria o primeiro, e o histórico teria uma linha só. O provider
     * incrementa `turns` ao aceitar o turno, então o índice deste é o anterior.
     */
    const index = Math.max((session?.turns ?? 1) - 1, 0)

    // Cabeçalho gravado a cada turno: é o que mantém `updatedAt` e o acumulado em dia, e cria a
    // conversa no banco mesmo quando ela nasceu antes de o banco estar de pé.
    if (session) {
      await this.conversations.saveSession({
        id: session.id,
        agentId: session.agentId,
        provider: String(session.provider),
        mode: String(session.mode),
        model: session.model,
        /**
         * Título só no PRIMEIRO turno — depois `saveSession` o omite e o banco o preserva.
         *
         * Sai da pergunta que abriu a conversa porque é o que a pessoa reconhece numa lista. Deixá-lo
         * `undefined` obrigaria quem lista a abrir o primeiro turno de cada conversa só para ter um
         * rótulo — uma leitura por linha da lista.
         */
        title: index === 0 ? titleFrom(input.text) : undefined,
        createdAt: session.createdAt,
        updatedAt: new Date(),
        turns: session.turns,
        // Zero em vez de ausente: campo que chega `undefined` vira `null` no banco, e `null` em
        // contador é o que quebra qualquer conta feita em cima dele depois.
        usage: usageOf(session.usage),
        metadata: session.metadata,
      })
    }

    await this.conversations.appendTurn({
      sessionId,
      index,
      at: new Date(),
      request: input.text ?? '',
      files: filesOf(input),
      text: turn.text,
      reasoning: turn.reasoning || undefined,
      toolCalls: turn.toolCalls,
      usage: usageOf(turn.usage),
      ...timingOf(startedAt, events),
      warnings: turn.warnings?.length ? turn.warnings : undefined,
      aborted: turn.aborted || undefined,
      error: turn.error,
    })
  }

  /**
   * O cabeçalho da sessão, ou nada.
   *
   * ⚠️ Silencioso de propósito: `describe` lança quando a sessão já saiu do store (foi cancelada,
   * ou o processo a perdeu). O turno ainda merece ser gravado — sem cabeçalho, mas gravado.
   */
  private describeQuietly(sessionId: string) {
    try {
      return this.agentProvider.describe(sessionId)
    } catch {
      return undefined
    }
  }
}
