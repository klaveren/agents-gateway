<script setup lang="ts">
  import { computed, onMounted, ref, watch } from 'vue'
  import FallbackChain from './FallbackChain.vue'
  import { api, ApiError } from '@/lib/api'
  import { DEFAULT_COOLDOWN_MINUTES, DEFAULT_SWITCH_ON, NO_MODEL_GROUP, SWITCH_OPTIONS } from '@/lib/modelGroups'
  import type { IFallbackStep, IModelGroup, IProviderStatus, TSwitchFailure } from '@/lib/types'
  import { useAgentsStore } from '@/stores/agents'
  import { useAuthStore } from '@/stores/auth'
  import { useProvidersStore } from '@/stores/providers'
  import { useSettingsStore } from '@/stores/settings'

  /**
   * O GRUPO DE MODELOS do agente, na guia Modelos: a escolha (vai com o Salvar do agente) e, para quem administra, os
   * modelos do grupo escolhido, na ordem, editados aqui mesmo. ⚖️ O grupo é das Configurações e vale para todo agente que
   * o usa: tem o próprio "Salvar grupo", que grava só ele (`PUT /settings` com a lista inteira, os outros como estão).
   * ⚠️ Mora DENTRO do formulário do agente: nada aqui submete.
   */
  const choice = defineModel<string>({ required: true })

  const auth = useAuthStore()
  const agents = useAgentsStore()
  const providers = useProvidersStore()
  const settings = useSettingsStore()

  // Os provedores (os passos possíveis) e a lista de agentes (quantos usam o grupo): só quem administra edita o grupo.
  onMounted(() => {
    if (!auth.isAdmin) return
    void providers.ensure().catch(() => undefined)
    void agents.ensure().catch(() => undefined)
  })

  /** Quem só administra o projeto não lê as Configurações: as sequências vêm da leitura própria delas (`/model-groups`). */
  const readOnly = ref<{ groups: IModelGroup[]; defaultModelGroup?: string }>()
  onMounted(() => {
    if (!auth.isAdmin) void api<{ groups: IModelGroup[]; defaultModelGroup?: string }>('/model-groups').then((found) => (readOnly.value = found), () => undefined)
  })
  const groups = computed(() => (auth.isAdmin ? (settings.current?.modelGroups ?? []) : (readOnly.value?.groups ?? [])))
  const defaultId = computed(() => (auth.isAdmin ? settings.current?.defaultModelGroup : readOnly.value?.defaultModelGroup))
  const defaultName = computed(() => groups.value.find((group) => group.id === defaultId.value)?.name ?? 'nenhum')
  /** O grupo que vale para o agente: o escolhido, ou o padrão quando a escolha é "Padrão". */
  const effective = computed(() => {
    if (choice.value === NO_MODEL_GROUP) return undefined
    const id = choice.value || defaultId.value
    return id ? groups.value.find((group) => group.id === id) : undefined
  })
  const usersOf = (groupId: string) => agents.list.filter((agent) => agent.modelGroup === groupId).length

  // Os pares que um passo pode ser: os modelos ATIVADOS dos provedores ligados que rodam (assinatura ou chave).
  const runnable = computed(() => providers.list.filter((provider) => provider.enabled && (provider.subscription || provider.credential.configured)))
  watch(
    () => (auth.isAdmin ? runnable.value.map((provider) => provider.id) : []),
    (ids) => ids.forEach((id) => void providers.models(id).catch(() => undefined)),
    { immediate: true },
  )
  const stepOptions = computed<IFallbackStep[]>(() =>
    runnable.value.flatMap((provider: IProviderStatus) =>
      (providers.catalogs.get(provider.id) ?? []).filter((model) => model.enabled).map((model) => ({ provider: provider.id, model: model.modelId })),
    ),
  )

  const draft = ref({ steps: [] as IFallbackStep[], switchOn: [...DEFAULT_SWITCH_ON] as TSwitchFailure[], cooldown: '' as number | '' })
  const note = ref<string>()
  const failure = ref<string>()
  const busy = ref(false)
  function fill(group?: IModelGroup) {
    draft.value = {
      steps: (group?.steps ?? []).map((step) => ({ ...step })),
      switchOn: [...(group?.switchOn ?? DEFAULT_SWITCH_ON)],
      cooldown: group?.cooldownMinutes ?? '',
    }
    note.value = failure.value = undefined
  }
  watch(effective, (group) => fill(group), { immediate: true })

  const dirty = computed(() => {
    const group = effective.value
    if (!group) return false
    return (
      JSON.stringify(draft.value.steps) !== JSON.stringify(group.steps) ||
      JSON.stringify([...draft.value.switchOn].sort()) !== JSON.stringify([...(group.switchOn ?? DEFAULT_SWITCH_ON)].sort()) ||
      (draft.value.cooldown === '' ? undefined : Number(draft.value.cooldown)) !== group.cooldownMinutes
    )
  })

  function toggle(value: TSwitchFailure) {
    draft.value.switchOn = draft.value.switchOn.includes(value) ? draft.value.switchOn.filter((item) => item !== value) : [...draft.value.switchOn, value]
  }

  function describe(error: unknown): string {
    if (error instanceof ApiError && Array.isArray(error.details) && error.details.length)
      return (error.details as Array<{ message?: string }>).map((item) => item.message ?? 'inválido').join('; ')
    return error instanceof Error ? error.message : String(error)
  }

  /** O "Salvar agente" grava a sequência junto (e a confirmação avisa quantos agentes ela alcança): lança se falhar. */
  async function commit(): Promise<void> {
    if (!dirty.value) return
    await saveGroup()
    if (failure.value) throw new Error(failure.value)
  }
  defineExpose({ dirty, commit, name: computed(() => effective.value?.name), users: computed(() => (effective.value ? usersOf(effective.value.id) : 0)) })

  async function saveGroup() {
    const group = effective.value
    if (!group || !draft.value.steps.length) return
    busy.value = true
    note.value = failure.value = undefined
    try {
      const next: IModelGroup = {
        ...group,
        steps: draft.value.steps,
        switchOn: draft.value.switchOn,
        ...(draft.value.cooldown !== '' ? { cooldownMinutes: Number(draft.value.cooldown) } : {}),
      }
      if (draft.value.cooldown === '') delete next.cooldownMinutes
      await settings.save({ modelGroups: groups.value.map((item) => (item.id === group.id ? next : item)) })
      note.value = 'Sequência salva. Vale no próximo turno, para todos os agentes que a usam.'
    } catch (error) {
      failure.value = describe(error)
    } finally {
      busy.value = false
    }
  }
