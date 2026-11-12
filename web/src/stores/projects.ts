import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/lib/api'
import { lite, LITE_PROJECT } from '@/lib/edition'
import { keyedResource } from '@/lib/resource'
import { readLocal, writeLocal } from '@/lib/storage'
import type { IProject, IProjectMcpVar, IProjectMember, TProjectRole } from '@/lib/types'
import { useAgentsStore } from './agents'
import { useAuthStore } from './auth'
import { useConversationsStore } from './conversations'
import { useThreadStore } from './thread'

const CURRENT_KEY = 'gw.project'

/**
 * Os projetos que a pessoa pode usar e o ATUAL (o seletor do trilho). ⚖️ O atual recorta Conversas, Agentes e
 * a conversa nova; fica no navegador (`localStorage`), e sem escolha vale o primeiro. Os membros de cada projeto
 * (só admin) por projeto (`memberLists`). A gravação põe a resposta do servidor na lista, sem reler.
 */
export const useProjectsStore = defineStore('projects', () => {
  const list = ref<IProject[]>([])
  const current = ref<string | undefined>(readLocal(CURRENT_KEY) ?? undefined)
  const loaded = ref(false)

  const currentProject = computed(() => list.value.find((project) => project.id === current.value))
  /** ⛔ Administra o projeto ATUAL: o catálogo, os agentes e as regras dele (o admin do gateway só se for admin dele). */
  const manages = computed(() => currentProject.value?.role === 'admin')
  /** Vê as conversas de todos: o admin do gateway, ou quem administra o projeto atual. */
  const seesAll = computed(() => useAuthStore().isAdmin || manages.value)
  /** Administra algum projeto (a guia Projetos, para cuidar dos membros). */
  const managesAny = computed(() => list.value.some((project) => project.role === 'admin'))
  /** O `?project=` das listas: vazio quando não há projeto (gateway sem projetos ainda). */
  const query = computed(() => {
    const out: Record<string, string> = {}
    if (current.value) out.project = current.value
    return out
  })

  /** A leitura em curso: quem pede enquanto ela não volta (a tela e o início do app, juntos) espera a mesma. */
  let loading: Promise<void> | undefined

  function load(): Promise<void> {
    loading ??= (async () => {
      put(await api<IProject[]>('/projects'))
      loaded.value = true
    })().finally(() => (loading = undefined))
    return loading
  }

  /** A lista já lida, ou lida uma vez. */
  function ensure(): Promise<void> {
    return loaded.value ? Promise.resolve() : load()
  }

  function put(projects: IProject[]): void {
    list.value = projects
    // A lite fica no projeto padrão, quando a pessoa está nele.
    if (lite.value && list.value.some((project) => project.id === LITE_PROJECT)) return setCurrent(LITE_PROJECT)
    // O guardado sumiu (apagado, ou a pessoa saiu dele): vale o primeiro que ela tem.
    if (!list.value.some((project) => project.id === current.value)) setCurrent(list.value[0]?.id)
  }

  const memberLists = keyedResource((id) => api<IProjectMember[]>(`/projects/${encodeURIComponent(id)}/members`))

  function setCurrent(id: string | undefined): void {
    current.value = id
    writeLocal(CURRENT_KEY, id ?? null)
  }

  /** Troca de projeto: agentes, conversas e o stream de eventos passam a ser os dele. */
  async function select(id: string): Promise<void> {
    if (id === current.value) return
    setCurrent(id)
    const admin = seesAll.value
    useThreadStore().reset()
    const conversations = useConversationsStore()
    conversations.subscribe(admin)
    // ⚖️ Trocar de projeto relê os agentes dele (o `unavailable` muda por fora); a lista guardada aparece enquanto isso.
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
    memberLists.clear()
  }

  /** Troca (ou acrescenta) o projeto na lista, como o servidor o devolveu. */
  function putOne(project: IProject): void {
    put(list.value.some((one) => one.id === project.id) ? list.value.map((one) => (one.id === project.id ? project : one)) : [...list.value, project])
  }

  async function create(input: { id: string; name: string; description?: string }): Promise<IProject> {
    const created = await api<IProject>('/projects', { method: 'POST', body: input })
    putOne(created)
    return created
  }

  async function update(id: string, change: { name?: string; description?: string; env?: Record<string, string>; mcpEnv?: IProjectMcpVar[] }): Promise<void> {
    putOne(await api<IProject>(`/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: change }))
  }

  async function remove(id: string): Promise<void> {
    await api(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
    put(list.value.filter((one) => one.id !== id))
    memberLists.drop(id)
  }

  /** Os membros do projeto: os guardados, ou lidos uma vez. */
  function members(id: string): Promise<IProjectMember[]> {
    return memberLists.ensure(id)
  }

  /** A lista INTEIRA de membros, com o papel de cada um (o servidor exige ao menos um administrador). */
  async function setMembers(id: string, members: Array<{ userId: string; role: TProjectRole }>): Promise<void> {
    const saved = await api<IProjectMember[]>(`/projects/${encodeURIComponent(id)}/members`, { method: 'PUT', body: { members } })
    memberLists.set(id, saved)
    // A contagem na lista é a mesma coisa: troca aqui, sem reler.
    list.value = list.value.map((one) => (one.id === id ? { ...one, members: saved.length } : one))
  }

  return { list, current, currentProject, manages, managesAny, seesAll, query, loaded, load, ensure, select, reset, create, update, remove, memberLists, members, setMembers }
})
