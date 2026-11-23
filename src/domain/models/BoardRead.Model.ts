import {
  BOARD_TOOL,
  IConversationPanel,
  IPanelDecision,
  IPanelItem,
  IPanelQuestion,
  PANEL_ITEM_STATUSES,
  plansMarkdown,
  statusOf,
  TPanelItemStatus,
  TPanelOp,
} from './ConversationPanel.Model'
import { IPlan, isPlanOp, PLAN_STATUS_LABEL, PLAN_TOOL, planStatusOf } from './ConversationPlan.Model'

/**
 * ⚖️ A LEITURA COMPACTA das ferramentas `board` e `plan`: uma linha por entrada, paginada, e o `get` para o texto inteiro.
 * O board inteiro a cada chamada estourava o limite de resultado de ferramenta (dezenas de milhares de caracteres numa
 * conversa longa). `panelMarkdown` segue inteiro para a exportação e a compactação.
 */
export const BOARD_SECTIONS = ['items', 'decisions', 'questions'] as const
export type TBoardSection = (typeof BOARD_SECTIONS)[number]
export const READ_LIMITS = { default: 30, max: 100 } as const

export interface IBoardReadOptions {
  section?: TBoardSection
  status?: readonly TPanelItemStatus[]
  q?: string
  limit?: number
  page?: number
}

/** Pagina a lista: `limit` (padrão 30, teto 100) e `page` (1-based). Lança se a página não existe. */
function paginate<T>(all: readonly T[], options: { limit?: number; page?: number }): { rows: T[]; page: number; pages: number; limit: number } {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? READ_LIMITS.default) || READ_LIMITS.default, 1), READ_LIMITS.max)
  const page = Math.max(Math.trunc(options.page ?? 1) || 1, 1)
  const pages = Math.max(Math.ceil(all.length / limit), 1)
  if (page > pages) throw new Error(`page ${page} does not exist: ${pages} page${pages > 1 ? 's' : ''} (limit ${limit})`)
  return { rows: all.slice((page - 1) * limit, page * limit), page, pages, limit }
}

const short = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Uma linha do item: id, status, título, passo do plano e com quem está. Sem detalhe, nota nem links. */
export const itemRow = (item: IPanelItem) =>
  `- ${item.id} [${item.status}] ${item.title}${item.plan ? ` [${item.plan.id}·${item.plan.step}]` : ''}${item.delegatedTo ? ` (com ${item.delegatedTo.agentId})` : ''}`
export const decisionRow = (decision: IPanelDecision) => `- ${decision.id} ${short(decision.text)}`
export const questionRow = (question: IPanelQuestion) =>
  `- ${question.id} [${question.answer ? 'respondida' : 'aberta'}] ${short(question.text)}${question.answer ? ` → ${short(question.answer, 80)}` : ''}`

/** A linha do "página X de Y" e como pedir a próxima (com os mesmos filtros). */
function pageLine(total: number, paged: { page: number; pages: number; limit: number }, args: string[]): string {
  if (!total) return 'Nada encontrado.'
  if (paged.limit !== READ_LIMITS.default) args = [...args, `limit=${paged.limit}`]
  const next = paged.page < paged.pages ? ` — próxima: ${BOARD_TOOL} read ${[...args, `page=${paged.page + 1}`].join(' ')}` : ''
  return `página ${paged.page} de ${paged.pages} (${total} no filtro)${next}`
}

/** O `board read`: objetivo, totais do board inteiro e a lista (uma linha por entrada) do filtro, paginada. */
export function boardListMarkdown(panel: IConversationPanel, options: IBoardReadOptions = {}): string {
  const section = options.section ?? 'items'
  if (!BOARD_SECTIONS.includes(section)) throw new Error(`section: one of ${BOARD_SECTIONS.join(', ')}`)
  for (const status of options.status ?? []) if (!PANEL_ITEM_STATUSES.includes(status)) throw new Error(`status: one of ${PANEL_ITEM_STATUSES.join(', ')}`)
  const needle = options.q?.trim().toLowerCase()
  const match = (text: string) => !needle || text.toLowerCase().includes(needle)
  const counts = PANEL_ITEM_STATUSES.map((status) => [status, panel.items.filter((item) => item.status === status).length] as const).filter(([, count]) => count)
  const open = panel.questions.filter((question) => !question.answer).length
  const lines = [
    `Objetivo: ${panel.goal ?? '(sem objetivo)'}`,
    `Itens: ${panel.items.length}${counts.length ? ` (${counts.map(([status, count]) => `${status} ${count}`).join(', ')})` : ''} · decisões: ${panel.decisions.length} · perguntas: ${panel.questions.length} (${open} abertas) · planos: ${(panel.plans ?? []).length}`,
  ]
  const args: string[] = []
  if (section !== 'items') args.push(`section=${section}`)
  let rows: string[]
  let total: number
  let paged: { page: number; pages: number; limit: number }
  if (section === 'items') {
    const wanted = options.status?.length ? options.status : undefined
    if (wanted) args.push(`status=${wanted.join(',')}`)
    const found = panel.items.filter((item) => (!wanted || wanted.includes(item.status)) && match(item.title))
    const slice = paginate(found, options)
    paged = slice
    rows = slice.rows.map(itemRow)
    total = found.length
  } else if (section === 'decisions') {
    const found = panel.decisions.filter((decision) => match(decision.text))
    const slice = paginate(found, options)
    paged = slice
    rows = slice.rows.map(decisionRow)
    total = found.length
  } else {
    // As abertas primeiro (a ordem do board dentro de cada grupo).
    const found = panel.questions.filter((question) => match(question.text))
    const ordered = [...found.filter((question) => !question.answer), ...found.filter((question) => question.answer)]
    const slice = paginate(ordered, options)
    paged = slice
    rows = slice.rows.map(questionRow)
    total = ordered.length
  }
  if (needle) args.push(`q=${options.q!.trim()}`)
  lines.push(pageLine(total, paged, args), ...rows, `(texto completo de uma entrada: ${BOARD_TOOL} get id=…)`)
  return lines.join('\n')
}

