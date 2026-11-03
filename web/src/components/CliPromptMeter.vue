<script setup lang="ts">
  import { computed, watch } from 'vue'
  import { cliPromptEstimate, kib } from '@/lib/cliPrompt'
  import { useResource } from '@/composables/useResource'
  import { useAgentCatalogStore } from '@/stores/agentCatalog'
  import { useProjectsStore } from '@/stores/projects'

  /**
   * O prompt do agente no Codex e no Antigravity, contra o limite do Linux para um argumento (ver `lib/cliPrompt`).
   * ⚖️ AVISO, nunca bloqueio: o Salvar segue. O ambiente (rules, índices, contexto inicial) vem medido do servidor
   * sobre o agente salvo, no projeto dele (num global, no projeto atual); o soul e a instrução, do formulário.
   */
  const props = defineProps<{
    /** Os provedores do agente que rodam num CLI, pelo nome. */
    providers: string[]
    codex: boolean
    soul?: string
    systemPrompt: string
    /** O agente salvo (ausente ao criar): de onde vem a medida do ambiente. */
    agentId?: string
    projectId?: string
    saved?: { soul?: string; systemPrompt: string }
  }>()
  const projects = useProjectsStore()
  const catalog = useAgentCatalogStore()

  const project = computed(() => props.projectId ?? projects.current ?? '')
  // A medida mora na store: a mesma da guia Tamanho. Sem ela, a conta fica só com o soul e a instrução (e a tela diz).
  const { data } = useResource(catalog.footprints, () => (props.agentId ? catalog.footprintKey(props.agentId, !props.projectId && project.value ? project.value : undefined) : undefined))
  const measured = computed(() => data.value?.cli)
  // Salvou (outro `saved`): a medida do salvo ficou velha — a conta troca o salvo pelo da tela.
  watch(
    () => props.saved,
    () => catalog.invalidate(),
  )

  const estimate = computed(() => cliPromptEstimate({ cli: measured.value, saved: props.saved, live: { soul: props.soul, systemPrompt: props.systemPrompt }, codex: props.codex }))
  const heavy = computed(() => estimate.value.heavy.map((part) => `${part.label} (${kib(part.bytes)})`).join(', '))
  const tone = computed(() => ({ ok: 'bg-emerald-500', warn: 'bg-amber-500', over: 'bg-rose-500' })[estimate.value.level])
</script>

<template>
  <div class="flex flex-col gap-1" data-test="cli-prompt">
    <div class="flex items-center gap-2 text-xs text-zinc-400">
      <span>
        Prompt no {{ providers.join(' e ') }}: ≈ <span class="tabular-nums text-zinc-200">{{ kib(estimate.bytes) }}</span> de {{ kib(estimate.limit) }} ({{ estimate.percent }}%)
      </span>
      <span class="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-zinc-800">
        <span class="block h-full" :class="tone" :style="{ width: `${Math.min(estimate.percent, 100)}%` }" />
      </span>
    </div>
    <small v-if="estimate.level === 'warn'" class="text-xs text-amber-300" data-test="cli-warn">
      Perto do limite do Linux para um argumento de linha de comando (128 KiB): {{ providers.join(' e ') }} recebe{{ providers.length > 1 ? 'm' : '' }} o prompt assim, e no
      primeiro turno a mensagem vai junto. O que mais pesa: {{ heavy }}.
    </small>
    <small v-else-if="estimate.level === 'over'" class="text-xs text-rose-300" data-test="cli-warn">
      Passa do limite do Linux para um argumento de linha de comando (128 KiB): a conversa no {{ providers.join(' e ') }} vai ser recusada (os outros provedores
      seguem). O que mais pesa: {{ heavy }}.
    </small>
    <small v-if="!estimate.withEnvironment" class="text-xs text-zinc-500">Só o soul e a instrução: rules, índices e contexto inicial entram depois de salvar.</small>
  </div>
</template>
