import { agentDocument, IAgentLinks } from './Catalog.Document'
import { IWidening, wideningsOf } from './Catalog.Widening'
import { IAgent } from './models/Agent.Model'

/**
 * O `patch_agent`: mudar só alguns campos de um agente, pelo caminho normal de escrita. ⛔ O que AMPLIA acesso (pelo
 * MESMO detector do catálogo, sobre o documento canônico do agente) não vale: vira um pedido de permissão pendente,
 * aprovado só na tela — como o `save_permission_rules`.
 *
 * ⚖️ POR CAMPO: o campo cuja troca amplia vai inteiro para o pedido (mesmo a parte dele que restringe); o resto vale já.
 * ⚖️ NA DÚVIDA, TRAVA: se os campos "que não ampliam" ampliarem JUNTOS (a lane nova com as ferramentas que já havia),
 * vai tudo para o pedido.
 */

/** Os campos que o patch muda. Fora: o id, os arquivos (guia própria), os problemas da importação (só "resolvido"). */
export const AGENT_PATCH_FIELDS = [
  'name',
  'soul',
  'systemPrompt',
  'providers',
  'reasoningEfforts',
  'modes',
  'allowedTools',
  'role',
  'adminOnly',
  'projectId',
  'permissions',
  'fallback',
  'terminal',
  'triggers',
  'env',
  'diagnostics',
] as const

export type TAgentPatchField = (typeof AGENT_PATCH_FIELDS)[number]
/** Campo → valor novo; `null` (e o vazio do campo) tira o campo, como no formulário. */
export type TAgentPatch = Partial<Record<TAgentPatchField, unknown>>

export interface IAgentPatchSplit {
  immediate: TAgentPatch
  pending: TAgentPatch
  /** O agente depois do que vale já. */
  agent: IAgent
  /** As ampliações do pedido, sobre `agent`. */
  widenings: IWidening[]
}

/** O vazio de cada campo: gravado assim, some (como o `toAgentInput` da API). */
function emptyValue(field: TAgentPatchField, value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (field === 'adminOnly') return value !== true
  if (field === 'soul') return typeof value === 'string' && !value.trim()
  if (field === 'fallback') return (value as { mode?: string }).mode === 'global'
  if (field === 'env') return typeof value === 'object' && !Object.keys(value as object).length
  if (field === 'triggers' || field === 'permissions' || field === 'reasoningEfforts') return Array.isArray(value) && !value.length
  return false
}

export function applyAgentPatch(agent: IAgent, patch: TAgentPatch): IAgent {
  const next = { ...agent } as Record<string, unknown>
  for (const field of AGENT_PATCH_FIELDS) {
    if (!(field in patch)) continue
    const value = patch[field]
    if (emptyValue(field, value)) delete next[field]
    else next[field] = field === 'soul' ? String(value).trim() : value
  }
  return next as unknown as IAgent
}

/** Os mesmos vínculos dos dois lados: o patch não mexe em recursos nem no contexto inicial (têm ferramenta própria). */
const LINKS: IAgentLinks = { resources: { skills: [], commands: [] }, initialContext: [] }

/** O que a troca do agente amplia: o detector do catálogo sobre o documento canônico (as mesmas chaves do import). */
export function agentWidenings(before: IAgent, after: IAgent): IWidening[] {
  return wideningsOf(agentDocument(before, LINKS), agentDocument(after, LINKS))
}

/** A impressão do agente (o documento canônico): outra na aprovação = mudou desde o pedido. */
export function agentHash(agent: IAgent): string {
  return agentDocument(agent, LINKS).hash
}

export function splitAgentPatch(current: IAgent, patch: TAgentPatch): IAgentPatchSplit {
  const fields = AGENT_PATCH_FIELDS.filter((field) => field in patch)
  const whole = applyAgentPatch(current, patch)
  // A troca inteira não amplia: vale toda, já.
  if (!agentWidenings(current, whole).length) return { immediate: patch, pending: {}, agent: whole, widenings: [] }
  const pick = (chosen: readonly TAgentPatchField[]): TAgentPatch => Object.fromEntries(chosen.map((field) => [field, patch[field]]))
  const widens = (field: TAgentPatchField) => agentWidenings(current, applyAgentPatch(current, pick([field]))).length > 0
  let immediate = fields.filter((field) => !widens(field))
  // ⛔ Juntos ampliam: nada vale já.
  if (agentWidenings(current, applyAgentPatch(current, pick(immediate))).length) immediate = []
  const pending = fields.filter((field) => !immediate.includes(field))
  const agent = applyAgentPatch(current, pick(immediate))
  // ⚖️ Sobre o agente com o que já valeu; vazio (raro: o campo só ampliava sozinho) ainda é pedido, para a pessoa ver.
  const widenings = agentWidenings(agent, applyAgentPatch(agent, pick(pending)))
  return { immediate: pick(immediate), pending: pick(pending), agent, widenings }
}

