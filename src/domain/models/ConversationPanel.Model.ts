/**
 * ⚖️ O PAINEL DA CONVERSA: o documento vivo que o agente mantém enquanto conversa — o objetivo, o que está em andamento,
 * a fila, o que foi entregue (com os links), as decisões e as perguntas para a pessoa. Resolve a conversa longa que se
 * desvia: o agente vê a rota no começo de cada turno (`panelTurnNote`) e o documento sobrevive à compactação.
 *
 * ⚖️ DADOS, não HTML: o agente grava pela ferramenta (`conversation_panel`), e a tela monta a página. O visual é sempre o
 * mesmo, nada que o agente escreva vira código, e o próprio agente lê o documento de volta para se orientar.
 *
 * ⚖️ Diferente da lista de tarefas (`update_todos`), que são os passos do trabalho de agora: o painel é a conversa inteira.
 */
export type TPanelItemStatus = 'queued' | 'doing' | 'blocked' | 'done' | 'dropped'
export const PANEL_ITEM_STATUSES: readonly TPanelItemStatus[] = ['queued', 'doing', 'blocked', 'done', 'dropped']

export interface IPanelLink {
  label: string
  /** Um endereço (`https://…`), o caminho de um arquivo ou o id de uma conversa (`gw_…`). */
  href?: string
}

/** Um pedido da pessoa: o que ela quer, em que pé está e o que foi entregue. */
export interface IPanelItem {
  id: string
  title: string
  detail?: string
  status: TPanelItemStatus
  /** O motivo do bloqueio ou do descarte, ou o resumo da entrega. */
  note?: string
  links?: IPanelLink[]
  /** Com outro agente (a delegação): quem e em que conversa. */
  delegatedTo?: { agentId: string; sessionId?: string }
  /** O turno em que foi pedido e o em que ficou pronto (ou descartado). */
  askedTurn?: number
  doneTurn?: number
}

export interface IPanelDecision {
  id: string
  text: string
  why?: string
  /** Quem decidiu: a pessoa ou o agente. */
  by?: string
  turn?: number
}

export interface IPanelQuestion {
  id: string
  text: string
  answer?: string
  /** Quem respondeu. A resposta da PESSOA (no painel) vai ao agente no turno seguinte, uma vez (`delivered`). */
  answeredBy?: 'person' | 'agent'
  /** `false`: a pessoa respondeu no painel e o agente ainda não viu. */
  delivered?: boolean
  turn?: number
}

/** Uma mudança do painel, para a linha do tempo. */
export interface IPanelEvent {
  at: string
  turn?: number
  by: string
  text: string
}

export interface IConversationPanel {
  goal?: string
  items: IPanelItem[]
  decisions: IPanelDecision[]
  questions: IPanelQuestion[]
  history: IPanelEvent[]
  updatedAt?: string
}

export const PANEL_TOOL = 'conversation_panel'
export const PANEL_LIMITS = { items: 100, decisions: 60, questions: 40, history: 300, text: 300, detail: 2000, links: 10 } as const

export const emptyPanel = (): IConversationPanel => ({ items: [], decisions: [], questions: [], history: [] })

/** Uma operação no painel (da ferramenta do agente ou da tela). */
export type TPanelOp =
  | { op: 'set_goal'; goal: string }
  | { op: 'add'; title: string; detail?: string; status?: TPanelItemStatus; delegatedTo?: { agentId: string; sessionId?: string } }
  | {
      op: 'update'
      id: string
      title?: string
      detail?: string
      status?: TPanelItemStatus
      note?: string
      links?: IPanelLink[]
      delegatedTo?: { agentId: string; sessionId?: string } | null
    }
  | { op: 'move'; id: string; before?: string }
  | { op: 'decide'; text: string; why?: string }
  | { op: 'ask'; text: string }
  | { op: 'answer'; id: string; answer: string }

const STATUS_LABEL: Record<TPanelItemStatus, string> = { queued: 'na fila', doing: 'em andamento', blocked: 'bloqueado', done: 'entregue', dropped: 'descartado' }

