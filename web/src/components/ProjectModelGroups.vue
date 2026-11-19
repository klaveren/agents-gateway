<script setup lang="ts">
  import { computed, onMounted, ref } from 'vue'
  import { api } from '@/lib/api'

  /**
   * 🔁 OS GRUPOS DE FALLBACK DO PROJETO: a ordem em que a conversa tenta os modelos quando um falha (cota, limite, modelo
   * fora). O padrão do projeto vence o do gateway, e o agente que aponta um id procura primeiro aqui. Cada passo é um dos
   * modelos que o projeto recebeu (`models`).
   */
  const props = defineProps<{ projectId: string; models: readonly string[] }>()

  interface IStep {
    provider: string
    model: string
  }
  interface IGroup {
    id: string
    name: string
    steps: IStep[]
  }

  const groups = ref<IGroup[]>([])
  const defaultGroup = ref('')
  const gatewayGroups = ref<Array<{ id: string; name: string }>>([])
  const loading = ref(true)
  const busy = ref(false)
  const error = ref<string>()
  const note = ref<string>()
  /** O modelo escolhido para acrescentar em cada grupo (índice do grupo → chave). */
  const adding = ref<Record<number, string>>({})

  const base = () => `/projects/${encodeURIComponent(props.projectId)}/model-groups`
  const toStep = (item: string): IStep => ({ provider: item.slice(0, item.indexOf('/')), model: item.slice(item.indexOf('/') + 1) })
  const stepKey = (step: IStep) => `${step.provider}/${step.model}`

  async function load() {
    loading.value = true
    error.value = undefined
    try {
      const [mine, gateway] = await Promise.all([
        api<{ groups: IGroup[]; defaultModelGroup?: string }>(base()),
        api<{ groups: Array<{ id: string; name: string }> }>('/model-groups').catch(() => ({ groups: [] })),
      ])
      groups.value = mine.groups.map((group) => ({ id: group.id, name: group.name, steps: [...group.steps] }))
      defaultGroup.value = mine.defaultModelGroup ?? ''
      gatewayGroups.value = gateway.groups
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      loading.value = false
    }
  }
  onMounted(load)

  const options = computed(() => [
    ...groups.value.filter((group) => group.id).map((group) => ({ id: group.id, label: `${group.name || group.id} (projeto)` })),
    ...gatewayGroups.value.filter((group) => !groups.value.some((mine) => mine.id === group.id)).map((group) => ({ id: group.id, label: `${group.name} (gateway)` })),
  ])

  function addGroup() {
    groups.value = [...groups.value, { id: '', name: '', steps: [] }]
  }
  function removeGroup(index: number) {
    groups.value = groups.value.filter((_, position) => position !== index)
  }
  function addStep(index: number) {
    const item = adding.value[index]
    if (!item) return
    const group = groups.value[index]
    if (!group.steps.some((step) => stepKey(step) === item)) group.steps.push(toStep(item))
    adding.value = { ...adding.value, [index]: '' }
  }
  function move(index: number, position: number, by: -1 | 1) {
    const steps = groups.value[index].steps
    const target = position + by
    if (target < 0 || target >= steps.length) return
    ;[steps[position], steps[target]] = [steps[target], steps[position]]
  }

  async function save() {
    busy.value = true
    error.value = undefined
    note.value = undefined
    try {
      await api(base(), { method: 'PUT', body: { groups: groups.value, defaultModelGroup: defaultGroup.value || null } })
      note.value = 'Fallback do projeto salvo.'
      await load()
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }
</script>

<template>
  <section class="flex flex-col gap-3" data-test="project-model-groups">
    <h3 class="text-sm font-medium text-zinc-200">
      Fallback do projeto
      <span class="text-xs font-normal text-zinc-500">(administrador do projeto)</span>
    </h3>
    <p class="text-xs text-zinc-500">A ordem em que a conversa tenta os modelos quando um falha. O padrão do projeto vale no lugar do padrão do gateway.</p>
    <p v-if="loading" class="text-sm text-zinc-500">Carregando…</p>
    <template v-else>
      <label class="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
        Padrão do projeto
        <select v-model="defaultGroup" class="h-9 rounded-lg bg-zinc-800 px-2 text-sm text-zinc-100" data-test="project-default-group">
          <option value="">O do gateway</option>
          <option value="none">Não troca</option>
          <option v-for="option in options" :key="option.id" :value="option.id">{{ option.label }}</option>
        </select>
      </label>

      <div v-for="(group, index) in groups" :key="index" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3" data-test="project-group">
        <div class="flex flex-wrap items-center gap-2">
          <input
            v-model="group.name"
            class="h-9 min-w-0 flex-1 rounded-lg bg-zinc-950 px-3 text-sm text-zinc-100 ring-1 ring-zinc-800"
            placeholder="Nome (ex.: Barato)"
            aria-label="Nome do grupo"
          />
          <input
            v-model="group.id"
            class="h-9 w-40 rounded-lg bg-zinc-950 px-3 font-mono text-sm text-zinc-100 ring-1 ring-zinc-800"
            placeholder="id (ex.: barato)"
            aria-label="Id do grupo"
          />
          <button type="button" class="btn btn-sm btn-ghost text-rose-300" @click="removeGroup(index)">Tirar</button>
        </div>
        <ol class="flex flex-col gap-1">
          <li v-for="(step, position) in group.steps" :key="stepKey(step)" class="flex items-center gap-2 text-sm">
            <span class="w-5 text-right text-xs text-zinc-500">{{ position + 1 }}.</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[13px] text-zinc-200">{{ stepKey(step) }}</span>
            <button type="button" class="btn btn-sm btn-ghost" title="Subir" :disabled="position === 0" @click="move(index, position, -1)">↑</button>
            <button type="button" class="btn btn-sm btn-ghost" title="Descer" :disabled="position === group.steps.length - 1" @click="move(index, position, 1)">↓</button>
            <button type="button" class="btn btn-sm btn-ghost text-rose-300" title="Tirar o passo" @click="group.steps.splice(position, 1)">×</button>
          </li>
        </ol>
        <div class="flex flex-wrap items-center gap-2">
          <select v-model="adding[index]" class="h-9 min-w-0 flex-1 rounded-lg bg-zinc-800 px-2 text-sm text-zinc-100" aria-label="Modelo a acrescentar">
            <option value="">Acrescentar modelo…</option>
            <option v-for="item in models.filter((model) => !group.steps.some((step) => stepKey(step) === model))" :key="item" :value="item">{{ item }}</option>
          </select>
          <button type="button" class="btn btn-sm btn-secondary" :disabled="!adding[index]" @click="addStep(index)">Acrescentar</button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-ghost" data-test="project-group-add" @click="addGroup">+ Grupo</button>
        <button type="button" class="btn btn-primary ml-auto" :disabled="busy" data-test="project-groups-save" @click="save">
          {{ busy ? 'Salvando…' : 'Salvar fallback' }}
        </button>
      </div>
    </template>
    <p v-if="note" class="text-sm text-success-300">{{ note }}</p>
    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
  </section>
</template>
