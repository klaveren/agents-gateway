import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { IAgentFootprint, IAgentResources, IInitialContext } from '@/lib/types'
import { useSlashResourcesStore } from './slashResources'

/** O dono de um contexto inicial: o projeto ou o agente (a rota `/<dono>/:id/initial-context`). */
export type TContextOwner = 'projects' | 'agents'

/**
 * O que o catálogo dá a cada agente (só admin): os recursos liberados (`resources`, por agente), o contexto inicial do
 * projeto e o do agente (`initialContexts`), e o que é MEDIDO sobre o salvo — o tamanho (`footprints`), por agente e
 * projeto. O `/` da conversa mora em `slashResources` (guardado, sem reler a cada troca de conversa).
 *
 * ⚖️ A revisão vai na chave do que é medido: uma gravação no catálogo (rule, documento, recurso, contexto) a avança e
 * descarta as medidas — a tela aberta relê na hora (a chave dela mudou), as outras só quando abrirem. Documento gravado
 * também avança a dos contextos iniciais (o peso de cada spec vem neles).
 */
export const useAgentCatalogStore = defineStore('agentCatalog', () => {
  const revision = ref(0)
  const contextRevision = ref(0)
  /** A chave sem a revisão (`<revisão>~<resto>`). */
  const rest = (key: string) => key.slice(key.indexOf('~') + 1)
  const pair = (key: string) => JSON.parse(rest(key)) as [string, string]
  const agentPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}`

  const footprints = keyedResource((key) => {
    const [agentId, project] = pair(key)
    return api<IAgentFootprint>(`${agentPath(agentId)}/footprint`, { query: project ? { project } : {} })
  })
  const resources = keyedResource((agentId) => api<IAgentResources>(`${agentPath(agentId)}/resources`))
  const initialContexts = keyedResource((key) => {
    const [owner, id] = pair(key)
    return api<IInitialContext>(`/${owner}/${encodeURIComponent(id)}/initial-context`)
  })

  /** O tamanho do agente; `project` só no agente global (o do agente de projeto é o dele). */
  const footprintKey = (agentId: string, project?: string) => `${revision.value}~${JSON.stringify([agentId, project ?? ''])}`
  const contextKey = (owner: TContextOwner, id: string) => `${contextRevision.value}~${JSON.stringify([owner, id])}`

  /** O catálogo (ou o agente salvo) mudou: o que é medido fica velho. */
  function invalidate(): void {
    revision.value++
    footprints.clear()
  }

  /** Um documento mudou: o peso das specs nos contextos iniciais também. */
  function docsChanged(): void {
    contextRevision.value++
    initialContexts.clear()
    invalidate()
    commandsChanged()
  }

  /** O que o `/` oferece mudou (skill, command, documento, liberação do agente). */
  function commandsChanged(): void {
    useSlashResourcesStore().changed()
  }

  async function saveResources(agentId: string, selected: IAgentResources): Promise<IAgentResources> {
    const saved = await api<IAgentResources>(`${agentPath(agentId)}/resources`, { method: 'PUT', body: selected })
    resources.set(agentId, saved)
    invalidate()
    commandsChanged()
    return saved
  }

  /** Troca a lista INTEIRA (a ordem dada é a do prompt). */
  async function saveContext(owner: TContextOwner, id: string, docIds: string[]): Promise<IInitialContext> {
    const saved = await api<IInitialContext>(`/${owner}/${encodeURIComponent(id)}/initial-context`, { method: 'PUT', body: { docIds } })
    initialContexts.set(contextKey(owner, id), saved)
    invalidate()
    return saved
  }

  return { footprints, resources, initialContexts, footprintKey, contextKey, invalidate, commandsChanged, docsChanged, saveResources, saveContext }
})
