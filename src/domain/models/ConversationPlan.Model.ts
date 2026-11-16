/**
 * ⚖️ O PLANO DA CONVERSA: a estratégia antes da execução — o contexto, a abordagem, os riscos e os passos. O agente
 * escreve (`plan`), a pessoa aprova ou pede ajustes, e na aprovação cada passo vira um item do board, ligado ao passo.
 * Daí em diante o andamento do plano é o dos itens dele: o board executa, o plano documenta.
 *
 * ⚖️ Vários por conversa: cada pedido de planejamento é um plano (`pl1`, `pl2`…), com o seu status.
 * ⚖️ Não trava o agente: aprovar é o combinado, não uma permissão (o agente segue com as ferramentas de sempre).
 */
export type TPlanStatus = 'draft' | 'review' | 'changes' | 'approved' | 'doing' | 'done' | 'dropped'
export const PLAN_STATUSES: readonly TPlanStatus[] = ['draft', 'review', 'changes', 'approved', 'doing', 'done', 'dropped']

export const PLAN_STATUS_LABEL: Record<TPlanStatus, string> = {
  draft: 'rascunho',
  review: 'aguardando aprovação',
  changes: 'ajustes pedidos',
  approved: 'planejado',
  doing: 'em execução',
  done: 'concluído',
  dropped: 'descartado',
}

export const PLAN_TOOL = 'plan'
export const PLAN_LIMITS = { plans: 20, steps: 40, title: 300, body: 20_000, detail: 2000 } as const

export interface IPlanStep {
  id: string
  title: string
  detail?: string
  /** O item do board que executa o passo (criado na aprovação). */
  item?: string
}

/** O que a pessoa decidiu sobre o plano. Vai ao agente no turno seguinte, uma vez (`delivered`). */
export interface IPlanFeedback {
  kind: 'approved' | 'changes'
  text?: string
  by: string
  at: string
  turn?: number
  /** `false`: o agente ainda não viu. */
  delivered?: boolean
}

export interface IPlan {
  id: string
  title: string
  /** O documento em Markdown: contexto, abordagem, riscos, o que fica de fora. */
  body: string
  steps: IPlanStep[]
  /** O status GRAVADO. O que se mostra sai de `planStatusOf` (o aprovado anda com os itens do board). */
  status: TPlanStatus
  /** Sobe a cada gravação do agente. */
  version: number
  feedback?: IPlanFeedback
  createdTurn?: number
  updatedAt?: string
}

export type TPlanOp =
  | { op: 'plan_create'; title: string; body: string; steps?: Array<{ title: string; detail?: string }> }
  | { op: 'plan_update'; id: string; title?: string; body?: string; steps?: Array<{ title: string; detail?: string }> }
  | { op: 'plan_submit'; id: string }
  | { op: 'plan_approve'; id: string; note?: string }
  | { op: 'plan_changes'; id: string; text: string }
  | { op: 'plan_close'; id: string; status: 'done' | 'dropped'; note?: string }
  | { op: 'plan_add_steps'; id: string; steps: Array<{ title: string; detail?: string }>; note?: string }

export const PLAN_OPS: readonly TPlanOp['op'][] = ['plan_create', 'plan_update', 'plan_submit', 'plan_approve', 'plan_changes', 'plan_close', 'plan_add_steps']

export const isPlanOp = (op: { op?: unknown }): op is TPlanOp => PLAN_OPS.includes(op.op as TPlanOp['op'])

/** O status que se mostra: o aprovado anda com os itens do board (algum andando → em execução; todos fechados → concluído). */
export function planStatusOf(plan: IPlan, itemStatus: (id: string) => string | undefined): TPlanStatus {
  if (plan.status !== 'approved' && plan.status !== 'doing') return plan.status
  const statuses = plan.steps.map((step) => (step.item ? itemStatus(step.item) : undefined)).filter((status): status is string => !!status)
  if (statuses.length && statuses.every((status) => status === 'done' || status === 'dropped')) return 'done'
  if (statuses.some((status) => status !== 'queued')) return 'doing'
  return 'approved'
}

const clip = (text: string, max: number) => text.trim().slice(0, max)

function nextId(prefix: string, taken: readonly { id: string }[]): string {
  const numbers = taken.map((entry) => Number(entry.id.slice(prefix.length))).filter((value) => Number.isFinite(value))
  return `${prefix}${(numbers.length ? Math.max(...numbers) : 0) + 1}`
}

function stepsOf(raw: Array<{ title: string; detail?: string }> | undefined): IPlanStep[] {
  if (!Array.isArray(raw)) return []
  if (raw.length > PLAN_LIMITS.steps) throw new Error(`steps: at most ${PLAN_LIMITS.steps}`)
  return raw.map((step, index) => {
    if (!step?.title?.trim()) throw new Error(`steps[${index}].title: required`)
    return { id: `s${index + 1}`, title: clip(step.title, PLAN_LIMITS.title), ...(step.detail?.trim() ? { detail: clip(step.detail, PLAN_LIMITS.detail) } : {}) }
  })
}

