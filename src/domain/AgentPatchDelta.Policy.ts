import { DomainError } from './errors/Domain.Error'

/**
 * ⛔ QUEM GRAVA É AGENTE: LISTA SÓ POR DELTA. Em 26/11 uma agente mandou `allowedTools` INTEIRA a 11 agentes da origem,
 * montada da lista efetiva que via no projeto conectado (origem menos o que o Mac desliga): o gateway trocou a lista e
 * 171 ferramentas saíram na hora. Daqui em diante o agente manda só `{ add, remove }`, a diferença é calculada contra o
 * catálogo DESTA máquina (nunca contra o que o chamador diz) e vale um teto por chamada. A lista inteira segue valendo
 * pela tela (pessoa) e pela importação, que não passam por aqui.
 */

/** O teto de alterações por chamada (acrescentar + tirar somados, por agente). */
export const AGENT_DELTA_LIMIT = 5

export interface IListDelta {
  add?: string[]
  remove?: string[]
}

/** O que a chamada muda num campo-lista, já contra o de agora: só o que entra de fato e o que sai de fato. */
export interface IListChange {
  field: string
  added: string[]
  removed: string[]
  /** Pedido para tirar, mas o agente não tem: nada a fazer. */
  ignored?: string[]
}

export function isListDelta(value: unknown): value is IListDelta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (!keys.length || keys.some((key) => key !== 'add' && key !== 'remove')) return false
  const list = (item: unknown) => item === undefined || (Array.isArray(item) && item.every((entry) => typeof entry === 'string'))
  return list((value as IListDelta).add) && list((value as IListDelta).remove)
}

/** O delta aplicado à lista de agora: a ordem de agora fica, o que entra vai ao fim; o que já está ou não está não conta. */
export function applyListDelta(field: string, current: readonly string[], delta: IListDelta, normalize: (items: string[]) => string[] = (items) => items) {
  const add = [...new Set(normalize((delta.add ?? []).map((entry) => entry.trim()).filter(Boolean)))]
  const remove = [...new Set(normalize((delta.remove ?? []).map((entry) => entry.trim()).filter(Boolean)))]
  const both = add.filter((entry) => remove.includes(entry))
  if (both.length) throw new AgentListDeltaError(field, `in both add and remove: ${both.join(', ')}. Add or remove, not both`)
  const removed = remove.filter((entry) => current.includes(entry))
  const ignored = remove.filter((entry) => !current.includes(entry))
  const added = add.filter((entry) => !current.includes(entry))
  const next = [...current.filter((entry) => !removed.includes(entry)), ...added]
  const change: IListChange = { field, added, removed, ...(ignored.length ? { ignored } : {}) }
  return { next, change }
}

export const changeCount = (changes: readonly IListChange[]) => changes.reduce((sum, change) => sum + change.added.length + change.removed.length, 0)

/** ⛔ Acima do teto: nada grava; a diferença volta para o agente fazer em partes. */
export function assertWithinLimit(changes: readonly IListChange[], limit = AGENT_DELTA_LIMIT): void {
  const count = changeCount(changes)
  if (count > limit)
    throw new AgentDeltaTooLargeError(
      limit,
      count,
      changes.filter((change) => change.added.length || change.removed.length),
    )
}

/** Uma lista inteira (ou um delta malformado) onde o agente só pode mandar `{ add, remove }`. Leva a lista de agora. */
export class AgentListDeltaError extends DomainError {
  constructor(
    public readonly field: string,
    message: string,
    public readonly current?: Record<string, unknown>,
  ) {
    super(`${field}: ${message}`)
  }
}

/** Mais alterações numa chamada do que o teto. Leva a diferença (o que sairia, o que entraria). */
export class AgentDeltaTooLargeError extends DomainError {
  constructor(
    public readonly limit: number,
    public readonly count: number,
    public readonly changes: readonly IListChange[],
  ) {
    super(`This call changes ${count} entries; the limit is ${limit} per call (add + remove). Do it in parts of up to ${limit}, confirming with the person between them`)
  }
}

/** A mensagem da lista inteira recusada. */
export const LIST_REFUSED =
  'send only the change, { "add": [...], "remove": [...] }, never the whole list (patch_agent; save_agent only keeps the current list). The current list on this machine is in details.current'

/** Os campos-lista do agente que o agente só muda por delta. */
export const AGENT_DELTA_FIELDS = ['allowedTools', 'modes'] as const

export interface IAgentPatchDelta {
  /** O patch com cada delta virado na lista nova (sobre o agente de agora). */
  patch: Record<string, unknown>
  changes: IListChange[]
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((entry) => b.includes(entry))

/**
 * O patch de um AGENTE contra o agente de agora: cada campo-lista vem como `{ add, remove }` e vira a lista nova.
 *  - Lista inteira → recusa com a lista de agora (`AgentListDeltaError`). Exceções: a lista IGUAL à de agora (o `save_agent`
 *    reenviando o agente para mudar outro campo) não muda nada e sai do patch; e `creating` (o `save_agent` de um agente
 *    novo, que nasceu sem nada) aceita a lista que só acrescenta.
 *  - Acima do teto → `AgentDeltaTooLargeError`, com a diferença. `creating` não tem teto: só acrescenta, tudo pendente.
 */
export function resolveAgentPatchDelta(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  options: { creating?: boolean; normalize?: Partial<Record<(typeof AGENT_DELTA_FIELDS)[number], (items: string[]) => string[]>> } = {},
): IAgentPatchDelta {
  const next = { ...patch }
  const changes: IListChange[] = []
  const lists = Object.fromEntries(AGENT_DELTA_FIELDS.map((field) => [field, listOf(current[field])]))
  for (const field of AGENT_DELTA_FIELDS) {
    if (!(field in patch)) continue
    const value = patch[field]
    const now = lists[field]
    const normalize = options.normalize?.[field] ?? ((items: string[]) => items)
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      const asked = [...new Set(normalize(value as string[]))]
      if (sameSet(asked, now)) {
        delete next[field]
        continue
      }
      if (!options.creating || now.some((entry) => !asked.includes(entry))) throw new AgentListDeltaError(field, LIST_REFUSED, lists)
      next[field] = [...now, ...asked.filter((entry) => !now.includes(entry))]
      changes.push({ field, added: asked.filter((entry) => !now.includes(entry)), removed: [] })
      continue
    }
    if (!isListDelta(value)) throw new AgentListDeltaError(field, LIST_REFUSED, lists)
    const applied = applyListDelta(field, now, value, normalize)
    if (!applied.change.added.length && !applied.change.removed.length) delete next[field]
    else next[field] = applied.next
    changes.push(applied.change)
  }
  if (!options.creating) assertWithinLimit(changes)
  return { patch: next, changes }
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}