/** Os campos-lista cujo pedido sai UM ITEM POR ENTRADA acrescentada: a pessoa libera `agent:ana` e recusa `cap:terminal`. */
export const AGENT_PATCH_LIST_FIELDS = ['allowedTools', 'modes'] as const
export type TAgentPatchListField = (typeof AGENT_PATCH_LIST_FIELDS)[number]

export interface IAgentPatchEntries {
  field: string
  add: string[]
}

const isListField = (field: string): field is TAgentPatchListField => (AGENT_PATCH_LIST_FIELDS as readonly string[]).includes(field)

function listOf(agent: IAgent, field: string): string[] {
  const value = (agent as unknown as Record<string, unknown>)[field]
  return Array.isArray(value) ? (value as string[]) : []
}

/** O agente com as entradas acrescentadas ao campo-lista (as que já estão lá não repetem). */
export function withEntries(agent: IAgent, entries: IAgentPatchEntries | undefined): IAgent {
  if (!entries || !isListField(entries.field)) return agent
  const now = listOf(agent, entries.field)
  return applyAgentPatch(agent, { [entries.field]: [...now, ...entries.add.filter((entry) => !now.includes(entry))] })
}

/** O agente que o pedido pede, sobre o agente de AGORA (a aprovação e a tela recalculam por aqui). */
export function requestedAgent(agent: IAgent, request: { patch?: TAgentPatch; entries?: IAgentPatchEntries }): IAgent {
  return withEntries(applyAgentPatch(agent, request.patch ?? {}), request.entries)
}

/** Um item do pedido: um campo inteiro (`patch`) ou uma entrada de lista (`entries`), com o que ele amplia sobre `agent`. */
export interface IAgentPatchItem {
  patch?: TAgentPatch
  entries?: IAgentPatchEntries
  widenings: IWidening[]
}

export interface IAgentPatchItemsSplit {
  immediate: TAgentPatch
  /** O agente depois do que vale já. */
  agent: IAgent
  items: IAgentPatchItem[]
}

/**
 * O `splitAgentPatch` em ITENS: cada campo pendente vira um item; num campo-lista, o que ele TIRA vale já (se tirar
 * não amplia) e cada entrada que ele acrescenta vira um item. ⛔ Cada item conta as próprias ampliações, sobre o agente
 * com o que já valeu — e a aprovação recalcula sobre o de agora (`requestedAgent`).
 */
export function splitAgentPatchItems(current: IAgent, patch: TAgentPatch): IAgentPatchItemsSplit {
  const base = splitAgentPatch(current, patch)
  let agent = base.agent
  const immediate: TAgentPatch = { ...base.immediate }
  const items: IAgentPatchItem[] = []
  const whole = (field: TAgentPatchField, value: unknown) => {
    const single = { [field]: value }
    items.push({ patch: single, widenings: agentWidenings(agent, applyAgentPatch(agent, single)) })
  }
  for (const field of AGENT_PATCH_FIELDS) {
    if (!(field in base.pending)) continue
    const value = base.pending[field]
    if (!isListField(field) || !Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
      whole(field, value)
      continue
    }
    const wanted = value as string[]
    const kept = listOf(agent, field).filter((entry) => wanted.includes(entry))
    if (kept.length !== listOf(agent, field).length) {
      const trimmed = applyAgentPatch(agent, { [field]: kept })
      // ⚖️ Lane vazia não existe, e tirar que amplia (não deveria) não vale já: o campo vai inteiro, como antes.
      if ((field === 'modes' && !kept.length) || agentWidenings(agent, trimmed).length) {
        whole(field, value)
        continue
      }
      agent = trimmed
      immediate[field] = kept
    }
    for (const entry of [...new Set(wanted)].filter((item) => !kept.includes(item))) {
      const entries = { field, add: [entry] }
      items.push({ entries, widenings: agentWidenings(agent, withEntries(agent, entries)) })
    }
  }
  return { immediate, agent, items }
}
