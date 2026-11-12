/**
 * O LEDGER de um agente (a guia Memória): o que ele aprendeu de COMO AGIR, por tema. Os tipos espelham a API
 * (`/agents/:id/ledger`); quem valida é o servidor — a mesma regra da ferramenta `ledger_write` do agente.
 */

export type TLedgerLineType = 'APRENDIZADO' | 'POSTURA' | 'DIFICULDADE'
export const LEDGER_LINE_TYPES: Array<{ id: TLedgerLineType; label: string; hint: string }> = [
  { id: 'APRENDIZADO', label: 'Aprendizado / regra', hint: 'como fazer, verdade verificada' },
  { id: 'POSTURA', label: 'Postura / modo', hint: 'como agir: tom, parceria' },
  { id: 'DIFICULDADE', label: 'Dificuldade / falha', hint: 'episódio honesto — não vira regra' },
]

export type TLedgerAuthor = { kind: 'agent'; agentId: string; conversationId?: string } | { kind: 'admin'; email: string }

export interface ILedgerWarning {
  code: 'trigger-missing' | 'trigger-weak' | 'state-verb' | 'too-many-lines' | 'similar-topics' | 'empty-context'
  topic?: string
  related?: string
  lineId?: number
  message: string
}

export interface ILedgerLine {
  id: number
  date: string
  type: TLedgerLineType
  trigger: string
  learning: string
  ref: string
  createdAt: string
  createdBy: TLedgerAuthor
  updatedAt: string
  updatedBy: TLedgerAuthor
}

export interface ILedgerContextSummary {
  topic: string
  trigger: string
  lineCount: number
  hasPlaybook: boolean
  createdAt: string
  createdBy: TLedgerAuthor
  updatedAt: string
  updatedBy: TLedgerAuthor
  warnings: ILedgerWarning[]
  /** O tema é da BASE do agente global (no projeto, só leitura: escrever nele copia o tema para o projeto). */
  base?: boolean
}

export interface ILedgerContext extends ILedgerContextSummary {
  playbook: string
  lines: ILedgerLine[]
}

export interface ILedgerIndex {
  agentId: string
  contexts: ILedgerContextSummary[]
  lineCount: number
  warnings: ILedgerWarning[]
}

export interface ILedgerWriteResult {
  action: string
  topic: string
  context?: ILedgerContext
  index: ILedgerIndex
  warnings: ILedgerWarning[]
  changed: boolean
}

export type TLedgerSnapshot =
  | { trigger: string; playbook: string; lines?: Array<Omit<ILedgerLine, 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>> }
  | Omit<ILedgerLine, 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>

export interface ILedgerRevision {
  id: number
  topic: string
  action: 'criar' | 'gatilho' | 'playbook' | 'linha_nova' | 'linha_editar' | 'linha_apagar' | 'excluir'
  lineId?: number
  at: string
  by: TLedgerAuthor
  before?: TLedgerSnapshot
  after?: TLedgerSnapshot
}

export type TLedgerLineInput = Pick<ILedgerLine, 'type' | 'trigger' | 'learning'> & { ref?: string; date?: string }

/** A chave do contexto na store: o agente e o tema. */
export const contextKey = (agentId: string, topic: string): string => `${agentId}\u0000${topic}`

export const ACTION_LABEL: Record<ILedgerRevision['action'], string> = {
  criar: 'criou o contexto',
  gatilho: 'mudou o gatilho',
  playbook: 'mudou o playbook',
  linha_nova: 'acrescentou uma linha',
  linha_editar: 'editou uma linha',
  linha_apagar: 'apagou uma linha',
  excluir: 'excluiu o contexto',
}

/** O selo curto de cada aviso, na lista de contextos. */
export const WARNING_BADGE: Record<ILedgerWarning['code'], string> = {
  'trigger-missing': 'sem gatilho',
  'trigger-weak': 'gatilho fraco',
  'state-verb': 'estado de missão',
  'too-many-lines': 'linhas demais',
  'similar-topics': 'tema parecido',
  'empty-context': 'vazio',
}

/** "theo (conversa c-1)" ou o e-mail de quem administra. */
export function authorLabel(author: TLedgerAuthor): string {
  return author.kind === 'admin' ? author.email : `${author.agentId}${author.conversationId ? ` · conversa ${author.conversationId}` : ''}`
}

/** A linha como a spec a escreve: `[DATA] | TIPO | gatilho | aprendizado | ref`. */
export function lineText(line: Pick<ILedgerLine, 'date' | 'type' | 'trigger' | 'learning' | 'ref'>): string {
  return [`[${line.date}]`, line.type, line.trigger, line.learning, ...(line.ref ? [line.ref] : [])].join(' | ')
}

/** O resumo de uma revisão: o antes e o depois de um campo, em texto (o contexto ou a linha). */
export function snapshotText(snapshot: TLedgerSnapshot | undefined): string {
  if (!snapshot) return ''
  if ('learning' in snapshot) return `#${snapshot.id} ${lineText(snapshot)}`
  const lines = snapshot.lines?.length ? `\n${snapshot.lines.map((line) => `#${line.id} ${lineText(line)}`).join('\n')}` : ''
  return `Gatilho: ${snapshot.trigger}${snapshot.playbook ? `\nPlaybook:\n${snapshot.playbook}` : ''}${lines}`
}

/** Sem acento e minúsculo, como a busca do servidor. */
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** O filtro da lista: todas as palavras no tema ou no gatilho. Vazio = tudo. */
export function filterContexts<T extends Pick<ILedgerContextSummary, 'topic' | 'trigger'>>(contexts: readonly T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return [...contexts]
  return contexts.filter((context) => words.every((word) => fold(`${context.topic} ${context.trigger}`).includes(word)))
}