const clip = (text: string, max: number) => text.trim().slice(0, max)

/** O próximo id do tipo (`p3`, `d2`, `q1`): curto, para o agente citar. */
function nextId(prefix: string, taken: readonly { id: string }[]): string {
  const numbers = taken.map((item) => Number(item.id.slice(prefix.length))).filter((value) => Number.isFinite(value))
  return `${prefix}${(numbers.length ? Math.max(...numbers) : 0) + 1}`
}

/**
 * Aplica a operação e devolve o painel novo e o que mudou (para a resposta da ferramenta). Lança com o motivo quando a
 * operação não serve (id que não existe, texto vazio, teto). Pura: `turn`, `by` e `now` vêm de fora.
 */
export function applyPanelOp(
  current: IConversationPanel,
  op: TPanelOp,
  context: { turn?: number; by: string; now: Date; actor?: 'person' | 'agent' },
): { panel: IConversationPanel; changed: string } {
  const panel: IConversationPanel = {
    ...current,
    items: current.items.map((item) => ({ ...item })),
    decisions: [...current.decisions],
    questions: current.questions.map((question) => ({ ...question })),
    history: [...current.history],
  }
  const turn = context.turn !== undefined ? { turn: context.turn } : {}
  const need = (value: string | undefined, field: string) => {
    if (!value?.trim()) throw new Error(`${field}: required`)
    return value
  }
  let changed: string
  switch (op.op) {
    case 'set_goal': {
      panel.goal = clip(need(op.goal, 'goal'), PANEL_LIMITS.detail)
      changed = `objetivo: ${panel.goal}`
      break
    }
    case 'add': {
      if (panel.items.length >= PANEL_LIMITS.items) throw new Error(`at most ${PANEL_LIMITS.items} items: drop or finish old ones`)
      const status = op.status ?? 'queued'
      if (!PANEL_ITEM_STATUSES.includes(status)) throw new Error(`status: one of ${PANEL_ITEM_STATUSES.join(', ')}`)
      const item: IPanelItem = {
        id: nextId('p', panel.items),
        title: clip(need(op.title, 'title'), PANEL_LIMITS.text),
        ...(op.detail?.trim() ? { detail: clip(op.detail, PANEL_LIMITS.detail) } : {}),
        status,
        ...(op.delegatedTo?.agentId ? { delegatedTo: op.delegatedTo } : {}),
        ...(context.turn !== undefined ? { askedTurn: context.turn } : {}),
      }
      panel.items.push(item)
      changed = `${item.id} ${item.title} (${STATUS_LABEL[status]})`
      break
    }
    case 'update': {
      const item = panel.items.find((candidate) => candidate.id === op.id)
      if (!item) throw new Error(`item not found: ${op.id} (see read)`)
      if (op.status && !PANEL_ITEM_STATUSES.includes(op.status)) throw new Error(`status: one of ${PANEL_ITEM_STATUSES.join(', ')}`)
      if (op.title !== undefined) item.title = clip(need(op.title, 'title'), PANEL_LIMITS.text)
      if (op.detail !== undefined) item.detail = clip(op.detail, PANEL_LIMITS.detail) || undefined
      if (op.note !== undefined) item.note = clip(op.note, PANEL_LIMITS.detail) || undefined
      if (op.links !== undefined)
        item.links = op.links
          .filter((link) => link?.label?.trim())
          .slice(0, PANEL_LIMITS.links)
          .map((link) => ({ label: clip(link.label, PANEL_LIMITS.text), ...(link.href?.trim() ? { href: clip(link.href, 500) } : {}) }))
      if (op.delegatedTo !== undefined) item.delegatedTo = op.delegatedTo?.agentId ? op.delegatedTo : undefined
      if (op.status) {
        item.status = op.status
        if (op.status === 'done' || op.status === 'dropped') {
          if (context.turn !== undefined) item.doneTurn = context.turn
        } else delete item.doneTurn
      }
      changed = `${item.id} ${item.title} (${STATUS_LABEL[item.status]})${item.note ? `: ${item.note}` : ''}`
      break
    }
    case 'move': {
      const from = panel.items.findIndex((candidate) => candidate.id === op.id)
      if (from < 0) throw new Error(`item not found: ${op.id}`)
      const [item] = panel.items.splice(from, 1)
      const to = op.before ? panel.items.findIndex((candidate) => candidate.id === op.before) : -1
      if (op.before && to < 0) throw new Error(`item not found: ${op.before}`)
      panel.items.splice(to < 0 ? panel.items.length : to, 0, item)
      changed = `${item.id} reordenado`
      break
    }
    case 'decide': {
      if (panel.decisions.length >= PANEL_LIMITS.decisions) throw new Error(`at most ${PANEL_LIMITS.decisions} decisions`)
      const decision: IPanelDecision = {
        id: nextId('d', panel.decisions),
        text: clip(need(op.text, 'text'), PANEL_LIMITS.detail),
        ...(op.why?.trim() ? { why: clip(op.why, PANEL_LIMITS.detail) } : {}),
        by: context.by,
        ...turn,
      }
      panel.decisions.push(decision)
      changed = `decisão ${decision.id}: ${decision.text}`
      break
    }
    case 'ask': {
      if (panel.questions.filter((question) => !question.answer).length >= PANEL_LIMITS.questions) throw new Error(`at most ${PANEL_LIMITS.questions} open questions`)
      const question: IPanelQuestion = { id: nextId('q', panel.questions), text: clip(need(op.text, 'text'), PANEL_LIMITS.detail), ...turn }
      panel.questions.push(question)
      changed = `pergunta ${question.id}: ${question.text}`
      break
    }
    case 'answer': {
      const question = panel.questions.find((candidate) => candidate.id === op.id)
      if (!question) throw new Error(`question not found: ${op.id}`)
      question.answer = clip(need(op.answer, 'answer'), PANEL_LIMITS.detail)
      question.answeredBy = context.actor ?? 'agent'
      if (question.answeredBy === 'person') question.delivered = false
      else delete question.delivered
      changed = `pergunta ${question.id} respondida: ${question.answer}`
      break
    }
    default:
      throw new Error('op: one of set_goal, add, update, move, decide, ask, answer')
  }
  panel.history.push({ at: context.now.toISOString(), ...turn, by: context.by, text: changed })
  if (panel.history.length > PANEL_LIMITS.history) panel.history.splice(0, panel.history.length - PANEL_LIMITS.history)
  panel.updatedAt = context.now.toISOString()
  return { panel, changed }
}

