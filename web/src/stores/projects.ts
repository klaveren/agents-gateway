import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/lib/api'
import { readLocal, writeLocal } from '@/lib/storage'
import type { IProject, IProjectMember } from '@/lib/types'
import { useAgentsStore } from './agents'
import { useAuthStore } from './auth'
import { useConversationsStore } from './conversations'
import { useThreadStore } from './thread'

const CURRENT_KEY = 'gw.project'

/**
 * Os projetos que a pessoa pode usar e o ATUAL (o seletor do trilho). ⚖️ O atual recorta Conversas, Agentes e
 * a conversa nova; fica no navegador (`localStorage`), e sem escolha vale o primeiro.
 */
export const useProjectsStore = defineStore('projects', () => {
  const list = ref<IProject[]>([])
  const current = ref<string | undefined>(readLocal(CURRENT_KEY) ?? undefined)
  const loaded = ref(false)

  const currentProject = computed(() => list.value.find((project) => project.id === current.value))
  /** O `?project=` das listas: vazio quando não há projeto (gateway sem projetos ainda). */
  const query = computed(() => {
    const out: Record<string, string> = {}
    if (current.value) out.project = current.value
    return out
  })

  async function load(): Promise<void> {
    list.value = await api<IProject[]>('/projects')
    loaded.value = true
    // O guardado sumiu (apagado, ou a pessoa saiu dele): vale o primeiro que ela tem.
    if (!list.value.some((project) => project.id === current.value)) setCurrent(list.value[0]?.id)
  }

  function setCurrent(id: string | undefined): void {
    current.value = id
    writeLocal(CURRENT_KEY, id ?? null)
  }

  /** Troca de projeto: agentes, conversas e o stream de eventos passam a ser os dele. */
  async function select(id: string): Promise<void> {
    if (id === current.value) return
    setCurrent(id)
    const admin = useAuthStore().isAdmin
    useThreadStore().reset()
    const conversations = useConversationsStore()
    conversations.subscribe(admin)
    await Promise.all([
      useAgentsStore()
        .load()
        .catch(() => undefined),
      conversations.load(admin).catch(() => undefined),
    ])
  }

  function reset(): void {
    list.value = []
    loaded.value = false
  }

  async function create(input: { id: string; name: string; description?: string }): Promise<IProject> {
    const created = await api<IProject>('/projects', { method: 'POST', body: input })
    await load()
    return created
  }

  async function update(id: string, change: { name?: string; description?: string }): Promise<void> {
    await api(`/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: change })
    await load()
  }

  async function remove(id: string): Promise<void> {
    await api(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  function members(id: string): Promise<IProjectMember[]> {
    return api<IProjectMember[]>(`/projects/${encodeURIComponent(id)}/members`)
  }

  async function setMembers(id: string, userIds: string[]): Promise<void> {
    await api(`/projects/${encodeURIComponent(id)}/members`, { method: 'PUT', body: { userIds } })
    await load()
  }

  return { list, current, currentProject, query, loaded, load, select, reset, create, update, remove, members, setMembers }
})
