import { ResourceFilesStore } from '@infra/workspace/Resource.Files'
import { makeAgents } from './Agents.Factory'
import { guidanceRepository } from './Guidance.Factory'
import { makeProjects } from './Projects.Factory'

let instance: ResourceFilesStore | undefined

/** O depósito e as pastas dos arquivos de recurso: um só, para o catálogo de recursos, os agentes e a API. */
export function makeResourceFiles(): ResourceFilesStore {
  instance ??= new ResourceFilesStore()
  return instance
}

/**
 * No boot: a pasta de cada recurso com arquivos, escrita a partir da lista do catálogo. Cura a pasta que sumiu (banco
 * restaurado, disco trocado) e a que alguém mexeu por fora. A do agente só ganha o que falta. O que não dá fica no log.
 */
export function syncResourceFiles(): void {
  const files = makeResourceFiles()
  const sync = (kind: 'skill' | 'command' | 'agent', id: string, projectId: string | undefined, list: Parameters<typeof files.sync>[3]) => {
    try {
      files.sync(kind, id, projectId, list)
    } catch (error) {
      console.error(`[files] a pasta de ${kind} ${id} não foi escrita: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const repository = guidanceRepository()
  for (const scope of [
    null,
    ...makeProjects()
      .all()
      .map((project) => project.id),
  ])
    for (const resource of repository.resources(scope)) if (resource.files?.length) sync(resource.kind, resource.id, resource.projectId, resource.files)
  // ⚖️ A pasta do agente é dele: o boot só repõe o arquivo da lista que sumiu, nunca apaga o que ele gravou.
  for (const agent of makeAgents().list()) {
    try {
      files.restoreAgent(agent.id, agent.projectId, agent.files ?? [])
    } catch (error) {
      console.error(`[files] a pasta do agente ${agent.id} não foi reposta: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
