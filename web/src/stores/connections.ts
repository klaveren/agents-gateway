import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/lib/api'
import { originLabel } from '@/lib/connection'
import type { IAgentLocalLayerInput, IAgentLocalLayerView } from '@/lib/localLayer'

/** Uma linha do aviso: o item da origem, a última operação e quantas revisões teve desde a versão daqui. */
export interface IConnectionChange {
  kind: string
  id: string
  op: string
  revisions: number
  at: string
  by: string
}

/** 🔌 Um projeto conectado: a cópia só de leitura do projeto de outro gateway (a origem). ⛔ Nunca o token. */
export interface IProjectConnection {
  projectId: string
  url: string
  remoteProjectId: string
  syncedVersion: number
  latestVersion: number
  /** Um aviso por projeto, sempre para a ÚLTIMA versão. */
  updateAvailable: boolean
  state: 'ok' | 'offline' | 'unauthorized'
  lastError?: string
  changes: IConnectionChange[]
  changesTruncated?: boolean
  skipped: Array<{ ref: string; message: string }>
  secrets: Array<{ kind: string; id: string; name: string; description?: string }>
  modelMap: Record<string, string>
  lastCheckedAt?: string
  lastSyncedAt?: string
}

export interface ISyncResult {
  version: number
  applied: number
  removed: string[]
  skipped: Array<{ ref: string; message: string }>
}

/** Quanto a tela espera para perguntar de novo (o vigia do servidor é quem fala com a origem). */
const REFRESH_MS = 60_000

/**
 * Os projetos conectados que a pessoa administra, para o aviso da tela e o card do projeto. A lista é relida de minuto em
 * minuto enquanto alguém a acompanha (`follow`): quem fala com a origem é o servidor, a tela só lê o que ele já sabe.
 */
export const useConnectionsStore = defineStore('connections', () => {
  const list = ref<IProjectConnection[]>([])
  let timer: ReturnType<typeof setInterval> | undefined

  const byProject = computed(() => new Map(list.value.map((connection) => [connection.projectId, connection])))
  /** O que pede atenção no aviso global: atualização disponível ou conexão que parou de valer. */
  const attention = computed(() => list.value.filter((connection) => connection.updateAvailable || connection.state === 'unauthorized'))

  /** 🔌 A origem do projeto conectado (o que a faixa mostra), ou nada: o item desse projeto é só leitura aqui. */
  function originOf(projectId: string | undefined): string | undefined {
    const connection = projectId ? byProject.value.get(projectId) : undefined
    return connection ? originLabel(connection.url) : undefined
  }

  /** Muda a cada `reset`: a leitura que estava no ar quando a conta saiu não escreve na lista de quem entrou. */
  let epoch = 0

  async function refresh(): Promise<void> {
    const asked = epoch
    const read = await api<IProjectConnection[]>('/connections')
    if (asked === epoch) list.value = read
  }

  /** ⛔ Na saída ou na troca de conta: as conexões (endereço da origem, avisos) são de quem estava logado. */
  function reset(): void {
    epoch += 1
    list.value = []
  }

  function follow(): void {
    if (timer) return
    void refresh().catch(() => undefined)
    timer = setInterval(() => void refresh().catch(() => undefined), REFRESH_MS)
  }

  function put(connection: IProjectConnection): void {
    list.value = [...list.value.filter((item) => item.projectId !== connection.projectId), connection].sort((a, b) => a.projectId.localeCompare(b.projectId))
  }

  async function connect(input: { url: string; projectId: string; token: string }): Promise<IProjectConnection> {
    const connection = await api<IProjectConnection>('/connections', { method: 'POST', body: input })
    put(connection)
    return connection
  }

  async function check(projectId: string): Promise<void> {
    put(await api<IProjectConnection>(`/connections/${encodeURIComponent(projectId)}/check`, { method: 'POST' }))
  }

  async function sync(projectId: string): Promise<ISyncResult> {
    const { result, connection } = await api<{ result: ISyncResult; connection: IProjectConnection }>(`/connections/${encodeURIComponent(projectId)}/sync`, { method: 'POST' })
    put(connection)
    return result
  }

  async function replaceToken(projectId: string, token: string): Promise<void> {
    put(await api<IProjectConnection>(`/connections/${encodeURIComponent(projectId)}/token`, { method: 'PUT', body: { token } }))
  }

  async function disconnect(projectId: string): Promise<void> {
    await api(`/connections/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
    list.value = list.value.filter((item) => item.projectId !== projectId)
  }

  /** 🔌 A camada local de um agente do projeto conectado: o que esta máquina acrescenta ao que veio da origem. */
  const localPath = (projectId: string, agentId: string) => `/connections/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/local`

  function readLocal(projectId: string, agentId: string): Promise<IAgentLocalLayerView> {
    return api<IAgentLocalLayerView>(localPath(projectId, agentId))
  }

  function saveLocal(projectId: string, agentId: string, layer: IAgentLocalLayerInput): Promise<IAgentLocalLayerView> {
    return api<IAgentLocalLayerView>(localPath(projectId, agentId), { method: 'PUT', body: layer })
  }

  function removeLocal(projectId: string, agentId: string): Promise<IAgentLocalLayerView> {
    return api<IAgentLocalLayerView>(localPath(projectId, agentId), { method: 'DELETE' })
  }

  return { list, byProject, attention, originOf, refresh, reset, follow, connect, check, sync, replaceToken, disconnect, readLocal, saveLocal, removeLocal }
})