const itemLine = (item: IPanelItem) =>
  `- ${item.id} ${item.title}${item.delegatedTo ? ` (com ${item.delegatedTo.agentId}${item.delegatedTo.sessionId ? `, ${item.delegatedTo.sessionId}` : ''})` : ''}${item.note ? ` — ${item.note}` : ''}`

/**
 * O que o agente vê no começo de cada turno: a rota (objetivo, em andamento, bloqueado, fila, perguntas abertas). Curto
 * de propósito: o entregue e as decisões ficam no painel (`read`). Vazio = nada (conversa sem painel ainda).
 */
export function panelTurnNote(panel: IConversationPanel | undefined, skippedLastTurn = false): string {
  const reminder = skippedLastTurn
    ? `[gateway] A mensagem anterior da pessoa não entrou no painel da conversa: registre o que ela pediu (${PANEL_TOOL} add) ou o que mudou (update).`
    : ''
  if (!panel || (!panel.goal && !panel.items.length && !panel.questions.length)) return reminder
  const fresh = freshAnswers(panel)
  const open = (status: TPanelItemStatus) => panel.items.filter((item) => item.status === status)
  const lines = ['<painel da conversa>']
  if (panel.goal) lines.push(`Objetivo: ${panel.goal}`)
  for (const [status, label] of [
    ['doing', 'Em andamento'],
    ['blocked', 'Bloqueado'],
    ['queued', 'Na fila'],
  ] as const) {
    const items = open(status)
    if (items.length) lines.push(`${label}:`, ...items.map(itemLine))
  }
  if (fresh.length) lines.push('A pessoa respondeu no painel (considere agora):', ...fresh.map((question) => `- ${question.id} ${question.text} → ${question.answer}`))
  const asked = panel.questions.filter((question) => !question.answer)
  if (asked.length)
    lines.push(
      `Perguntas para a pessoa (a que o chat ou o trabalho já respondeu: feche com ${PANEL_TOOL} answer):`,
      ...asked.map((question) => `- ${question.id} ${question.text}`),
    )
  const done = open('done').length
  if (done) lines.push(`(${done} entregue${done > 1 ? 's' : ''}; decisões e histórico: ${PANEL_TOOL} read)`)
  lines.push('</painel da conversa>')
  return [reminder, lines.join('\n')].filter(Boolean).join('\n\n')
}