/** Quando a entrada mudou pela última vez (o histórico), se houver. */
function lastChange(panel: IConversationPanel, id: string): string | undefined {
  const own = new RegExp(`^(decisão|pergunta|plano) ${id}\\b`)
  const event = [...panel.history].reverse().find((candidate) => candidate.text.startsWith(`${id} `) || own.test(candidate.text))
  return event ? `${event.at}${event.turn !== undefined ? ` (turno ${event.turn})` : ''} por ${event.by}` : undefined
}

/** O `board get`: a entrada inteira (item, decisão, pergunta ou plano). Lança se o id não existe. */
export function boardEntryMarkdown(panel: IConversationPanel, id: string): string {
  const changed = lastChange(panel, id)
  const when = changed ? [`Mudou: ${changed}`] : []
  const item = panel.items.find((candidate) => candidate.id === id)
  if (item) {
    const lines = [`${item.id} ${item.title}`, `Status: ${item.status}`]
    if (item.detail) lines.push(`Detalhe: ${item.detail}`)
    if (item.note) lines.push(`Nota: ${item.note}`)
    if (item.links?.length) lines.push('Links:', ...item.links.map((link) => `- ${link.href ? `[${link.label}](${link.href})` : link.label}`))
    if (item.plan) lines.push(`Passo do plano: ${item.plan.id}·${item.plan.step}`)
    if (item.delegatedTo) lines.push(`Com: ${item.delegatedTo.agentId}${item.delegatedTo.sessionId ? ` (${item.delegatedTo.sessionId})` : ''}`)
    if (item.askedTurn !== undefined) lines.push(`Pedido no turno ${item.askedTurn}${item.doneTurn !== undefined ? `; fechado no turno ${item.doneTurn}` : ''}`)
    return [...lines, ...when].join('\n')
  }
  const decision = panel.decisions.find((candidate) => candidate.id === id)
  if (decision)
    return [
      `${decision.id} decisão: ${decision.text}`,
      ...(decision.why ? [`Motivo: ${decision.why}`] : []),
      ...(decision.by ? [`Por: ${decision.by}`] : []),
      ...(decision.turn !== undefined ? [`Turno: ${decision.turn}`] : []),
      ...when,
    ].join('\n')
  const question = panel.questions.find((candidate) => candidate.id === id)
  if (question)
    return [
      `${question.id} pergunta: ${question.text}`,
      question.answer ? `Resposta${question.answeredBy ? ` (${question.answeredBy})` : ''}: ${question.answer}` : 'Em aberto.',
      ...(question.turn !== undefined ? [`Turno: ${question.turn}`] : []),
      ...when,
    ].join('\n')
  if ((panel.plans ?? []).some((candidate) => candidate.id === id)) return plansMarkdown(panel, id)
  throw new Error(`entry not found: ${id} (see ${BOARD_TOOL} read)`)
}

/** Uma linha do plano: id, título, status, passos e quantos estão prontos. */
export function planRow(panel: IConversationPanel, plan: IPlan): string {
  const status = statusOf(panel)
  const done = plan.steps.filter((step) => step.item && status(step.item) === 'done').length
  return `- ${plan.id} ${plan.title} (${PLAN_STATUS_LABEL[planStatusOf(plan, status)]}) — ${plan.steps.length} passo${plan.steps.length === 1 ? '' : 's'}, ${done} pronto${done === 1 ? '' : 's'}`
}

/** O `plan read` sem id: uma linha por plano, paginada. */
export function planListMarkdown(panel: IConversationPanel, options: { limit?: number; page?: number } = {}): string {
  const plans = panel.plans ?? []
  if (!plans.length) return 'Nenhum plano nesta conversa ainda.'
  const paged = paginate(plans, options)
  const next = paged.page < paged.pages ? ` — próxima: ${PLAN_TOOL} read page=${paged.page + 1}${paged.limit !== READ_LIMITS.default ? ` limit=${paged.limit}` : ''}` : ''
  return [
    `Planos: ${plans.length} · página ${paged.page} de ${paged.pages}${next}`,
    ...paged.rows.map((plan) => planRow(panel, plan)),
    `(o plano inteiro: ${PLAN_TOOL} read id=…)`,
  ].join('\n')
}

/** A linha da entrada que a operação mexeu (a resposta de uma gravação: nunca o board inteiro). */
export function touchedLine(panel: IConversationPanel, op: TPanelOp): string {
  const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1]
  if (isPlanOp(op)) {
    const id = 'id' in op && op.id ? op.id : last(panel.plans ?? [])?.id
    const plan = (panel.plans ?? []).find((candidate) => candidate.id === id)
    return plan ? planRow(panel, plan) : ''
  }
  switch (op.op) {
    case 'set_goal':
      return `Objetivo: ${panel.goal ?? ''}`
    case 'add': {
      const item = last(panel.items)
      return item ? itemRow(item) : ''
    }
    case 'update':
    case 'move': {
      const item = panel.items.find((candidate) => candidate.id === op.id)
      return item ? itemRow(item) : ''
    }
    case 'decide': {
      const decision = last(panel.decisions)
      return decision ? decisionRow(decision) : ''
    }
    case 'ask': {
      const question = last(panel.questions)
      return question ? questionRow(question) : ''
    }
    case 'answer': {
      const question = panel.questions.find((candidate) => candidate.id === op.id)
      return question ? questionRow(question) : ''
    }
    default:
      return ''
  }
}
