import { useAgentCatalogStore } from './agentCatalog'
import { useAgentsStore } from './agents'
import { useBuilderStore } from './builder'
import { useDocsStore } from './docs'
import { useMcpStore } from './mcp'
import { usePermissionsStore } from './permissions'
import { useProjectsStore } from './projects'
import { useResourcesStore } from './resources'
import { useRulesStore } from './rules'

/** O que mudou no catálogo (o `catalog.changed` de `/conversations/events`). */
export interface ICatalogChanged {
  kind: string
  id: string
  projectId?: string
  op: string
}

/** Uma importação grava dezenas de itens seguidos: os avisos esperam um pouco e saem juntos. */
export const CATALOG_SYNC_MS = 400

const DOC_KINDS = new Set(['spec', 'adr', 'knowledge'])
const RESOURCE_KINDS = new Set(['skill', 'command'])

let waiting: ICatalogChanged[] = []
let timer: ReturnType<typeof setTimeout> | undefined

/**
 * O CATÁLOGO MUDOU NO SERVIDOR (outra pessoa, um agente, a importação, um rollback): as stores buscam de novo o que
 * já tinham lido daquele tipo.
 *
 * ⚖️ AS LISTAS são relidas na hora (a tela aberta mostra o novo). O ITEM ABERTO (o detalhe de um doc, recurso ou
 * agente) só é marcado como velho: ele pode estar num formulário, e trocá-lo ali faria a pessoa perder o que está
 * editando — a próxima vez que for aberto vem o novo.
 */
export function catalogChanged(changes: readonly ICatalogChanged[]): void {
  waiting.push(...changes)
  if (timer) return
  timer = setTimeout(() => {
    const batch = waiting
    waiting = []
    timer = undefined
    applyChanges(batch)
  }, CATALOG_SYNC_MS)
}

/** A conexão caiu e voltou: o que mudou no meio não chegou — tudo o que é do catálogo é relido. */
export function catalogResync(): void {
  applyChanges(['agent', 'spec', 'skill', 'rule', 'protocol', 'project', 'project-permissions', 'mcp'].map((kind) => ({ kind, id: '', op: 'update' })))
}

function applyChanges(changes: readonly ICatalogChanged[]): void {
  if (!changes.length) return
  const ids = (kinds: Set<string> | string) => changes.filter((one) => (typeof kinds === 'string' ? one.kind === kinds : kinds.has(one.kind))).map((one) => one.id)
  const quiet = (work: Promise<unknown>) => void work.catch(() => undefined)
  const catalog = useAgentCatalogStore()

  const docs = ids(DOC_KINDS)
  if (docs.length) {
    const store = useDocsStore()
    quiet(store.lists.refreshLoaded())
    for (const id of docs) store.details.markStale(id)
    catalog.initialContexts.markAllStale()
  }
  const resources = ids(RESOURCE_KINDS)
  if (resources.length) {
    const store = useResourcesStore()
    quiet(store.lists.refreshLoaded())
    for (const id of resources) store.details.markStale(id)
    catalog.resources.markAllStale()
  }
  if (ids('rule').length) quiet(useRulesStore().lists.refreshLoaded())
  const agents = ids('agent')
  if (agents.length) {
    const store = useAgentsStore()
    quiet(store.lists.refreshLoaded())
    for (const id of agents) {
      store.details.markStale(id)
      catalog.resources.markStale(id)
    }
    catalog.initialContexts.markAllStale()
  }
  if (ids('protocol').length) quiet(useBuilderStore().protocols.refreshLoaded())
  if (ids('project').length) {
    quiet(useProjectsStore().load())
    catalog.initialContexts.markAllStale()
  }
  if (ids('project-permissions').length) quiet(usePermissionsStore().projects.refreshLoaded())
  if (ids('mcp').length) {
    const store = useMcpStore()
    quiet(store.all.refreshLoaded())
    quiet(store.byProject.refreshLoaded())
    store.toolLists.markAllStale()
    // As ferramentas do gateway (a lista que o formulário do agente usa) incluem as dos MCPs.
    quiet(useAgentsStore().loadTools())
  }
  // O que é MEDIDO sobre o salvo (o tamanho do agente, o `/`) muda com quase tudo: a tela aberta relê.
  catalog.invalidate()
}
