<script setup lang="ts">
  import { sizeHint } from '@/lib/format'
  import type { IAgentTrigger } from '@/lib/types'

  /**
   * O editor de TRIGGERS — o procedimento de uma situação, carregado sob demanda: o do agente (guia Triggers do
   * formulário) e o da skill ou do command (guia Triggers do recurso). Só o "quando" vai no índice; o corpo, quando a
   * situação acontece.
   */
  const triggers = defineModel<IAgentTrigger[]>({ required: true })
  defineProps<{
    title: string
    intro: string
    empty: string
    issues?: string[]
    /** O prefixo dos ids dos campos (dois editores na mesma página não colidem). */
    idPrefix?: string
  }>()
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
      <h3 class="text-sm font-medium text-zinc-200">{{ title }}</h3>
      <p class="text-xs text-zinc-500">{{ intro }}</p>
    </div>
    <div v-for="(trigger, index) in triggers" :key="index" class="flex flex-col gap-2 rounded-xl border border-zinc-800 px-3 py-3">
      <div class="grid gap-2 sm:grid-cols-[14rem_1fr_auto]">
        <input
          :id="`${idPrefix ?? 'trigger'}-id-${index}`"
          v-model="trigger.id"
          class="input font-mono text-[13px]"
          placeholder="morning-brief"
          aria-label="Nome do trigger"
          @keydown.enter.prevent
        />
        <input
          :id="`${idPrefix ?? 'trigger'}-when-${index}`"
          v-model="trigger.when"
          class="input"
          placeholder="Quando usar: a pessoa diz bom dia"
          aria-label="Quando usar"
          @keydown.enter.prevent
        />
        <button type="button" class="btn btn-sm btn-danger" @click="triggers.splice(index, 1)">Remover</button>
      </div>
      <textarea
        :id="`${idPrefix ?? 'trigger'}-body-${index}`"
        v-model="trigger.body"
        rows="8"
        class="input font-mono text-[13px] leading-relaxed"
        placeholder="O procedimento: o que fazer, passo a passo."
        aria-label="Procedimento"
      />
      <small v-if="trigger.body" class="hint">{{ sizeHint(trigger.body, 'quando carregado') }}</small>
    </div>
    <p v-if="!triggers.length" class="text-sm text-zinc-500">{{ empty }}</p>
    <button type="button" class="btn btn-sm btn-ghost self-start" @click="triggers = [...triggers, { id: '', when: '', body: '' }]">+ Trigger</button>
    <small v-for="message in issues ?? []" :key="message" class="error">{{ message }}</small>
  </div>
</template>
