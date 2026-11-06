<script setup lang="ts">
  import { computed, onMounted, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import ConfirmDialog from '@/components/ConfirmDialog.vue'
  import FallbackChain from '@/components/FallbackChain.vue'
  import Icon from '@/components/Icon.vue'
  import MasterDetail from '@/components/MasterDetail.vue'
  import { ApiError } from '@/lib/api'
  import { DEFAULT_COOLDOWN_MINUTES, DEFAULT_SWITCH_ON, MODEL_GROUP_ID, NO_MODEL_GROUP, SWITCH_OPTIONS } from '@/lib/modelGroups'
  import type { IFallbackStep, IModelGroup, IProviderStatus, TSwitchFailure } from '@/lib/types'
  import { useAgentsStore } from '@/stores/agents'
  import { useAuthStore } from '@/stores/auth'
  import { useProvidersStore } from '@/stores/providers'
  import { useSettingsStore } from '@/stores/settings'

  /**
   * Os GRUPOS DE MODELOS (só admin): a ordem de troca quando um modelo falha. ⚖️ A lista inteira vai junto em cada
   * gravação (`PUT /settings` troca `modelGroups` por completo): quem salva um grupo manda os outros como estão.
   */
  const props = defineProps<{ id?: string }>()

  const route = useRoute()
  const router = useRouter()
  const auth = useAuthStore()
  const agents = useAgentsStore()
  const providers = useProvidersStore()
  const settings = useSettingsStore()

  const adding = computed(() => route.name === 'model-group-new')
  const groups = computed(() => settings.current?.modelGroups ?? [])
  const defaultId = computed(() => settings.current?.defaultModelGroup)
  const selected = computed(() => (props.id ? groups.value.find((group) => group.id === props.id) : undefined))

  /** Os agentes que apontam para o grupo (a lista traz `modelGroup` para admin). Ausente = o padrão. */
  const usersOf = (groupId: string) => agents.list.filter((agent) => agent.modelGroup === groupId)
  const countOf = (groupId: string) => usersOf(groupId).length

  const loadError = ref<string>()

  onMounted(async () => {
    if (!auth.isAdmin) return
    void providers.ensure().catch(() => undefined)
    await Promise.all([settings.ensure(), agents.ensure()]).catch((error) => (loadError.value = error instanceof Error ? error.message : String(error)))
  })

  // Os pares que um passo pode ser: os modelos ATIVADOS dos provedores ligados que rodam (assinatura ou chave).
  const runnableProviders = computed(() => providers.list.filter((provider) => provider.enabled && (provider.subscription || provider.credential.configured)))
  watch(
    () => runnableProviders.value.map((provider) => provider.id),
    (ids) => ids.forEach((id) => void providers.models(id).catch(() => undefined)),
    { immediate: true },
  )
  const stepOptions = computed<IFallbackStep[]>(() =>
    runnableProviders.value.flatMap((provider: IProviderStatus) =>
      (providers.catalogs.get(provider.id) ?? []).filter((model) => model.enabled).map((model) => ({ provider: provider.id, model: model.modelId })),
    ),
  )

  /** O rascunho em edição: o grupo aberto, ou um novo com os padrões marcados. */
  const draft = ref({ id: '', name: '', description: '', steps: [] as IFallbackStep[], switchOn: [...DEFAULT_SWITCH_ON] as TSwitchFailure[], cooldown: '' as number | '' })
  const saved = ref<string>()
  const failure = ref<string>()
  const busy = ref(false)
  const removing = ref(false)
  const removeError = ref<string>()

  function fill(group?: IModelGroup) {
    draft.value = {
      id: group?.id ?? '',
      name: group?.name ?? '',
      description: group?.description ?? '',
      steps: (group?.steps ?? []).map((step) => ({ ...step })),
      switchOn: [...(group?.switchOn ?? DEFAULT_SWITCH_ON)],
      cooldown: group?.cooldownMinutes ?? '',
    }
    saved.value = failure.value = undefined
  }
  watch([selected, adding], () => fill(selected.value), { immediate: true })

  /** ⚠️ O 422 do servidor traz o campo e o motivo (provedor desconhecido, id repetido, grupo em uso…): tudo vai para a tela. */
  function describe(error: unknown): string {
    if (error instanceof ApiError && Array.isArray(error.details) && error.details.length)
      return (error.details as Array<{ message?: string }>).map((item) => item.message ?? 'inválido').join('; ')
    return error instanceof Error ? error.message : String(error)
  }

  const idInvalid = computed(() => adding.value && (!MODEL_GROUP_ID.test(draft.value.id) || draft.value.id === NO_MODEL_GROUP))
  const canSave = computed(() => !!draft.value.name.trim() && !idInvalid.value && draft.value.steps.length > 0 && !busy.value)

  function built(): IModelGroup {
    return {
      id: draft.value.id,
      name: draft.value.name.trim(),
      ...(draft.value.description.trim() ? { description: draft.value.description.trim() } : {}),
      steps: draft.value.steps,
      switchOn: draft.value.switchOn,
      ...(draft.value.cooldown !== '' ? { cooldownMinutes: Number(draft.value.cooldown) } : {}),
    }
  }

  async function save() {
    busy.value = true
    saved.value = failure.value = undefined
    try {
      const group = built()
      const next = adding.value ? [...groups.value, group] : groups.value.map((item) => (item.id === group.id ? group : item))
      await settings.save({ modelGroups: next })
      saved.value = 'Sequência salva. Vale no próximo turno.'
      if (adding.value) await router.push(`/model-groups/${group.id}`)
    } catch (error) {
      failure.value = describe(error)
    } finally {
      busy.value = false
    }
  }

  async function makeDefault() {
    if (!selected.value) return
    saved.value = failure.value = undefined
    try {
      await settings.save({ defaultModelGroup: selected.value.id })
      saved.value = 'Agora é a sequência padrão.'
    } catch (error) {
      failure.value = describe(error)
    }
  }

  async function remove() {
    if (!selected.value) return
    busy.value = true
    removeError.value = undefined
    try {
      const rest = groups.value.filter((group) => group.id !== selected.value?.id)
      // ⚠️ Apagar o padrão tira o padrão junto: o servidor recusa um padrão que não é grupo.
      await settings.save({ modelGroups: rest.length ? rest : null, ...(defaultId.value === selected.value.id ? { defaultModelGroup: null } : {}) })
      removing.value = false
      await router.push('/model-groups')
    } catch (error) {
      removeError.value = describe(error)
    } finally {
      busy.value = false
    }
  }

  const toggle = (value: TSwitchFailure) => {
    draft.value.switchOn = draft.value.switchOn.includes(value) ? draft.value.switchOn.filter((item) => item !== value) : [...draft.value.switchOn, value]
  }
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra configura a troca automática de modelo.</p>
  </div>

  <MasterDetail v-else :open="!!id || adding" back-to="/model-groups" back-label="Sequências" :title="adding ? 'Nova sequência' : selected?.name">
    <template #list>
      <header class="flex items-center gap-2 px-4 pt-4 pb-1">
        <h1 class="text-xl font-semibold">Troca automática de modelo</h1>
        <RouterLink to="/model-groups/new" class="ml-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400" title="Nova sequência">
          <Icon name="plus" class="h-5 w-5" />
        </RouterLink>
      </header>
      <p class="px-4 pb-3 text-xs text-zinc-500">
        Uma sequência é uma lista de modelos em ordem. Quando o modelo da conversa falha por um dos motivos marcados, o agente continua no próximo disponível, sem a pessoa
        precisar fazer nada, e fica nele. A conversa aberta sem modelo escolhido já começa no primeiro. A pessoa ainda pode escolher outro modelo na conversa.
      </p>
      <p v-if="loadError" class="px-4 text-sm text-rose-300">{{ loadError }}</p>
      <p v-else-if="settings.current && !groups.length" class="px-4 text-sm text-zinc-500">Nenhuma sequência ainda. Sem sequência, o agente não troca de modelo quando um falha.</p>
      <RouterLink
        v-for="group in groups"
        :key="group.id"
        :to="`/model-groups/${group.id}`"
        class="mx-2 flex items-center gap-3 rounded-xl px-3 py-2"
        :class="group.id === id ? 'bg-emerald-500/15' : 'hover:bg-zinc-800/60'"
      >
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2">
            <span class="truncate text-sm font-medium">{{ group.name }}</span>
            <span v-if="group.id === defaultId" class="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300">padrão</span>
          </span>
          <span class="block truncate text-xs text-zinc-500">
            <code>{{ group.id }}</code>
            · {{ group.steps.length }} {{ group.steps.length === 1 ? 'passo' : 'passos' }} · {{ countOf(group.id) }} {{ countOf(group.id) === 1 ? 'agente' : 'agentes' }}
            <template v-if="group.id === defaultId">+ os sem sequência</template>
          </span>
        </span>
      </RouterLink>
    </template>

    <template #detail>
      <section v-if="adding || selected" :key="adding ? 'new' : selected?.id" class="mx-auto flex max-w-3xl flex-col gap-4">
        <h2 class="text-lg font-semibold">{{ adding ? 'Nova sequência' : selected?.name }}</h2>
        <form class="flex flex-col gap-4" @submit.prevent="save">
          <div class="grid gap-3 sm:grid-cols-2">
            <label v-if="adding" class="field">
              Identificador
              <input v-model="draft.id" required class="input font-mono" placeholder="padrao" aria-label="Identificador" />
              <small class="text-xs" :class="draft.id && idInvalid ? 'text-rose-300' : 'text-zinc-500'">
                2 a 48 letras minúsculas, números ou hífens. Não muda depois. “{{ NO_MODEL_GROUP }}” é reservado.
              </small>
            </label>
            <label class="field" :class="{ 'sm:col-span-2': !adding }">
              Nome
              <input v-model="draft.name" required class="input" aria-label="Nome" />
            </label>
            <label class="field sm:col-span-2">
              Descrição (opcional)
              <input v-model="draft.description" class="input" aria-label="Descrição" />
            </label>
          </div>

          <div class="flex flex-col gap-2">
            <h3 class="text-sm font-medium text-zinc-200">Passos</h3>
            <p class="text-xs text-zinc-500">
              A ordem de uso. A conversa começa no primeiro modelo disponível; quando ele falha, passa para o próximo, e assim por diante. Só aparecem modelos ativados.
            </p>
            <FallbackChain v-model="draft.steps" :options="stepOptions" />
          </div>

          <fieldset class="flex flex-col gap-2">
            <legend class="text-sm font-medium text-zinc-200">Trocar de modelo quando</legend>
            <div class="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-zinc-300">
              <label v-for="option in SWITCH_OPTIONS" :key="option.value" class="flex items-center gap-2" :title="option.hint">
                <input type="checkbox" class="accent-emerald-500" :checked="draft.switchOn.includes(option.value)" @change="toggle(option.value)" />
                {{ option.label }}
              </label>
            </div>
            <small class="text-xs text-zinc-500">Sobrecarga costuma passar sozinha, e credencial recusada pede conserto, não troca: por isso essas duas começam desmarcadas.</small>
          </fieldset>

          <label class="field max-w-sm">
            Rejeitar o modelo que falhou por (minutos)
            <input
              v-model="draft.cooldown"
              type="number"
              min="1"
              max="1440"
              :placeholder="String(DEFAULT_COOLDOWN_MINUTES)"
              class="input tabular-nums"
              aria-label="Tempo de espera"
            />
            <small class="text-xs text-zinc-500">Nesse tempo, o agente pula esse modelo e usa o próximo. Só vale quando o erro não diz quando ele volta; em branco, 15 minutos.</small>
          </label>

          <div v-if="selected" class="flex flex-col gap-1 text-sm">
            <h3 class="font-medium text-zinc-200">Usado por</h3>
            <p v-if="!usersOf(selected.id).length && selected.id !== defaultId" class="text-xs text-zinc-500">Nenhum agente deste projeto.</p>
            <ul v-else class="flex flex-wrap gap-1.5">
              <li v-for="agent in usersOf(selected.id)" :key="agent.id">
                <RouterLink :to="`/agents/${agent.id}`" class="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-200 hover:bg-zinc-700">{{ agent.name }}</RouterLink>
              </li>
              <li v-if="selected.id === defaultId" class="text-xs text-zinc-400">e todos os agentes sem sequência</li>
            </ul>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button type="submit" class="btn btn-primary" :disabled="!canSave">{{ adding ? 'Criar sequência' : 'Salvar' }}</button>
            <button v-if="selected && selected.id !== defaultId" type="button" class="btn" @click="makeDefault">Tornar padrão</button>
            <button v-if="selected" type="button" class="btn btn-ghost ml-auto text-rose-300" @click="removing = true">Apagar</button>
            <RouterLink v-if="adding" to="/model-groups" class="btn btn-ghost">Cancelar</RouterLink>
          </div>
          <p v-if="saved" class="text-sm text-emerald-300">{{ saved }}</p>
          <p v-if="failure" class="text-sm text-rose-300">{{ failure }}</p>
        </form>
      </section>
      <p v-else class="mx-auto max-w-3xl text-sm text-zinc-500">Escolha uma sequência na lista, ou crie uma nova.</p>
    </template>
  </MasterDetail>

  <ConfirmDialog
    :open="removing"
    :title="`Apagar a sequência ${selected?.name ?? ''}?`"
    :message="
      removeError ?? (selected?.id === defaultId ? 'É a sequência padrão: os agentes sem sequência deixam de trocar de modelo.' : 'Agentes que usam esta sequência impedem a exclusão.')
    "
    :busy="busy"
    @confirm="remove"
    @cancel="((removing = false), (removeError = undefined))"
  />
</template>

<style scoped>
  @reference '../style.css';

  .field {
    @apply flex min-w-0 flex-col gap-1 text-sm text-zinc-300;
  }
  .input {
    @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
  }
</style>
