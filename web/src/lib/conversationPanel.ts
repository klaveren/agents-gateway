/** O Board da conversa (espelho de `ConversationPanel.Model` no gateway): o documento vivo que o agente mantém, com os planos. */
export type TPanelStatus = 'queued' | 'doing' | 'blocked' | 'done' | 'dropped'

export interface IPanelLink {
  label: string
  href?: string
}
export interface IPanelItem {
  id: string
  title: string
  detail?: string
  status: TPanelStatus
  note?: string
  links?: IPanelLink[]
  delegatedTo?: { agentId: string; sessionId?: string }
  askedTurn?: number
  doneTurn?: number
  /** O passo de plano que o item executa (criado na aprovação). */
  plan?: { id: string; step: string }
}
export interface IPanelDecision {
  id: string
  text: string
  why?: string
  by?: string
  turn?: number
}
export interface IPanelQuestion {
  id: string
  text: string
  answer?: string
  answeredBy?: 'person' | 'agent'
  /** `false`: você respondeu no painel e o agente ainda não viu (vê no próximo turno). */
  delivered?: boolean
  turn?: number
}
export interface IPanelEvent {
  at: string
  turn?: number
  by: string
  text: string
}
/** Um plano (espelho de `ConversationPlan.Model`). */
export type TPlanStatus = 'draft' | 'review' | 'changes' | 'approved' | 'doing' | 'done' | 'dropped'
export const PLAN_STATUS_LABEL: Record<TPlanStatus, string> = {
  draft: 'Rascunho',
  review: 'Aguardando aprovação',
  changes: 'Ajustes pedidos',
  approved: 'Planejado',
  doing: 'Em execução',
  done: 'Concluído',
  dropped: 'Descartado',
}
export interface IPlanStep {
  id: string
  title: string
  detail?: string
  item?: string
}
export interface IPlan {
  id: string
  title: string
  body: string
  steps: IPlanStep[]
  status: TPlanStatus
  version: number
  feedback?: { kind: 'approved' | 'changes'; text?: string; by: string; at: string; delivered?: boolean }
  updatedAt?: string
}
export interface IConversationPanel {
  goal?: string
  items: IPanelItem[]
  decisions: IPanelDecision[]
  questions: IPanelQuestion[]
  plans: IPlan[]
  history: IPanelEvent[]
  updatedAt?: string
}

/** O status que se mostra: o aprovado anda com os itens do board (o mesmo cálculo do servidor). */
export function planStatusOf(plan: IPlan, items: readonly IPanelItem[]): TPlanStatus {
  if (plan.status !== 'approved' && plan.status !== 'doing') return plan.status
  const statuses = plan.steps.map((step) => items.find((item) => item.id === step.item)?.status).filter((status): status is TPanelStatus => !!status)
  if (statuses.length && statuses.every((status) => status === 'done' || status === 'dropped')) return 'done'
  if (statuses.some((status) => status !== 'queued')) return 'doing'
  return 'approved'
}

/** O plano espera a pessoa (pode ser aprovado ou receber pedido de ajuste). */
export const awaitsPerson = (plan: IPlan) => plan.status === 'draft' || plan.status === 'review' || plan.status === 'changes'

/** Uma operação da tela no painel (`PATCH /conversations/:id/panel`). */
export type TPanelOp =
  | { op: 'update'; id: string; status?: TPanelStatus; note?: string; title?: string }
  | { op: 'move'; id: string; before?: string }
  | { op: 'answer'; id: string; answer: string }
  | { op: 'set_goal'; goal: string }
  | { op: 'plan_approve'; id: string }
  | { op: 'plan_changes'; id: string; text: string }

/** O selo do ícone: os itens em aberto (na fila, em andamento, bloqueados) e os planos aguardando a sua aprovação. */
export function openCount(panel: (Pick<IConversationPanel, 'items'> & { plans?: IPlan[] }) | undefined): number {
  const items = (panel?.items ?? []).filter((item) => item.status === 'queued' || item.status === 'doing' || item.status === 'blocked').length
  return items + (panel?.plans ?? []).filter((plan) => plan.status === 'review').length
}

export type TLinkKind = 'external' | 'conversation' | 'path'

/** Como um link do painel aparece: endereço abre em outra guia, `gw_…` é uma conversa, o resto é caminho de arquivo. */
export function linkKind(href: string | undefined): TLinkKind | undefined {
  if (!href) return undefined
  if (/^https?:\/\//i.test(href)) return 'external'
  if (/^gw_[\w-]+$/.test(href)) return 'conversation'
  return 'path'
}

/**
 * O host de destino de um link externo, para aparecer ao lado do texto: quem escreve o texto é o agente, e ele pode
 * mentir (`Reautenticar` → outro site). Vazio quando o texto já é o próprio endereço, ou o endereço não se lê.
 */
export function linkHost(link: { label: string; href?: string }): string {
  if (linkKind(link.href) !== 'external' || !link.href) return ''
  const host = hostOf(link.href)
  const bare = link.label
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
  return !host || link.label.trim() === link.href || bare === host ? '' : host
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname
  } catch {
    return ''
  }
}