export interface IPlanContext {
  turn?: number
  by: string
  now: Date
  actor?: 'person' | 'agent'
  /** Cria o item do board de um passo aprovado e devolve o id dele. */
  addItem: (step: IPlanStep, plan: IPlan) => string
  /** O status do item do board (para recusar fechar à toa e para o status mostrado). */
  itemStatus: (id: string) => string | undefined
}

/** Aplica a operação de plano. Pura (os itens do board saem por `addItem`). Lança com o motivo quando não serve. */
export function applyPlanOp(current: readonly IPlan[], op: TPlanOp, context: IPlanContext): { plans: IPlan[]; changed: string } {
  const plans = current.map((plan) => ({ ...plan, steps: plan.steps.map((step) => ({ ...step })) }))
  const at = context.now.toISOString()
  const find = (id: string) => {
    const plan = plans.find((candidate) => candidate.id === id)
    if (!plan) throw new Error(`plan not found: ${id} (see read)`)
    return plan
  }
  const need = (value: string | undefined, field: string) => {
    if (!value?.trim()) throw new Error(`${field}: required`)
    return value
  }
  const opened = (plan: IPlan) => plan.status === 'draft' || plan.status === 'review' || plan.status === 'changes'
  switch (op.op) {
    case 'plan_create': {
      if (plans.length >= PLAN_LIMITS.plans) throw new Error(`at most ${PLAN_LIMITS.plans} plans: close old ones`)
      const plan: IPlan = {
        id: nextId('pl', plans),
        title: clip(need(op.title, 'title'), PLAN_LIMITS.title),
        body: clip(need(op.body, 'body'), PLAN_LIMITS.body),
        steps: stepsOf(op.steps),
        status: 'draft',
        version: 1,
        ...(context.turn !== undefined ? { createdTurn: context.turn } : {}),
        updatedAt: at,
      }
      plans.push(plan)
      return { plans, changed: `plano ${plan.id} criado: ${plan.title} (${plan.steps.length} passos)` }
    }
    case 'plan_update': {
      const plan = find(op.id)
      if (plan.status === 'done' || plan.status === 'dropped') throw new Error(`plan ${plan.id} is closed: create a new one`)
      if (op.steps !== undefined && !opened(plan))
        throw new Error(`plan ${plan.id} is approved: its steps are board items now — new steps go with add_steps (each becomes a board item)`)
      if (op.title !== undefined) plan.title = clip(need(op.title, 'title'), PLAN_LIMITS.title)
      if (op.body !== undefined) plan.body = clip(need(op.body, 'body'), PLAN_LIMITS.body)
      if (op.steps !== undefined) plan.steps = stepsOf(op.steps)
      plan.version += 1
      // Mexeu no que estava com a pessoa: volta a rascunho (o pedido de aprovação vale para a versão que ela viu).
      if (plan.status === 'review') plan.status = 'draft'
      plan.updatedAt = at
      return { plans, changed: `plano ${plan.id} atualizado (versão ${plan.version})` }
    }
    case 'plan_submit': {
      const plan = find(op.id)
      if (!opened(plan)) throw new Error(`plan ${plan.id} is ${PLAN_STATUS_LABEL[plan.status]}: nothing to submit`)
      if (!plan.steps.length) throw new Error(`plan ${plan.id} has no steps: add them with update`)
      plan.status = 'review'
      plan.updatedAt = at
      return { plans, changed: `plano ${plan.id} enviado para aprovação` }
    }
    case 'plan_approve': {
      const plan = find(op.id)
      if (!opened(plan)) throw new Error(`plan ${plan.id} is ${PLAN_STATUS_LABEL[plan.status]}: only a draft or a plan under review is approved`)
      if (!plan.steps.length) throw new Error(`plan ${plan.id} has no steps`)
      // O agente só registra a aprovação que a pessoa deu no chat, e diz qual foi.
      if (context.actor !== 'person' && !op.note?.trim()) throw new Error('note: required — quote the person approving in the chat')
      for (const step of plan.steps) if (!step.item) step.item = context.addItem(step, plan)
      plan.status = 'approved'
      plan.feedback = {
        kind: 'approved',
        ...(op.note?.trim() ? { text: clip(op.note, PLAN_LIMITS.detail) } : {}),
        by: context.by,
        at,
        ...(context.turn !== undefined ? { turn: context.turn } : {}),
        ...(context.actor === 'person' ? { delivered: false } : {}),
      }
      plan.updatedAt = at
      return { plans, changed: `plano ${plan.id} aprovado: ${plan.steps.length} passos no board (${plan.steps.map((step) => step.item).join(', ')})` }
    }
    case 'plan_changes': {
      const plan = find(op.id)
      if (!opened(plan)) throw new Error(`plan ${plan.id} is ${PLAN_STATUS_LABEL[plan.status]}: changes are asked on a draft or a plan under review`)
      plan.status = 'changes'
      plan.feedback = {
        kind: 'changes',
        text: clip(need(op.text, 'text'), PLAN_LIMITS.detail),
        by: context.by,
        at,
        ...(context.turn !== undefined ? { turn: context.turn } : {}),
        ...(context.actor === 'person' ? { delivered: false } : {}),
      }
      plan.updatedAt = at
      return { plans, changed: `ajustes pedidos no plano ${plan.id}: ${plan.feedback.text}` }
    }
    case 'plan_add_steps': {
      // ⚖️ O PLANO CRESCE COM A CONVERSA: a pessoa pediu mais depois da aprovação, e o passo novo entra no plano (com o
      // próximo id) — no aprovado, já como item do board, ligado a ele; no que ainda está aberto, só no texto.
      const plan = find(op.id)
      if (plan.status === 'done' || plan.status === 'dropped') throw new Error(`plan ${plan.id} is closed: create a new one`)
      if (!Array.isArray(op.steps) || !op.steps.length) throw new Error('steps: at least one')
      if (plan.steps.length + op.steps.length > PLAN_LIMITS.steps) throw new Error(`steps: at most ${PLAN_LIMITS.steps} per plan`)
      const added = stepsOf(op.steps)
      for (const step of added) {
        step.id = nextId('s', plan.steps)
        plan.steps.push(step)
        if (!opened(plan)) step.item = context.addItem(step, plan)
      }
      if (plan.status === 'review') plan.status = 'draft'
      plan.version += 1
      plan.updatedAt = at
      const where = opened(plan) ? '' : ` → board (${added.map((step) => step.item).join(', ')})`
      return {
        plans,
        changed: `plano ${plan.id}: ${added.length} passo(s) novo(s) (${added.map((step) => step.id).join(', ')})${where}${op.note?.trim() ? ` — ${clip(op.note, PLAN_LIMITS.detail)}` : ''}`,
      }
    }
    case 'plan_close': {
      const plan = find(op.id)
      if (op.status !== 'done' && op.status !== 'dropped') throw new Error('status: done or dropped')
      plan.status = op.status
      plan.updatedAt = at
      return { plans, changed: `plano ${plan.id} ${PLAN_STATUS_LABEL[op.status]}${op.note?.trim() ? `: ${clip(op.note, PLAN_LIMITS.detail)}` : ''}` }
    }
    default:
      throw new Error(`op: one of ${PLAN_OPS.join(', ')}`)
  }
}

