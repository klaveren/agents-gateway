<script setup lang="ts">
  import { computed, onMounted, ref } from 'vue'
  import { api } from '@/lib/api'
  import type { ICatalogModel, IProviderStatus } from '@/lib/types'
  import { useProjectsStore } from '@/stores/projects'
  import { useProvidersStore } from '@/stores/providers'
  import { useUsersStore } from '@/stores/users'
  import ProjectModelGroups from './ProjectModelGroups.vue'
  import ProjectProviders from './ProjectProviders.vue'

  /**
   * 🔐 OS MODELOS DO PROJETO (ver `ModelAccess.Policy` no servidor). Duas camadas, cada uma só restringe a de cima:
   *  - o admin do GATEWAY escolhe o que o projeto recebe (ou "todos os do gateway");
   *  - o admin do PROJETO escolhe, dentro disso, o que cada papel usa (ou "todos os do projeto").
   * A lista de uma pessoa (pela API, `byUser`) vence a do papel e aparece aqui só como contagem.
   */
  const props = defineProps<{ projectId: string; gatewayAdmin: boolean; projectAdmin: boolean }>()

  interface IProjectModelsView {
    allowed: string[] | null
    byRole?: Partial<Record<'admin' | 'member', string[]>>
    byUser?: Record<string, string[]>
    caps?: { monthlyCostUsd?: number; monthlyTokens?: number }
    effective: string[] | null
  }

  const providers = useProvidersStore()
  const view = ref<IProjectModelsView>()
  const groups = ref<Array<{ provider: IProviderStatus; models: ICatalogModel[] }>>([])
  const loading = ref(true)
  const error = ref<string>()
  const note = ref<string>()
  const busy = ref(false)

  /** O rascunho do que o projeto recebe (`null` = todos os do gateway). */
  const allowedDraft = ref<Set<string> | null>(null)
  /** O rascunho de cada papel (`null` = todos os do projeto). */
  const roleDraft = ref<Record<'admin' | 'member', Set<string> | null>>({ admin: null, member: null })

  const ROLES = [
    { id: 'member' as const, label: 'Membros' },
    { id: 'admin' as const, label: 'Administradores do projeto' },
  ]

  const key = (provider: string, model: string) => `${provider}/${model}`
  /** Os modelos que o GATEWAY liga, por provider (a lista que o admin do gateway recorta); os providers de projeto ficam fora. */
  const gatewayGroups = computed(() => groups.value.filter((group) => !group.provider.projectId))
  const gatewayKeys = computed(() => gatewayGroups.value.flatMap((group) => group.models.map((model) => key(group.provider.id, model.modelId))))
  /** Os modelos dos providers DESTE projeto: entram sempre na base dos papéis (não passam pela lista do gateway). */
  const ownKeys = computed(() =>
    groups.value.filter((group) => group.provider.projectId === props.projectId).flatMap((group) => group.models.map((model) => key(group.provider.id, model.modelId))),
  )
  /** O que o projeto recebe agora (no rascunho): a base da lista dos papéis. */
  const projectKeys = computed(() => [...(allowedDraft.value ? gatewayKeys.value.filter((item) => allowedDraft.value!.has(item)) : gatewayKeys.value), ...ownKeys.value])
  /** 💰 O teto do mês do projeto (vazio = sem esse teto). */
  const capCost = ref('')
  const capTokens = ref('')

  async function saveCaps() {
    busy.value = true
    error.value = undefined
    note.value = undefined
    try {
      const number = (value: string) => (value.trim() ? Number(value.replace(',', '.')) : null)
      await api(`/projects/${encodeURIComponent(props.projectId)}/caps`, { method: 'PUT', body: { monthlyCostUsd: number(capCost.value), monthlyTokens: number(capTokens.value) } })
      note.value = 'Teto do projeto salvo.'
      await load()
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }

  /** 👤 A lista de cada pessoa (vence a do papel); ausente = a do papel dela. */
  const userDraft = ref<Record<string, Set<string>>>({})
  const members = ref<Array<{ userId: string; role: 'admin' | 'member'; name: string }>>([])
  const users = useUsersStore()
  const projects = useProjectsStore()

  async function loadMembers() {
    if (!(props.projectAdmin || props.gatewayAdmin)) return
    const [list] = await Promise.all([projects.members(props.projectId).catch(() => []), users.ensure().catch(() => undefined)])
    const names = new Map(users.list.map((user) => [user.id, user.name || user.email]))
    members.value = (Array.isArray(list) ? list : []).map((member) => ({ userId: member.userId, role: member.role, name: names.get(member.userId) ?? member.userId }))
  }

  function toggleOverride(userId: string) {
    const next = { ...userDraft.value }
    if (next[userId]) delete next[userId]
    else next[userId] = new Set(memberDefault(userId))
    userDraft.value = next
  }
  /** O que a pessoa usaria pelo papel (o ponto de partida da lista própria). */
  function memberDefault(userId: string): string[] {
    const role = members.value.find((member) => member.userId === userId)?.role ?? 'member'
    const set = roleDraft.value[role]
    return set ? [...set] : projectKeys.value
  }

  async function load() {
    loading.value = true
    error.value = undefined
    try {
      const [models] = await Promise.all([api<IProjectModelsView>(`/projects/${encodeURIComponent(props.projectId)}/models`), providers.ensure()])
      view.value = models
      const enabled = providers.list.filter((provider) => provider.enabled)
      groups.value = (
        await Promise.all(
          enabled.map(async (provider) => ({ provider, models: (await providers.models(provider.id).catch(() => [])).filter((model) => model.enabled && !model.image?.only) })),
        )
      ).filter((group) => group.models.length)
      allowedDraft.value = models.allowed ? new Set(models.allowed) : null
      capCost.value = models.caps?.monthlyCostUsd !== undefined ? String(models.caps.monthlyCostUsd) : ''
      capTokens.value = models.caps?.monthlyTokens !== undefined ? String(models.caps.monthlyTokens) : ''
      userDraft.value = Object.fromEntries(Object.entries(models.byUser ?? {}).map(([userId, list]) => [userId, new Set(list)]))
      void loadMembers()
      roleDraft.value = {
        admin: models.byRole?.admin ? new Set(models.byRole.admin) : null,
        member: models.byRole?.member ? new Set(models.byRole.member) : null,
      }
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      loading.value = false
    }
  }
  onMounted(load)

  function toggle(set: Set<string> | null, item: string): Set<string> {
    const next = new Set(set ?? [])
    if (next.has(item)) next.delete(item)
    else next.add(item)
    return next
  }

  async function saveAllowed() {
    busy.value = true
    error.value = undefined
    note.value = undefined
    try {
      await api(`/projects/${encodeURIComponent(props.projectId)}/models`, { method: 'PUT', body: { allowed: allowedDraft.value ? [...allowedDraft.value] : null } })
      note.value = 'Modelos do projeto salvos.'
      await load()
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }

  async function saveRoles() {
    busy.value = true
    error.value = undefined
    note.value = undefined
    try {
      const byRole = Object.fromEntries(
        Object.entries(roleDraft.value).flatMap(([role, set]) => (set ? [[role, [...set].filter((item) => projectKeys.value.includes(item))]] : [])),
      )
      const byUser = Object.fromEntries(Object.entries(userDraft.value).map(([userId, set]) => [userId, [...set].filter((item) => projectKeys.value.includes(item))]))
      await api(`/projects/${encodeURIComponent(props.projectId)}/member-models`, { method: 'PUT', body: { byRole, byUser } })
      note.value = 'Modelos por papel e pessoa salvos.'
      await load()
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }
</script>

<template>
  <div class="flex flex-col gap-5" data-test="project-models">
    <p class="text-xs text-zinc-500">
      Quais modelos este projeto usa. O gateway libera ao projeto; o projeto libera a cada papel. Fora da lista, o agente não conversa nesse modelo e o fallback pula para o próximo
      permitido.
    </p>
    <p v-if="loading" class="text-sm text-zinc-500">Carregando…</p>
    <p v-else-if="!groups.length && !projectAdmin" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">
      Nenhum modelo ligado no gateway ainda.
    </p>

    <template v-else>
      <section v-if="gatewayAdmin" class="flex flex-col gap-2" data-test="project-models-gateway">
        <h3 class="text-sm font-medium text-zinc-200">
          O que o projeto recebe
          <span class="text-xs font-normal text-zinc-500">(administrador do gateway)</span>
        </h3>
        <label class="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" :checked="allowedDraft === null" @change="allowedDraft = allowedDraft === null ? new Set(gatewayKeys) : null" />
          Todos os modelos ligados no gateway
        </label>
        <div v-if="allowedDraft !== null" class="flex flex-col gap-3 rounded-xl border border-zinc-800 p-3">
          <div v-for="group in gatewayGroups" :key="group.provider.id" class="flex flex-col gap-1">
            <span class="text-xs font-medium text-zinc-400">{{ group.provider.name }}</span>
            <label v-for="model in group.models" :key="model.modelId" class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                :checked="allowedDraft.has(key(group.provider.id, model.modelId))"
                @change="allowedDraft = toggle(allowedDraft, key(group.provider.id, model.modelId))"
              />
              <span class="font-mono text-[13px] text-zinc-200">{{ model.modelId }}</span>
            </label>
          </div>
        </div>
        <button type="button" class="btn btn-primary self-end" :disabled="busy" data-test="project-models-save" @click="saveAllowed">
          {{ busy ? 'Salvando…' : 'Salvar modelos do projeto' }}
        </button>
      </section>

      <section v-if="projectAdmin || gatewayAdmin" class="flex flex-col gap-3" data-test="project-models-roles">
        <h3 class="text-sm font-medium text-zinc-200">
          O que cada papel usa
          <span class="text-xs font-normal text-zinc-500">(administrador do projeto)</span>
        </h3>
        <div v-for="role in ROLES" :key="role.id" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3">
          <label class="flex items-center gap-2 text-sm text-zinc-200">
            <input type="checkbox" :checked="roleDraft[role.id] === null" @change="roleDraft[role.id] = roleDraft[role.id] === null ? new Set(projectKeys) : null" />
            {{ role.label }}: todos os do projeto
          </label>
          <div v-if="roleDraft[role.id] !== null" class="flex flex-wrap gap-x-4 gap-y-1">
            <label v-for="item in projectKeys" :key="item" class="flex items-center gap-2 text-sm">
              <input type="checkbox" :checked="roleDraft[role.id]!.has(item)" @change="roleDraft[role.id] = toggle(roleDraft[role.id], item)" />
              <span class="font-mono text-[13px] text-zinc-300">{{ item }}</span>
            </label>
          </div>
        </div>
        <div v-if="members.length" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3" data-test="project-models-users">
          <span class="text-sm text-zinc-200">
            Exceções por pessoa
            <span class="text-xs text-zinc-500">(a lista dela vale no lugar da do papel)</span>
          </span>
          <div v-for="member in members" :key="member.userId" class="flex flex-col gap-1" data-test="project-models-user">
            <label class="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" :checked="!!userDraft[member.userId]" @change="toggleOverride(member.userId)" />
              {{ member.name }}
              <span class="text-xs text-zinc-500">{{ member.role === 'admin' ? 'administrador' : 'membro' }}</span>
              <span v-if="!userDraft[member.userId]" class="text-xs text-zinc-500">· como o papel</span>
            </label>
            <div v-if="userDraft[member.userId]" class="flex flex-wrap gap-x-4 gap-y-1 pl-6">
              <label v-for="item in projectKeys" :key="item" class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  :checked="userDraft[member.userId].has(item)"
                  @change="userDraft = { ...userDraft, [member.userId]: toggle(userDraft[member.userId], item) }"
                />
                <span class="font-mono text-[13px] text-zinc-300">{{ item }}</span>
              </label>
            </div>
          </div>
        </div>
        <button type="button" class="btn btn-primary self-end" :disabled="busy" data-test="project-models-roles-save" @click="saveRoles">
          {{ busy ? 'Salvando…' : 'Salvar modelos por papel e pessoa' }}
        </button>
      </section>

      <section v-if="projectAdmin || gatewayAdmin" class="flex flex-col gap-2" data-test="project-caps">
        <h3 class="text-sm font-medium text-zinc-200">
          Teto do mês
          <span class="text-xs font-normal text-zinc-500">(todas as conversas do projeto, com qualquer chave)</span>
        </h3>
        <form class="flex flex-wrap items-center gap-2" @submit.prevent="saveCaps">
          <label class="flex items-center gap-2 text-sm text-zinc-300">
            US$
            <input
              v-model="capCost"
              inputmode="decimal"
              class="h-9 w-28 rounded-lg bg-zinc-950 px-3 text-sm ring-1 ring-zinc-800"
              placeholder="sem teto"
              aria-label="Teto em dólares"
            />
          </label>
          <label class="flex items-center gap-2 text-sm text-zinc-300">
            Tokens
            <input
              v-model="capTokens"
              inputmode="numeric"
              class="h-9 w-36 rounded-lg bg-zinc-950 px-3 text-sm ring-1 ring-zinc-800"
              placeholder="sem teto"
              aria-label="Teto em tokens"
            />
          </label>
          <button type="submit" class="btn btn-sm btn-primary ml-auto" :disabled="busy" data-test="project-caps-save">Salvar teto</button>
        </form>
      </section>

      <ProjectProviders v-if="projectAdmin" :project-id="projectId" @changed="load" />

      <ProjectModelGroups v-if="projectAdmin" :project-id="projectId" :models="projectKeys" />
    </template>

    <p v-if="note" class="text-sm text-success-300">{{ note }}</p>
    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
  </div>
</template>
