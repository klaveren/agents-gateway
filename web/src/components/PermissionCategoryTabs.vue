<script setup lang="ts">
import { computed } from 'vue'
import { PERMISSION_SECTIONS } from '@/lib/permissions'
import type { IPermissionRule, TPermissionCategory } from '@/lib/types'

/**
 * As guias das categorias de permissão (Terminal, Leitura, Escrita…), com o número de regras de cada uma: as mesmas no
 * projeto e no agente. `active: false`: outra guia da tela está aberta (o Histórico), e nenhuma categoria fica acesa.
 * O que vem no slot entra no fim da barra.
 */
const props = withDefaults(defineProps<{ rules: readonly IPermissionRule[]; active?: boolean; /** As categorias que moram noutra guia da tela (a Delegação do agente). */ exclude?: readonly TPermissionCategory[] }>(), {
  active: true,
  exclude: () => [],
})
const category = defineModel<TPermissionCategory>({ required: true })
const emit = defineEmits<{ pick: [category: TPermissionCategory] }>()

const items = computed(() =>
  PERMISSION_SECTIONS.filter((section) => !props.exclude.includes(section.category)).map((section) => ({ category: section.category, label: section.tab ?? section.label, count: props.rules.filter((rule) => rule.category === section.category).length })),
)

function pick(next: TPermissionCategory) {
  category.value = next
  emit('pick', next)
}
</script>

<template>
  <!-- No celular as guias não cabem: a barra rola de lado. -->
  <nav class="no-scrollbar flex gap-1 overflow-x-auto overscroll-x-contain border-b border-zinc-800" role="tablist">
    <button
      v-for="item in items"
      :key="item.category"
      type="button"
      role="tab"
      :aria-selected="active && category === item.category"
      :data-test="`tab-${item.category}`"
      class="flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
      :class="active && category === item.category ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
      @click="pick(item.category)"
    >
      {{ item.label }}
      <span v-if="item.count" class="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">{{ item.count }}</span>
    </button>
    <slot />
  </nav>
</template>
