import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { TBuildKind } from '@/lib/builder'
import { keyedResource } from '@/lib/resource'
import type { IConversation } from '@/lib/types'

export interface IAddendum {
  body: string
  updatedAt: string
  updatedBy?: string
}

/** O protocolo de um tipo: o do core (não se edita) e os complementos — o global e, com projeto, o dele. */
export interface IProtocolView {
  core: { kind: TBuildKind; version: string; title: string; body: string }
  addenda: { global?: IAddendum; project?: IAddendum }
}

/**
 * As guias Construir e Protocolo (só admin), por tipo e projeto (a chave é `key(tipo, projeto?)`; sem projeto = a busca
 * sem `project`): as conversas com o construtor (`builds`) e o protocolo (`protocols`).
 *
 * ⚖️ Gravar o complemento devolve o protocolo do escopo gravado: o do projeto troca a chave dele; o global troca a
 * chave sem projeto e o complemento global de todas as do tipo — sem reler.
 */
export const useBuilderStore = defineStore('builder', () => {
  const key = (kind: TBuildKind, project?: string) => JSON.stringify([kind, project ?? ''])
  const parse = (value: string) => JSON.parse(value) as [TBuildKind, string]

  const builds = keyedResource(async (value) => {
    const [kind, project] = parse(value)
    return (await api<{ sessions: IConversation[] }>('/conversations', { query: { builder: kind, limit: 50, ...(project ? { project } : {}) } })).sessions
  })
  const protocols = keyedResource((value) => {
    const [kind, project] = parse(value)
    return api<IProtocolView>(`/protocols/${kind}`, { query: project ? { project } : {} })
  })

  /** A conversa foi apagada (na própria conversa): sai das listas. */
  function dropBuild(id: string): void {
    for (const value of builds.keys()) builds.update(value, (list) => list.filter((build) => build.id !== id))
  }

  async function saveAddendum(kind: TBuildKind, projectId: string | null, body: string): Promise<void> {
    const view = await api<IProtocolView>(`/protocols/${kind}/addendum`, { method: 'PUT', body: { projectId, body } })
    if (projectId) return protocols.set(key(kind, projectId), view)
    const { global } = view.addenda
    for (const value of protocols.keys())
      if (parse(value)[0] === kind)
        protocols.update(value, (current) => ({ ...current, addenda: { ...(global ? { global } : {}), ...(current.addenda.project ? { project: current.addenda.project } : {}) } }))
    protocols.set(key(kind), view)
  }

  /** Restaurou um complemento (o histórico): relê os protocolos do tipo já lidos. */
  async function protocolRestored(kind: TBuildKind): Promise<void> {
    await Promise.all(
      protocols
        .keys()
        .filter((value) => parse(value)[0] === kind)
        .map((value) => protocols.refresh(value).catch(() => undefined)),
    )
  }

  return { builds, protocols, key, dropBuild, saveAddendum, protocolRestored }
})
