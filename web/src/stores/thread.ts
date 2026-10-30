import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, ApiError, openStream } from '@/lib/api'
import { readSse } from '@/lib/sse'
import type { IAgent, IAgentEvent, IConversation, ISessionState, ITodoItem, ITurn, IUsage, TMode } from '@/lib/types'
import { levelsOf, resolveChoice } from '@/lib/agentChoice'
import { useAgentsStore } from './agents'
import { useConversationsStore, type TTurnFrame } from './conversations'
import { useProjectsStore } from './projects'

export interface IDraft {
  agentId: string
  mode: TMode
  tools: boolean
  /** Um dos providers do agente; vai junto do modelo. */
  provider?: string
  model?: string
  reasoning?: string
  /** O repositório do projeto (`repositories/<nome>`) e a worktree dele em que o agente trabalha. */
  repository?: string
  worktree?: string
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

/** `ok: false` = a mensagem NÃO foi registrada (quem chamou devolve o texto à caixa). `created`: sessão que nasceu aqui. */
export interface ISendResult {
  ok: boolean
  created?: string
}

type TDraftAgent = Pick<IAgent, 'providers' | 'modes' | 'allowedTools' | 'reasoningEfforts'>

/**
 * Ajusta o rascunho ao agente COMO ESTÁ AGORA: a lista de agentes muda (modelo desativado, provider
 * que saiu, lane que saiu) e o rascunho guardava a escolha de antes. Provider + modelo ou lane que não
 * existem mais voltam ao padrão do agente; o nível de raciocínio que o modelo não aceita volta ao padrão.
 * `lanesOf` diz as lanes do provider escolhido (assinatura só roda a agent); ausente, todas.
 *
 * ⚖️ Pura e exportada: é a regra do rascunho, e testá-la não pode depender de tela.
 */
export function reconcileDraft(draft: IDraft, agent: TDraftAgent, lanesOf?: (providerId: string) => readonly TMode[] | undefined): IDraft {
  const choice = resolveChoice(agent, { provider: draft.provider, model: draft.model })
  const lanes = (choice && lanesOf?.(choice.provider)) ?? ['chat', 'agent']
  const modes = agent.modes.filter((mode) => lanes.includes(mode))
  const mode = modes.includes(draft.mode) ? draft.mode : (modes[0] ?? agent.modes[0] ?? 'chat')
  const tools = mode === 'chat' && draft.tools && agent.allowedTools.length > 0
  const levels = levelsOf(agent, choice)
  const reasoning = draft.reasoning && levels.includes(draft.reasoning) ? draft.reasoning : undefined
  return {
    agentId: draft.agentId,
    mode,
    tools,
    provider: choice?.provider,
    model: choice?.model,
    reasoning,
    ...(draft.repository ? { repository: draft.repository } : {}),
    ...(draft.repository && draft.worktree ? { worktree: draft.worktree } : {}),
  }
}

const isNotFound = (failure: unknown): boolean => failure instanceof ApiError && failure.status === 404
const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure))

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
  /** O agente da conversa, como a rota de turnos o diz — vale quando o cabeçalho não está na lista (outro projeto). */
  const agentId = ref<string>()
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
  /** Um turno que outro começou (a API, um agendamento, outra aba), acompanhado pelo `/live`: o botão parar vale para ele. */
  const following = ref(false)
  /** A lista de tarefas que o agente mantém na conversa (`update_todos`); vazia = nenhuma. */
  const todos = ref<ITodoItem[]>([])

  let inFlight: AbortController | undefined
  /** O turno de fora que a tela está montando (ver `onLive`), pelo stream da caixa de entrada. */
  let followed: IPendingTurn | undefined
  const inbox = useConversationsStore()
  inbox.onTurn(onLive)
  /**
   * ⚠️ Muda a cada troca de conversa (open, startDraft, reset). O `send` guarda o número com que
   * começou: se mudou, o stream é de OUTRA conversa e nada dele pode tocar o estado de agora.
   */
  let generation = 0
  /** Sessão que nasceu num envio que falhou depois: a próxima tentativa que der certo ainda tem de trocar a rota. */
  let unrouted: string | undefined

  /** Passa para outra conversa: derruba o stream em andamento e invalida o que ele ainda entregar. */
  function leave(): number {
    inFlight?.abort()
    inFlight = undefined
    inbox.follow(undefined)
    followed = undefined
    following.value = false
    sending.value = false
    unrouted = undefined
    return ++generation
  }

  async function open(id: string, known?: IConversation): Promise<void> {
    const current = leave()
    sessionId.value = id
    header.value = known
    agentId.value = undefined
    draft.value = undefined
    pending.value = undefined
    turns.value = []
    todos.value = []
    liveSession.value = undefined
    session.value = undefined
    error.value = undefined
    loading.value = true

    try {
      let unsure = false
      let historyFailure: string | undefined
      void loadTodos(id, current)
      const [history, live] = await Promise.all([
        api<{ agentId?: string; turns: ITurn[] }>(`/conversations/${encodeURIComponent(id)}/turns`).catch((failure) => {
          if (!isNotFound(failure)) historyFailure = messageOf(failure)
          return { turns: [] as ITurn[] }
        }),
        api<ISessionState>(`/sessions/${encodeURIComponent(id)}`).catch((failure) => {
          // ⚠️ Só o 404 diz "a sessão não existe". Rede ou 5xx não provam nada: marcar "não ativa" trancaria a conversa por um tropeço.
          if (!isNotFound(failure)) unsure = true
          return undefined
        }),
      ])
      if (current !== generation) return
      turns.value = history.turns
      agentId.value = 'agentId' in history ? history.agentId : undefined
      liveSession.value = !!live || unsure
      session.value = live ? { provider: live.provider, model: live.model, reasoning: live.reasoning, place: live.place } : undefined
      // Depois do histórico: o turno em curso (`turn.started`) entra depois dos já gravados. Também na conversa
      // encerrada: a API a retoma ao mandar um turno, e ele aparece aqui.
      inbox.follow(id)
      if (historyFailure) error.value = `Não foi possível carregar o histórico: ${historyFailure}`
      else if (unsure) error.value = 'Não foi possível confirmar se a sessão está ativa. Tente de novo em instantes.'
    } catch (failure) {
      if (current === generation) error.value = messageOf(failure)
    } finally {
      if (current === generation) loading.value = false
    }
  }

  /** Conversa nova: ainda sem sessão. A sessão nasce na primeira mensagem. */
  function startDraft(next: IDraft): void {
    leave()
    sessionId.value = undefined
    header.value = undefined
    turns.value = []
    todos.value = []
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

  /**
   * Manda a mensagem. Devolve `ok` (a mensagem ficou registrada?) e o id da sessão quando ela nasce
   * aqui — quem chamou troca a rota para ela.
   *
   * ⚠️ Um turno SEM resposta não fica no histórico como enviado: o texto volta para quem digitou
   * (`ok: false`) e o erro aparece. Só a parada pedida pelo usuário mantém o turno, marcado como interrompido.
   */
  async function send(text: string, files: IOutgoingFile[]): Promise<ISendResult> {
    if (sending.value) return { ok: false }
    const mine = generation
    const stale = () => mine !== generation
    sending.value = true
    error.value = undefined
    let ok = false
    const controller = new AbortController()
    inFlight = controller
    let turn: IPendingTurn | undefined

    try {
      if (!sessionId.value) {
        if (!draft.value) throw new Error('Escolha um agente para começar.')
        const { agentId, mode, tools, provider, model, reasoning, repository, worktree } = draft.value
        const born = (
          await api<{ id: string }>('/sessions', {
            method: 'POST',
            // O projeto atual: num agente global (o Atlas), é nele que a conversa nasce.
            body: { agentId, mode, tools: mode === 'chat' && tools, provider, model, reasoning, projectId: useProjectsStore().current, repository, worktree },
            signal: controller.signal,
          })
        ).id
        if (stale()) return { ok: false }
        sessionId.value = unrouted = born
        liveSession.value = true
        inbox.follow(born)
        if (model) session.value = { provider, model, reasoning }
      }

      const id = sessionId.value
      turn = { request: text, files: files.length, text: '', reasoning: '', tools: [], warnings: [], aborted: false }
      pending.value = turn

      const body = await openStream(`/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { message: text, files }, signal: controller.signal })
      for await (const frame of readSse(body)) {
        if (stale()) return { ok: false }
        applyEvent(turn, frame.data as IAgentEvent)
      }
      if (stale()) return { ok: false }

      pending.value = undefined
      if (turn.error && !turn.text && !turn.tools.length && !turn.aborted) {
        // O stream terminou em erro sem nenhuma resposta: não é um turno, é uma falha.
        error.value = turn.error
        return { ok: false }
      }
      turns.value = [...turns.value, settled(id, turn, turns.value.length, session.value)]
      // A sessão que estava encerrada foi RETOMADA pelo gateway ao receber a mensagem: volta a contar como viva.
      if (liveSession.value === false) {
        liveSession.value = true
        void reloadSession(id)
      }
      // O primeiro turno de uma conversa nova grava a conversa só no fim: as tarefas dele se leem depois disso.
      const usedTodos = turn.tools.some((tool) => isTodoTool(tool.tool))
      setTimeout(() => void refresh().then(() => (usedTodos ? loadTodos(id) : undefined)), 600)
      ok = true
    } catch (failure) {
      // A conversa mudou no meio: o erro (inclusive o AbortError do `open`) é do stream antigo, não desta tela.
      if (stale()) return { ok: false }
      const aborted = failure instanceof DOMException && failure.name === 'AbortError'

      if (aborted && turn) {
        turns.value = [...turns.value, settled(sessionId.value ?? '', { ...(pending.value ?? turn), aborted: true }, turns.value.length, session.value)]
        ok = true
      } else if (!aborted) {
        const partial = pending.value ?? turn
        pending.value = undefined
        if (partial?.text) {
          // Já chegou resposta: o turno existe, mesmo interrompido pela falha.
          turns.value = [...turns.value, settled(sessionId.value ?? '', partial, turns.value.length, session.value)]
          ok = true
        }
        error.value = describe(failure)
      }
      pending.value = undefined
    } finally {
      if (!stale()) {
        if (inFlight === controller) inFlight = undefined
        sending.value = false
      }
    }

    // ⚠️ Falhou: não troca a rota (a caixa de texto some junto com a tela); a sessão fica para a próxima tentativa.
    if (!ok) return { ok }
    const created = unrouted
    unrouted = undefined
    return { ok, created }
  }

  /** O turno que outro começou (a API, um agendamento, outra aba). O desta aba chega pelo próprio stream. */
  function onLive(frame: TTurnFrame): void {
    if (sending.value || frame.sessionId !== sessionId.value) return
    if (frame.type === 'turn.started') {
      const turn: IPendingTurn = { request: frame.turn.request, files: 0, text: '', reasoning: '', tools: [], warnings: [], aborted: false }
      followed = turn
      following.value = true
      if (liveSession.value === false) {
        liveSession.value = true
        void reloadSession(frame.sessionId)
      }
      for (const event of frame.turn.events) applyEvent(turn, event)
      pending.value = { ...turn, tools: [...turn.tools] }
    } else if (frame.type === 'turn.event' && followed) {
      applyEvent(followed, frame.event)
    } else if ((frame.type === 'turn.finished' || frame.type === 'turn.idle') && followed) {
      followed = undefined
      following.value = false
      // O turno já está gravado: a releitura o traz, e só então o pendente sai (sem piscar).
      void refresh().finally(() => {
        if (!following.value && !sending.value) pending.value = undefined
        void loadTodos()
      })
    }
  }

  /** O provider e o modelo da sessão (retomada agora), para o cabeçalho e o seletor de modelo. */
  async function reloadSession(id: string): Promise<void> {
    const live = await api<ISessionState>(`/sessions/${encodeURIComponent(id)}`).catch(() => undefined)
    if (live && sessionId.value === id) session.value = { provider: live.provider, model: live.model, reasoning: live.reasoning, place: live.place }
  }

  /** O texto do erro de envio — e o que ele implica: 404 = sessão encerrada; 409 `model_disabled` = relê os agentes. */
  function describe(failure: unknown): string {
    if (failure instanceof ApiError && failure.status === 404 && sessionId.value) {
      liveSession.value = false
      return 'Falha ao enviar: esta conversa não existe mais no gateway. Comece uma nova conversa.'
    }
    if (failure instanceof ApiError && failure.status === 409 && failure.code === 'not_resumable')
      return 'Esta conversa não pode ser retomada: é de um subagente, que só abre por delegação.'
    if (failure instanceof ApiError && failure.status === 409 && failure.code === 'model_disabled') {
      // O modelo saiu do ar: a lista de agentes de agora diz quais ainda servem (e o rascunho se ajusta a ela).
      void useAgentsStore()
        .load()
        .catch(() => undefined)
      return failure.message
    }
    return messageOf(failure)
  }

  /**
   * Troca o provider, o modelo e/ou o raciocínio da sessão viva — vale a partir da próxima mensagem.
   * Outro provider recebe a transcrição dos turnos (o servidor a monta). `reasoning: null` volta ao padrão
   * do provider. Lança o erro da API (ex.: 409 com um turno em andamento).
   */
  async function reconfigure(change: { provider?: string; model?: string; reasoning?: string | null }): Promise<void> {
    const id = sessionId.value
    if (!id || sending.value) return
    const updated = await api<ISessionState>(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: change })
    if (id === sessionId.value) session.value = { provider: updated.provider, model: updated.model, reasoning: updated.reasoning }
  }

  /** Logout: esquece tudo da conversa aberta e derruba o stream, para a próxima conta não herdar nada. */
  function reset(): void {
    leave()
    sessionId.value = undefined
    header.value = undefined
    turns.value = []
    todos.value = []
    loading.value = false
    error.value = undefined
    liveSession.value = undefined
    session.value = undefined
    draft.value = undefined
    pending.value = undefined
  }

  async function stop(): Promise<void> {
    const id = sessionId.value
    inFlight?.abort()
    if (id) await api(`/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).catch(() => undefined)
  }

  /** Relê as tarefas da conversa. `expected`: a geração em que foi pedida — de outra conversa, a resposta não vale. */
  async function loadTodos(id = sessionId.value, expected = generation): Promise<void> {
    if (!id) return
    const result = await api<{ items: ITodoItem[] }>(`/conversations/${encodeURIComponent(id)}/todos`).catch(() => undefined)
    if (result && expected === generation && sessionId.value === id) todos.value = result.items
  }

  /** A ferramenta das tarefas, com ou sem o prefixo do servidor MCP local (`mcp__local__update_todos`). */
  const isTodoTool = (name: unknown) => typeof name === 'string' && (name === 'update_todos' || name.endsWith('__update_todos'))

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
        if (event.type === 'tool.result' && isTodoTool(payload.tool)) void loadTodos()
        break
      }
      case 'usage': {
        // O contexto em uso fica até outra chamada informar um novo: o ClaudeChat manda a entrada e a saída
        // em dois eventos, e o segundo não o traz.
        const usage = payload as IUsage
        turn.usage = { ...usage, ...((usage.contextTokens ?? turn.usage?.contextTokens) !== undefined ? { contextTokens: usage.contextTokens ?? turn.usage?.contextTokens } : {}) }
        break
      }
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

  return {
    sessionId,
    header,
    agentId,
    turns,
    todos,
    loading,
    error,
    liveSession,
    session,
    draft,
    pending,
    sending,
    following,
    open,
    startDraft,
    setHeader,
    refresh,
    send,
    reconfigure,
    stop,
    reset,
  }
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
    provider: state?.provider,
    effort: state?.reasoning,
    toolCalls: turn.tools.map((tool) => ({ tool: tool.tool, error: tool.status === 'error' ? tool.message : undefined })),
    usage: turn.usage,
    warnings: turn.warnings.length ? turn.warnings : undefined,
    aborted: turn.aborted || undefined,
    error: turn.error,
  }
}
