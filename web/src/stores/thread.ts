import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, openStream } from '@/lib/api'
import { readSse } from '@/lib/sse'
import type { IAgentEvent, IConversation, ISessionState, ITurn, IUsage, TMode } from '@/lib/types'

export interface IDraft {
  agentId: string
  mode: TMode
  tools: boolean
  model?: string
  reasoning?: string
}

export interface IPendingTool {
  tool: string
  status: 'running' | 'done' | 'error'
  message?: string
}

/** O turno que está acontecendo agora, montado a partir do stream. */
export interface IPendingTurn {
  request: string
  files: number
  text: string
  reasoning: string
  tools: IPendingTool[]
  usage?: IUsage
  warnings: string[]
  aborted: boolean
  error?: string
}

export interface IOutgoingFile {
  name: string
  mimeType: string
  data: string
}

/**
 * A conversa aberta: o histórico gravado, a sessão viva (se houver) e o turno em andamento.
 *
 * ⚖️ CONVERSA GRAVADA E SESSÃO VIVA SÃO COISAS DISTINTAS no gateway, com o MESMO id. O histórico
 * sobrevive ao restart; a sessão não. Sem sessão viva a conversa abre só para leitura — o provider
 * já esqueceu o contexto, e mandar mensagem "nela" seria conversar com um estado que não existe.
 */
