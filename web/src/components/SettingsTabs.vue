<script setup lang="ts">
  /** As guias da Configuração do sistema. Mesmo desenho das guias do agente. */
  export type TSettingsTab = 'general' | 'models' | 'limits' | 'machine' | 'notices' | 'deployment'

  defineProps<{ items: ReadonlyArray<{ id: TSettingsTab; label: string }> }>()
  const tab = defineModel<TSettingsTab>({ required: true })
</script>

<template>
  <!-- No celular as guias não cabem: a barra rola de lado. -->
  <nav class="no-scrollbar flex gap-1 overflow-x-auto overscroll-x-contain border-b border-zinc-800" role="tablist">
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      role="tab"
      :aria-selected="tab === item.id"
      :data-test="`settings-tab-${item.id}`"
      class="shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
      :class="tab === item.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
      @click="tab = item.id"
    >
      {{ item.label }}
    </button>
  </nav>
</template>
