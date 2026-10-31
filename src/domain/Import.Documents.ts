import { createHash } from 'node:crypto'
import { ICatalogDocument, TCanonicalBody, TCanonicalValue, TCatalogKind } from './Catalog.Document'
import { refOfDocument, withBody } from './Catalog.Import'
import { IImportDraft, IImportDraftOutput, TImportDraftKind } from './Import.Draft'
import { IAgentTarget } from './models/Agent.Model'
import { IPermissionRule } from './Permission.Policy'

/**
 * OS APROVADOS VIRAM DOCUMENTOS CANÔNICOS (`docs/integration/plano-importador.md` §2.4, PR 9), puro: o rascunho
 * aprovado (fonte + operações, já conferido) → o documento do tipo, com os vínculos do `linkCitation`:
 * - doc (spec, ADR, knowledge), skill e command: `attach` → `docIds`; `reference` → `docIds` e `docRefs`;
 * - agente: `initialContext` → o contexto inicial; os triggers aprovados entram NO documento do agente;
 * - rule: sem id legível — a do mesmo título no escopo é atualizada; a nova ganha um id estável (do escopo e do título).
 *
 * ⛔ O TEXTO NÃO MUDA: o corpo é o que as operações produziram da fonte (o servidor conferiu). Daqui não sai nada que o
 * rascunho não traga — o alcance do agente (ferramentas, permissões, skills liberadas) e o modelo chegam prontos de
 * quem chama (`IAgentExtras`), já com a política de "nasce fechado".
 *
 * ⚖️ O `split` vira outro item do mesmo tipo, com os metadados dele. Os vínculos ficam no item principal: o `linkCitation`
 * não diz de que seção é.
 */

/** Um item aprovado do trabalho, com o rascunho em vigor. */
export interface IApprovedEntry {
  key: string
  kind: TImportDraftKind
  /** Trigger: a chave do agente dono. */
  parent?: string
  draft: IImportDraft
}

/** O que o agente leva além do rascunho: o modelo escolhido e o alcance (o tradutor, com o que a pessoa incluiu). */
export interface IAgentExtras {
  /** O modelo escolhido na tela. Ausente: o do agente que já existe (criado sem: o plano recusa). */
  providers?: IAgentTarget[]
  allowedTools: string[]
  permissions: IPermissionRule[]
  /** `resources.skills`: as skills que ele libera (nunca `*` sem confirmação). */
  skills: string[]
  commands: string[]
}

export interface IImportDocumentsInput {
  projectId: string
  entries: readonly IApprovedEntry[]
  /** O documento de hoje (o agente que já existe, para manter o que o rascunho não diz). */
  current: (kind: TCatalogKind, id: string) => ICatalogDocument | undefined
  /** A rule do escopo com este título (a atualizar). */
  ruleByTitle: (title: string, projectId: string | undefined) => ICatalogDocument | undefined
  /** Quantas rules o escopo tem hoje (a nova entra no fim). */
  ruleCount: (projectId: string | undefined) => number
  /** O id no gateway do agente dono de um trigger (o do rascunho aprovado dele, senão o do mapa de ids). */
  agentIdOf: (agentKey: string) => string | undefined
  /** O modelo e o alcance de cada agente aprovado (pela chave). */
  agent: (agentKey: string) => IAgentExtras
}

export interface IImportDocuments {
  documents: ICatalogDocument[]
  /** Item → as referências (`<kind>/<id>`) dos documentos que ele produziu (o trigger produz o do agente). */
  produced: Record<string, string[]>
  /** Os que não viram documento, e por quê. */
  skipped: Array<{ key: string; reason: string }>
}

const DOC_KINDS: readonly TImportDraftKind[] = ['spec', 'adr', 'knowledge']
const RESOURCE_KINDS: readonly TImportDraftKind[] = ['skill', 'command']