</script>

<template>
  <div class="flex flex-col gap-3">
    <section class="card">
      <header>
        <h3>Qual sequência</h3>
        <span class="count">vai com o Salvar do agente</span>
      </header>
      <div class="flex flex-col gap-2 p-3">
        <p class="hint">
          Quando o modelo da conversa falha (cota, limite de uso…), o agente continua no próximo modelo da sequência, sem a pessoa precisar fazer nada, e fica nele. A conversa aberta
          sem modelo escolhido já começa no primeiro. A pessoa ainda pode escolher outro modelo na conversa.
        </p>
        <select v-model="choice" aria-label="Sequência de troca" class="h-9 max-w-xs rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-sm">
          <option value="">Padrão ({{ defaultName }})</option>
          <option :value="NO_MODEL_GROUP">Nenhum — não troca de modelo</option>
          <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
          <option v-if="choice && choice !== NO_MODEL_GROUP && !groups.some((group) => group.id === choice)" :value="choice">{{ choice }}</option>
        </select>
      </div>
    </section>

    <section v-if="effective && auth.isAdmin" class="card" data-test="group-models">
      <header>
        <h3>Modelos da sequência {{ effective.name }}</h3>
        <span class="count">
          {{ effective.id === defaultId ? 'a padrão: vale para os agentes sem sequência' : '' }}
          {{ usersOf(effective.id) ? `· usado por ${usersOf(effective.id)} ${usersOf(effective.id) === 1 ? 'agente' : 'agentes'}` : '' }}
        </span>
        <RouterLink to="/model-groups/new" class="ml-auto shrink-0 text-xs text-emerald-300 underline">Nova sequência</RouterLink>
      </header>
      <div class="flex flex-col gap-4 p-3">
        <div class="flex flex-col gap-2">
          <p class="hint">A ordem de uso. A conversa começa no primeiro modelo disponível; quando ele falha, passa para o próximo, e assim por diante. Só aparecem modelos ativados.</p>
          <FallbackChain v-model="draft.steps" :options="stepOptions" />
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-sm text-zinc-300">Trocar de modelo quando</span>
          <div class="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-zinc-300">
            <label v-for="option in SWITCH_OPTIONS" :key="option.value" class="flex items-center gap-2" :title="option.hint">
              <input type="checkbox" class="accent-emerald-500" :checked="draft.switchOn.includes(option.value)" @change="toggle(option.value)" />
              {{ option.label }}
            </label>
          </div>
          <p class="hint">Sobrecarga costuma passar sozinha, e credencial recusada pede conserto, não troca: por isso essas duas começam desmarcadas.</p>
        </div>
        <label class="flex max-w-sm flex-col gap-1 text-sm text-zinc-300">
          Rejeitar o modelo que falhou por (minutos)
          <input
            v-model="draft.cooldown"
            type="number"
            min="1"
            max="1440"
            :placeholder="String(DEFAULT_COOLDOWN_MINUTES)"
            class="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 tabular-nums outline-none focus:border-emerald-500/60"
            aria-label="Tempo de espera"
            @keydown.enter.prevent
          />
          <small class="hint">Nesse tempo, o agente pula esse modelo e usa o próximo. Só vale quando o erro não diz quando ele volta; em branco, 15 minutos.</small>
        </label>
        <div class="flex flex-wrap items-center gap-2">
          <span v-if="dirty" class="text-xs text-amber-300">Mudança não salva: o "Salvar agente" grava a sequência, que vale para todos os agentes que a usam.</span>
          <span v-if="note" class="text-xs text-emerald-300">{{ note }}</span>
          <span v-if="failure" class="text-xs text-rose-300">{{ failure }}</span>
        </div>
      </div>
    </section>
    <p v-else-if="choice === NO_MODEL_GROUP" class="hint">Sem troca automática, o agente fica no modelo escolhido mesmo quando ele falha.</p>
    <p v-else-if="!effective" class="hint">
      Nenhuma sequência padrão ainda.
      <RouterLink v-if="auth.isAdmin" to="/model-groups/new" class="text-emerald-300 underline">Crie uma sequência</RouterLink>
    </p>
  </div>
</template>

<style scoped>
  @reference '../style.css';

  .card {
    @apply rounded-xl border border-zinc-800;
  }
  .card > header {
    @apply flex items-baseline gap-2 border-b border-zinc-800 px-3 py-2;
  }
  .card h3 {
    @apply text-sm font-medium text-zinc-200;
  }
  .card .count,
  .hint {
    @apply text-xs text-zinc-500;
  }
</style>
