<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useProvidersStore } from '@/stores/providers'
  import ConfirmDialog from './ConfirmDialog.vue'
  import ProviderModels from './ProviderModels.vue'

  /**
   * 🔐 OS PROVIDERS DO PROJETO (fase 2 dos modelos por projeto): a chave é do projeto e paga as conversas dele. Só provedores
   * conhecidos, com a URL fixa (a livre mandaria a chave para qualquer lugar). Rodam só em conversa deste projeto; os
   * modelos deles não passam pela lista do gateway — a do papel, sim.
   */
  const props = defineProps<{ projectId: string }>()
  const emit = defineEmits<{ changed: [] }>()
  const providers = useProvidersStore()

  const KINDS = [
    { id: 'anthropic' as const, label: 'Anthropic' },
    { id: 'openai' as const, label: 'OpenAI' },
    { id: 'openrouter' as const, label: 'OpenRouter' },
  ]

  const mine = computed(() => providers.list.filter((provider) => provider.projectId === props.projectId))
  const free = computed(() => KINDS.filter((kind) => !mine.value.some((provider) => provider.id === `${props.projectId}--${kind.id}`)))
  const kind = ref<(typeof KINDS)[number]['id'] | ''>('')
  const key = ref('')
  const keys = ref<Record<string, string>>({})
  const busy = ref(false)
  const error = ref<string>()
  const note = ref<string>()
  const removing = ref<string>()

  async function run(work: () => Promise<string | undefined>) {
    busy.value = true
    error.value = undefined
    note.value = undefined
    try {
      note.value = await work()
      emit('changed')
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      busy.value = false
    }
  }

  const add = () =>
    run(async () => {
      if (!kind.value) return undefined
      await providers.createForProject(props.projectId, { kind: kind.value, ...(key.value.trim() ? { key: key.value.trim() } : {}) })
      kind.value = ''
      key.value = ''
      return 'Provider do projeto criado. Atualize a lista de modelos e ligue os que o projeto vai usar.'
    })

  const saveKey = (id: string) =>
    run(async () => {
      const value = keys.value[id]?.trim()
      if (!value) return undefined
      await providers.save(id, value)
      keys.value = { ...keys.value, [id]: '' }
      return 'Chave salva.'
    })

  async function remove() {
    const id = removing.value
    removing.value = undefined
    if (id) await run(async () => (await providers.remove(id), 'Provider do projeto apagado.'))
  }
</script>

<template>
  <section class="flex flex-col gap-3" data-test="project-providers">
    <h3 class="text-sm font-medium text-zinc-200">
      Providers do projeto
      <span class="text-xs font-normal text-zinc-500">(chave do projeto)</span>
    </h3>
    <p class="text-xs text-zinc-500">A chave é do projeto e paga as conversas dele. Só roda neste projeto; os modelos dele valem para os papéis conforme a lista de cada um.</p>

    <div v-for="provider in mine" :key="provider.id" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3" data-test="project-provider">
      <div class="flex flex-wrap items-center gap-2">
        <strong class="text-sm text-zinc-100">{{ provider.name }}</strong>
        <span class="text-xs text-zinc-500">{{ provider.baseUrl }}</span>
        <span class="ml-auto text-xs" :class="provider.credential.configured ? 'text-success-300' : 'text-amber-300'">
          {{ provider.credential.configured ? 'Chave configurada' : 'Sem chave' }}
        </span>
      </div>
      <form class="flex flex-wrap items-center gap-2" @submit.prevent="saveKey(provider.id)">
        <input
          v-model="keys[provider.id]"
          type="password"
          autocomplete="off"
          class="h-9 min-w-0 flex-1 rounded-lg bg-zinc-950 px-3 font-mono text-sm text-zinc-100 ring-1 ring-zinc-800"
          :placeholder="provider.credential.configured ? 'Trocar a chave' : 'Colar a chave'"
          aria-label="Chave do provider"
        />
        <button type="submit" class="btn btn-sm btn-secondary" :disabled="busy || !keys[provider.id]?.trim()">Salvar chave</button>
        <button type="button" class="btn btn-sm btn-danger" :disabled="busy" @click="removing = provider.id">Apagar</button>
      </form>
      <ProviderModels :provider="provider" />
    </div>

    <form v-if="free.length" class="flex flex-wrap items-center gap-2" data-test="project-provider-add" @submit.prevent="add">
      <select v-model="kind" class="h-9 rounded-lg bg-zinc-800 px-2 text-sm text-zinc-100" aria-label="Provedor">
        <option value="">Acrescentar provider…</option>
        <option v-for="item in free" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
      <input
        v-model="key"
        type="password"
        autocomplete="off"
        class="h-9 min-w-0 flex-1 rounded-lg bg-zinc-950 px-3 font-mono text-sm text-zinc-100 ring-1 ring-zinc-800"
        placeholder="Chave (opcional agora)"
        aria-label="Chave do novo provider"
      />
      <button type="submit" class="btn btn-sm btn-primary" :disabled="busy || !kind">Acrescentar</button>
    </form>

    <p v-if="note" class="text-sm text-success-300">{{ note }}</p>
    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
    <ConfirmDialog
      :open="!!removing"
      title="Apagar o provider do projeto?"
      message="A chave sai junto. Agente que usa este provider precisa trocar antes (o servidor recusa e diz quais)."
      action="Apagar"
      @confirm="remove"
      @cancel="removing = undefined"
    />
  </section>
</template>