export const useThreadStore = defineStore('thread', () => {
  const sessionId = ref<string>()
  const header = ref<IConversation>()
  const turns = ref<ITurn[]>([])
  const loading = ref(false)
  const error = ref<string>()
  /** `undefined` enquanto pergunta ao gateway. */
  const liveSession = ref<boolean>()
  /** O modelo e o raciocínio em vigor na sessão viva (ver `reconfigure`). */
  const session = ref<ISessionState>()
  const draft = ref<IDraft>()
  const pending = ref<IPendingTurn>()
  const sending = ref(false)

  let inFlight: AbortController | undefined
  let generation = 0

  async function open(id: string, known?: IConversation): Promise<void> {
    const current = ++generation
    sessionId.value = id
    header.value = known
    draft.value = undefined
    pending.value = undefined
    turns.value = []
    liveSession.value = undefined
    session.value = undefined
    error.value = undefined
    loading.value = true

    try {
      const [history, live] = await Promise.all([
        api<{ turns: ITurn[] }>(`/conversations/${encodeURIComponent(id)}/turns`).catch(() => ({ turns: [] as ITurn[] })),
        api<ISessionState>(`/sessions/${encodeURIComponent(id)}`).catch(() => undefined),
      ])
      if (current !== generation) return
      turns.value = history.turns
      liveSession.value = !!live
      session.value = live ? { model: live.model, reasoning: live.reasoning } : undefined
    } catch (failure) {
      if (current === generation) error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      if (current === generation) loading.value = false
    }
  }

  /** Conversa nova: ainda sem sessão. A sessão nasce na primeira mensagem. */
  function startDraft(next: IDraft): void {
    generation++
    sessionId.value = undefined
    header.value = undefined
    turns.value = []
    pending.value = undefined
    error.value = undefined
    liveSession.value = true
    session.value = undefined
    draft.value = next
  }

  function setHeader(conversation: IConversation | undefined): void {
    if (conversation && conversation.id === sessionId.value) header.value = conversation
  }

  /** Relê o histórico gravado — o turno chega ao banco um instante depois do fim do stream. */
  async function refresh(): Promise<void> {
    const id = sessionId.value
    if (!id) return
    const history = await api<{ turns: ITurn[] }>(`/conversations/${encodeURIComponent(id)}/turns`).catch(() => undefined)
    if (history && id === sessionId.value && history.turns.length >= turns.value.length) turns.value = history.turns
  }

  /** Devolve o id da sessão quando ela nasce aqui — quem chamou troca a rota para ela. */
  async function send(text: string, files: IOutgoingFile[]): Promise<string | undefined> {
    if (sending.value) return undefined
    sending.value = true
    error.value = undefined
    let created: string | undefined

    try {
      if (!sessionId.value) {
        if (!draft.value) throw new Error('Escolha um agente para começar.')
        const { agentId, mode, tools, model, reasoning } = draft.value
        sessionId.value = created = (await api<{ id: string }>('/sessions', { method: 'POST', body: { agentId, mode, tools: mode === 'chat' && tools, model, reasoning } })).id
        liveSession.value = true
        if (model) session.value = { model, reasoning }
      }

      const id = sessionId.value
      const turn: IPendingTurn = { request: text, files: files.length, text: '', reasoning: '', tools: [], warnings: [], aborted: false }
      pending.value = turn
      inFlight = new AbortController()

      const body = await openStream(`/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { message: text, files }, signal: inFlight.signal })
      for await (const frame of readSse(body)) applyEvent(turn, frame.data as IAgentEvent)

      turns.value = [...turns.value, settled(id, turn, turns.value.length, session.value)]
      pending.value = undefined
      setTimeout(() => void refresh(), 600)
    } catch (failure) {
      const aborted = failure instanceof DOMException && failure.name === 'AbortError'
      if (pending.value) {
        turns.value = [...turns.value, settled(sessionId.value ?? '', { ...pending.value, aborted: aborted || pending.value.aborted }, turns.value.length, session.value)]
        pending.value = undefined
      }
      if (!aborted) error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      inFlight = undefined
      sending.value = false
    }

    return created
  }

  /**
   * Troca o modelo e/ou o raciocínio da sessão viva — vale a partir da próxima mensagem. `reasoning: null`
   * volta ao padrão do provider. Lança o erro da API (ex.: 409 com um turno em andamento).
   */
  async function reconfigure(change: { model?: string; reasoning?: string | null }): Promise<void> {
    const id = sessionId.value
    if (!id || sending.value) return
    const updated = await api<ISessionState>(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: change })
    if (id === sessionId.value) session.value = { model: updated.model, reasoning: updated.reasoning }
  }

  async function stop(): Promise<void> {
    const id = sessionId.value
    inFlight?.abort()
    if (id) await api(`/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).catch(() => undefined)
  }

  function applyEvent(turn: IPendingTurn, event: IAgentEvent): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    switch (event.type) {
      case 'text.delta':
        turn.text += String(payload.text ?? '')
        break
      case 'reasoning.delta':
        turn.reasoning += String(payload.text ?? '')
        break
      case 'tool.started':
        turn.tools.push({ tool: String(payload.tool), status: 'running' })
        break
      case 'tool.result':
      case 'tool.error': {
        const running = [...turn.tools].reverse().find((tool) => tool.tool === payload.tool && tool.status === 'running')
        if (running) {
          running.status = event.type === 'tool.result' ? 'done' : 'error'
          running.message = event.type === 'tool.error' ? String(payload.message ?? '') : undefined
        }
        break
      }
      case 'usage':
        turn.usage = payload as IUsage
        break
      case 'warning':
        turn.warnings.push(String(payload.message ?? ''))
        break
      case 'message.aborted':
        turn.aborted = true
        break
      case 'error':
        turn.error = String(payload.message ?? 'erro')
        break
    }
    // Força o Vue a ver a mudança no objeto aninhado.
    pending.value = { ...turn, tools: [...turn.tools] }
  }

  return { sessionId, header, turns, loading, error, liveSession, session, draft, pending, sending, open, startDraft, setHeader, refresh, send, reconfigure, stop }
})

/** O turno do stream no formato do gravado, até a releitura trazer o de verdade. */
function settled(sessionId: string, turn: IPendingTurn, index: number, state?: ISessionState): ITurn {
  return {
    sessionId,
    index,
    at: new Date().toISOString(),
    request: turn.request,
    text: turn.text,
    reasoning: turn.reasoning || undefined,
    model: state?.model,
    effort: state?.reasoning,
    toolCalls: turn.tools.map((tool) => ({ tool: tool.tool, error: tool.status === 'error' ? tool.message : undefined })),
    usage: turn.usage,
    warnings: turn.warnings.length ? turn.warnings : undefined,
    aborted: turn.aborted || undefined,
    error: turn.error,
  }
}
