<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '@/lib/api'
import { LAYER_LABEL, PERMISSION_SECTIONS } from '@/lib/permissions'
import type { IPermissionPart, TPermissionCategory } from '@/lib/types'

/** O testador: a decisão para um comando, caminho ou ferramenta — com cada parte e a regra que decidiu. Não registra. */
const props = defineProps<{ projectId: string; agentId?: string; /** A categoria da guia aberta: o teste é sempre nela. */ initial?: TPermissionCategory }>()

/** Quem escolhe a categoria é a guia: o campo só mostra qual é. */
const category = computed<TPermissionCategory>(() => props.initial ?? 'terminal')
/** O exemplo do que testar na categoria escolhida. */
const placeholder = computed(() =>
  category.value === 'terminal' ? 'git push origin main && cat .env' : (PERMISSION_SECTIONS.find((section) => section.category === category.value)?.example ?? ''),
)
const value = ref('')
const result = ref<{ allowed: boolean; parts: IPermissionPart[] }>()
const error = ref<string>()
const busy = ref(false)
// Outra guia: o resultado era da categoria anterior.
watch(category, () => {
  result.value = undefined
  error.value = undefined
})

async function run() {
  if (!value.value.trim()) return
  busy.value = true
  error.value = undefined
  try {
    result.value = await api(`/projects/${encodeURIComponent(props.projectId)}/permissions/test`, {
      method: 'POST',
      body: { category: category.value, value: value.value, ...(props.agentId ? { agentId: props.agentId } : {}) },
    })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3">
    <h3 class="text-sm font-medium text-zinc-200">Testar{{ agentId ? ' com este agente' : '' }}</h3>
    <div class="flex flex-wrap gap-2">
      <select :value="category" class="input w-44 cursor-not-allowed text-sm text-zinc-400" aria-label="Categoria" title="A categoria é a da guia aberta" disabled data-test="tester-category">
        <option v-for="section in PERMISSION_SECTIONS" :key="section.category" :value="section.category">{{ section.label }}</option>
      </select>
      <input v-model="value" class="input min-w-0 flex-1 font-mono text-[13px]" :placeholder="placeholder" @keydown.enter.prevent="run" />
      <button type="button" class="btn btn-secondary" :disabled="busy || !value.trim()" @click="run">Testar</button>
    </div>
    <p v-if="error" class="text-xs text-rose-300">{{ error }}</p>
    <div v-if="result" class="flex flex-col gap-1">
      <p class="text-sm font-medium" :class="result.allowed ? 'text-emerald-300' : 'text-rose-300'">{{ result.allowed ? 'Permitido' : 'Negado' }}</p>
      <ul class="flex flex-col gap-1 text-xs">
        <li v-for="(part, index) in result.parts" :key="index" class="flex items-baseline gap-2">
          <span class="w-14 shrink-0" :class="part.allowed ? 'text-emerald-300' : 'text-rose-300'">{{ part.allowed ? 'permite' : 'nega' }}</span>
          <code class="min-w-0 truncate text-zinc-200">{{ part.value }}</code>
          <span class="min-w-0 flex-1 truncate text-zinc-500">{{ part.reason }} · {{ LAYER_LABEL[part.layer] }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
