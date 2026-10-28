/**
 * A LISTA DE TAREFAS de uma conversa: o agente organiza os passos de um trabalho longo e a pessoa acompanha na tela.
 *
 * ⚖️ É DO GATEWAY, não do SDK: fica gravada na conversa, continua quando a conversa troca de provedor e a execução
 * seguinte de um agendamento contínuo vê o que ficou pendente. (A nativa do Claude morria com a sessão do SDK.)
 */
export type TTodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled'

export interface ITodoItem {
  title: string
  status: TTodoStatus
}

export const TODO_STATUSES: readonly TTodoStatus[] = ['pending', 'in_progress', 'done', 'cancelled']
export const TODO_MAX_ITEMS = 30
export const TODO_TITLE_MAX = 200
export const UPDATE_TODOS_TOOL = 'update_todos'

/** O que está errado na lista (vazio = ok). ⛔ Um item em andamento por vez: é o que torna a lista legível. */
export function todoIssues(items: unknown): string[] {
  if (!Array.isArray(items) || !items.length) return ['items: a non-empty list of { title, status }']
  if (items.length > TODO_MAX_ITEMS) return [`items: at most ${TODO_MAX_ITEMS}`]
  const issues: string[] = []
  items.forEach((item, index) => {
    const entry = item as Partial<ITodoItem> | null
    const title = typeof entry?.title === 'string' ? entry.title.trim() : ''
    if (!title) issues.push(`items[${index}].title: required`)
    else if (title.length > TODO_TITLE_MAX) issues.push(`items[${index}].title: at most ${TODO_TITLE_MAX} characters`)
    if (!TODO_STATUSES.includes(entry?.status as TTodoStatus)) issues.push(`items[${index}].status: one of ${TODO_STATUSES.join(', ')}`)
  })
  if (items.filter((item) => (item as ITodoItem | null)?.status === 'in_progress').length > 1) issues.push('only one item can be in_progress at a time')
  return issues
}

/** A lista como o modelo lê de volta: um item por linha, com o estado. */
export function todoText(items: readonly ITodoItem[]): string {
  const mark: Record<TTodoStatus, string> = { pending: '[ ]', in_progress: '[~]', done: '[x]', cancelled: '[-]' }
  const done = items.filter((item) => item.status === 'done').length
  return [`Tasks (${done}/${items.length} done):`, ...items.map((item) => `${mark[item.status]} ${item.title}`)].join('\n')
}
