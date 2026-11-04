/** O Painel da conversa (espelho de `ConversationPanel.Model` no gateway): o documento vivo que o agente mantém. */
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
  turn?: number
}
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

/** Uma operação da tela no painel (`PATCH /conversations/:id/panel`). */
export type TPanelOp =
  | { op: 'update'; id: string; status?: TPanelStatus; note?: string; title?: string }
  | { op: 'move'; id: string; before?: string }
  | { op: 'answer'; id: string; answer: string }
  | { op: 'set_goal'; goal: string }

/** Os itens em aberto (na fila, em andamento, bloqueados): o número do selo do ícone. */
export function openCount(panel: Pick<IConversationPanel, 'items'> | undefined): number {
  return (panel?.items ?? []).filter((item) => item.status === 'queued' || item.status === 'doing' || item.status === 'blocked').length
}

export type TLinkKind = 'external' | 'conversation' | 'path'

/** Como um link do painel aparece: endereço abre em outra guia, `gw_…` é uma conversa, o resto é caminho de arquivo. */
export function linkKind(href: string | undefined): TLinkKind | undefined {
  if (!href) return undefined
  if (/^https?:\/\//i.test(href)) return 'external'
  if (/^gw_[\w-]+$/.test(href)) return 'conversation'
  return 'path'
}
