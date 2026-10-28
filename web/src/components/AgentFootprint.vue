<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '@/lib/api'
import { footprintShares } from '@/lib/footprint'
import type { IAgentFootprint } from '@/lib/types'
import { useProjectsStore } from '@/stores/projects'

/**
 * O TAMANHO do agente: quantos tokens ele carrega antes da primeira mensagem, parte a parte — o que se paga em toda
 * chamada ao modelo. ⚖️ Medido no servidor, com as mesmas peças da conversa, sobre o que está SALVO. Um agente global
 * muda com o projeto da conversa (as rules e as specs são do projeto): aí se escolhe o projeto.
 */
const props = defineProps<{ agentId: string; projectId?: string }>()
const projects = useProjectsStore()

const project = ref<string>(props.projectId ?? projects.current ?? '')
const result = ref<IAgentFootprint>()
const loading = ref(false)
const error = ref<string>()
const open = ref<Set<string>>(new Set())

const shares = computed(() => footprintShares(result.value?.sections ?? []))
const unmeasured = computed(() => shares.value.filter((section) => section.tokens === null))

watch(() => [props.agentId, project.value], load, { immediate: true })

async function load() {
  loading.value = true
  error.value = undefined
  try {
    result.value = await api<IAgentFootprint>(`/agents/${encodeURIComponent(props.agentId)}/footprint`, { query: !props.projectId && project.value ? { project: project.value } : {} })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    loading.value = false
  }
}

function toggle(key: string) {
  const next = new Set(open.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  open.value = next
}

const fmt = (value: number) => value.toLocaleString('pt-BR')
</script>

<template>
  <section class="flex flex-col gap-4">
    <div class="flex flex-wrap items-end gap-3">
      <div>
        <p class="text-3xl font-semibold tabular-nums">≈ {{ fmt(result?.total ?? 0) }} <span class="text-base font-normal text-zinc-400">tokens</span></p>
        <p class="text-xs text-zinc-500">enviados antes de cada mensagem</p>
      </div>
      <label v-if="!projectId" class="ml-auto flex items-center gap-2 text-xs text-zinc-400">
        Projeto
        <select v-model="project" class="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-100">
          <option value="">nenhum (só o global)</option>
          <option v-for="item in projects.list" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </label>
      <button type="button" class="btn btn-secondary" :class="projectId ? 'ml-auto' : ''" :disabled="loading" @click="load">{{ loading ? 'Medindo…' : 'Atualizar' }}</button>
    </div>

    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>

    <div v-if="result?.total" class="flex h-3 w-full overflow-hidden rounded-full bg-zinc-800">
      <span v-for="section in shares.filter((item) => item.share > 0)" :key="section.key" class="h-full" :class="section.color" :style="{ width: `${section.share}%` }" :title="`${section.label}: ≈ ${fmt(section.tokens ?? 0)} tokens (${section.share}%)`" />
    </div>

    <ul class="flex flex-col divide-y divide-zinc-800 rounded-xl border border-zinc-800">
      <li v-for="section in shares" :key="section.key" class="px-3 py-2">
        <button type="button" class="flex w-full items-center gap-3 text-left" :disabled="!section.items?.length" @click="toggle(section.key)">
          <span class="h-2.5 w-2.5 shrink-0 rounded-full" :class="section.color" />
          <span class="min-w-0 flex-1 text-sm text-zinc-200">
            {{ section.label }}
            <span v-if="section.items?.length" class="text-xs text-zinc-500">· {{ section.items.length }} {{ open.has(section.key) ? '▾' : '▸' }}</span>
            <span v-if="section.note" class="block text-xs text-zinc-500">{{ section.note }}</span>
          </span>
          <span class="shrink-0 text-sm tabular-nums" :class="section.tokens === null ? 'text-zinc-500' : 'text-zinc-300'">{{ section.tokens === null ? 'não medido' : `≈ ${fmt(section.tokens)}` }}</span>
          <span class="w-12 shrink-0 text-right text-xs text-zinc-500 tabular-nums">{{ section.tokens === null ? '' : `${section.share}%` }}</span>
        </button>
        <ul v-if="open.has(section.key) && section.items?.length" class="mt-2 ml-5 flex flex-col gap-0.5">
          <li v-for="item in section.items" :key="item.name" class="flex items-center gap-3 text-xs">
            <code class="min-w-0 flex-1 truncate text-zinc-400">{{ item.name }}</code>
            <span v-if="section.tokens !== null" class="text-zinc-500 tabular-nums">≈ {{ fmt(item.tokens) }}</span>
          </li>
        </ul>
      </li>
    </ul>

    <p class="text-xs text-zinc-500">
      Estimativa com o que está salvo. Alterações não salvas não contam.
      <template v-if="unmeasured.length"> {{ unmeasured.map((item) => item.label).join(', ') }}: {{ unmeasured.length === 1 ? 'entra' : 'entram' }} no prompt, mas não se mede daqui.</template>
    </p>
  </section>
</template>