/** O id estável de uma rule nova: do escopo e do título (o mesmo pedido dá o mesmo id, e o plano não muda à toa). */
export function importedRuleId(projectId: string | undefined, title: string): string {
  const hex = createHash('sha256')
    .update(`import-rule\0${projectId ?? ''}\0${title}`)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const unique = (values: readonly string[]) => [...new Set(values)]

/** Os vínculos de doc do item principal: anexo inteiro (`attach`) ou por referência (`reference`, também em `docIds`). */
function docLinks(draft: IImportDraft): { docIds: string[]; docRefs?: string[] } {
  const docIds = unique(draft.links.filter((link) => link.link === 'attach' || link.link === 'reference').map((link) => link.target))
  const docRefs = unique(draft.links.filter((link) => link.link === 'reference').map((link) => link.target))
  return { docIds, ...(docRefs.length ? { docRefs } : {}) }
}

const scopeOf = (output: IImportDraftOutput, projectId: string) => (output.meta.scope === 'global' ? undefined : projectId)

export function importDocuments(input: IImportDocumentsInput): IImportDocuments {
  const documents: ICatalogDocument[] = []
  const produced: Record<string, string[]> = {}
  const skipped: IImportDocuments['skipped'] = []
  const add = (key: string, document: ICatalogDocument) => {
    documents.push(document)
    produced[key] = unique([...(produced[key] ?? []), refOfDocument(document)])
  }

  // As rules novas, por escopo: a posição vem na ordem em que o import as grava (pelo id), no fim da lista.
  const newRules: Array<{ key: string; id: string; projectId?: string; output: IImportDraftOutput }> = []

  for (const entry of input.entries) {
    if (entry.kind === 'trigger' || entry.kind === 'agent') continue
    entry.draft.outputs.forEach((output, index) => {
      const projectId = scopeOf(output, input.projectId)
      const links = index === 0 ? docLinks(entry.draft) : { docIds: [] }
      const body = output.fields.body ?? ''
      const scoped: Record<string, string> = projectId ? { projectId } : {}
      if (DOC_KINDS.includes(entry.kind)) {
        const id = output.meta.id
        add(entry.key, withBody({ kind: entry.kind as TCatalogKind, id, ...scoped }, { id, ...scoped, title: output.meta.title, summary: output.meta.summary, body, ...links }))
      } else if (RESOURCE_KINDS.includes(entry.kind)) {
        const id = output.meta.id
        add(entry.key, withBody({ kind: entry.kind as TCatalogKind, id, ...scoped }, { id, ...scoped, description: output.meta.description, body, ...links }))
      } else if (entry.kind === 'rule') {
        const existing = input.ruleByTitle(output.meta.title, projectId)
        if (existing) {
          const id = existing.id
          add(entry.key, withBody({ kind: 'rule', id, ...scoped }, { ...existing.body, id, ...scoped, title: output.meta.title, body }))
        } else newRules.push({ key: entry.key, id: importedRuleId(projectId, output.meta.title), ...scoped, output })
      }
    })
  }
  const byScope = new Map<string, typeof newRules>()
  for (const rule of newRules) byScope.set(rule.projectId ?? '', [...(byScope.get(rule.projectId ?? '') ?? []), rule])
  for (const [scope, rules] of byScope) {
    const projectId = scope || undefined
    const base = input.ruleCount(projectId)
    ;[...rules]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .forEach((rule, index) => {
        const scoped: Record<string, string> = projectId ? { projectId } : {}
        add(
          rule.key,
          withBody(
            { kind: 'rule', id: rule.id, ...scoped },
            { id: rule.id, ...scoped, position: base + index + 1, title: rule.output.meta.title, body: rule.output.fields.body ?? '', enabled: true },
          ),
        )
      })
  }

  // Os triggers, pelo agente dono.
  const triggersOf = new Map<string, IApprovedEntry[]>()
  for (const entry of input.entries.filter((one) => one.kind === 'trigger')) {
    if (!entry.parent) {
      skipped.push({ key: entry.key, reason: 'trigger sem agente dono no inventário' })
      continue
    }
    triggersOf.set(entry.parent, [...(triggersOf.get(entry.parent) ?? []), entry])
  }
  const triggerBody = (entries: readonly IApprovedEntry[]) =>
    [...entries]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((entry) => ({ id: entry.draft.outputs[0].meta.id, when: entry.draft.outputs[0].meta.when, body: entry.draft.outputs[0].fields.body ?? '' }))
  /** Os triggers de antes que o import não traz ficam; os que ele traz (pelo id) são trocados. */
  const mergeTriggers = (current: TCanonicalValue | undefined, incoming: ReadonlyArray<{ id: string; when: string; body: string }>): TCanonicalValue[] => {
    const ids = new Set(incoming.map((trigger) => trigger.id))
    const kept = (Array.isArray(current) ? current : []).filter((trigger) => !ids.has(String((trigger as { id?: unknown }).id)))
    return [...kept, ...incoming]
  }

  const agents = input.entries.filter((entry) => entry.kind === 'agent')
  for (const entry of agents) {
    const output = entry.draft.outputs[0]
    const id = output.meta.id
    const projectId = scopeOf(output, input.projectId)
    const current = input.current('agent', id)
    const extras = input.agent(entry.key)
    const triggers = mergeTriggers(current?.body.triggers, triggerBody(triggersOf.get(entry.key) ?? []))
    triggersOf.delete(entry.key)
    const { permissions: _permissions, triggers: _triggers, resources: _resources, initialContext: _initialContext, soul: _soul, ...kept } = current?.body ?? {}
    const body: TCanonicalBody = {
      ...kept,
      id,
      name: output.meta.name,
      ...(projectId ? { projectId } : {}),
      providers: (extras.providers ?? (current?.body.providers as TCanonicalValue | undefined) ?? []) as TCanonicalValue,
      ...(output.fields.soul ? { soul: output.fields.soul } : {}),
      systemPrompt: output.fields.systemPrompt ?? '',
      modes: (current?.body.modes as TCanonicalValue | undefined) ?? (extras.allowedTools.length ? ['chat', 'agent'] : ['chat']),
      allowedTools: extras.allowedTools,
      ...(extras.permissions.length ? { permissions: extras.permissions as unknown as TCanonicalValue } : {}),
      ...(triggers.length ? { triggers } : {}),
      resources: { skills: extras.skills, commands: extras.commands },
      initialContext: unique(entry.draft.links.filter((link) => link.link === 'initialContext').map((link) => link.target)),
    }
    if (!projectId) delete body.projectId
    add(entry.key, withBody({ kind: 'agent', id, ...(projectId ? { projectId } : {}) }, body))
    for (const trigger of input.entries.filter((one) => one.kind === 'trigger' && one.parent === entry.key)) produced[trigger.key] = [refOfDocument({ kind: 'agent', id })]
  }

  // Trigger cujo agente não vem neste lote: entra no agente que já existe no catálogo; senão fica de fora.
  for (const [parent, entries] of triggersOf) {
    const id = input.agentIdOf(parent)
    const current = id ? input.current('agent', id) : undefined
    if (!id || !current) {
      for (const entry of entries) skipped.push({ key: entry.key, reason: `o agente dono (${parent}) não está aprovado neste lote nem no catálogo` })
      continue
    }
    const body: TCanonicalBody = { ...current.body, triggers: mergeTriggers(current.body.triggers, triggerBody(entries)) }
    const document = withBody(current, body)
    documents.push(document)
    for (const entry of entries) produced[entry.key] = [refOfDocument(document)]
  }
  return { documents, produced, skipped }
}