/** Os planos com decisão da pessoa que o agente ainda não viu. */
export function freshPlanFeedback(plans: readonly IPlan[]): IPlan[] {
  return plans.filter((plan) => plan.feedback && plan.feedback.delivered === false)
}

/** Um plano em Markdown (a leitura do agente, a exportação e a página). */
export function planMarkdown(plan: IPlan, itemStatus: (id: string) => string | undefined, level = 2): string {
  const heading = '#'.repeat(level)
  const status = planStatusOf(plan, itemStatus)
  const lines = [`${heading} ${plan.id} · ${plan.title}`, '', `**Status:** ${PLAN_STATUS_LABEL[status]} · versão ${plan.version}`]
  if (plan.feedback)
    lines.push(`**${plan.feedback.kind === 'approved' ? 'Aprovado' : 'Ajustes pedidos'}** por ${plan.feedback.by}${plan.feedback.text ? `: ${plan.feedback.text}` : ''}`)
  lines.push('', plan.body)
  if (plan.steps.length) {
    lines.push('', `${heading}# Passos`)
    for (const step of plan.steps) {
      const item = step.item ? itemStatus(step.item) : undefined
      lines.push(`- ${step.id} ${step.title}${step.item ? ` → ${step.item}${item ? ` (${item})` : ''}` : ''}`)
      if (step.detail) lines.push(`  ${step.detail}`)
    }
  }
  return lines.join('\n')
}

/** Lê os planos gravados, tolerante: o que não serve cai. */
export function normalizePlans(raw: unknown): IPlan[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((plan) => plan && typeof plan.id === 'string' && typeof plan.title === 'string' && PLAN_STATUSES.includes(plan.status))
    .map((plan) => ({
      ...plan,
      body: typeof plan.body === 'string' ? plan.body : '',
      steps: Array.isArray(plan.steps) ? plan.steps.filter((step: IPlanStep) => step && typeof step.id === 'string' && typeof step.title === 'string') : [],
      version: typeof plan.version === 'number' ? plan.version : 1,
    }))
}