/** As respostas que a pessoa deu no painel e o agente ainda não viu (vão no próximo `panelTurnNote`). */
export function freshAnswers(panel: IConversationPanel): IPanelQuestion[] {
  return panel.questions.filter((question) => question.answer && question.answeredBy === 'person' && question.delivered === false)
}

/** O painel com essas respostas marcadas como vistas pelo agente. */
export function markAnswersDelivered(panel: IConversationPanel, ids: readonly string[]): IConversationPanel {
  return { ...panel, questions: panel.questions.map((question) => (ids.includes(question.id) ? { ...question, delivered: true } : question)) }
}

/** O painel inteiro em Markdown: a exportação e o que vai junto na compactação. */
export function panelMarkdown(panel: IConversationPanel): string {
  const lines = ['# Painel da conversa']
  if (panel.goal) lines.push('', `**Objetivo:** ${panel.goal}`)
  for (const [status, label] of [
    ['doing', 'Em andamento'],
    ['blocked', 'Bloqueado'],
    ['queued', 'Na fila'],
    ['done', 'Entregue'],
    ['dropped', 'Descartado'],
  ] as const) {
    const items = panel.items.filter((item) => item.status === status)
    if (!items.length) continue
    lines.push('', `## ${label}`)
    for (const item of items) {
      lines.push(itemLine(item))
      if (item.detail) lines.push(`  ${item.detail}`)
      for (const link of item.links ?? []) lines.push(`  - ${link.href ? `[${link.label}](${link.href})` : link.label}`)
    }
  }
  if (panel.decisions.length) lines.push('', '## Decisões', ...panel.decisions.map((decision) => `- ${decision.id} ${decision.text}${decision.why ? ` — ${decision.why}` : ''}`))
  if (panel.questions.length)
    lines.push('', '## Perguntas', ...panel.questions.map((question) => `- ${question.id} ${question.text}${question.answer ? ` → ${question.answer}` : ' (em aberto)'}`))
  return lines.join('\n')
}

/** Lê um painel gravado (JSON), tolerante: o que não serve cai. */
export function normalizePanel(raw: unknown): IConversationPanel {
  if (typeof raw !== 'object' || raw === null) return emptyPanel()
  const stored = raw as Partial<IConversationPanel>
  return {
    ...(typeof stored.goal === 'string' && stored.goal ? { goal: stored.goal } : {}),
    items: Array.isArray(stored.items) ? stored.items.filter((item) => item && typeof item.id === 'string' && PANEL_ITEM_STATUSES.includes(item.status)) : [],
    decisions: Array.isArray(stored.decisions) ? stored.decisions.filter((decision) => decision && typeof decision.id === 'string') : [],
    questions: Array.isArray(stored.questions) ? stored.questions.filter((question) => question && typeof question.id === 'string') : [],
    history: Array.isArray(stored.history) ? stored.history.filter((event) => event && typeof event.text === 'string') : [],
    ...(typeof stored.updatedAt === 'string' ? { updatedAt: stored.updatedAt } : {}),
  }
}
