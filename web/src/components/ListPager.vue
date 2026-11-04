<script setup lang="ts">
  /** O passador de página dos relatórios: some quando tudo cabe numa página. */
  const props = defineProps<{ pages: number; total: number; size: number }>()
  const page = defineModel<number>({ required: true })
  const from = () => page.value * props.size + 1
  const to = () => Math.min(props.total, (page.value + 1) * props.size)
</script>

<template>
  <nav v-if="pages > 1" class="mt-3 flex items-center justify-end gap-2 text-xs text-zinc-400" aria-label="Páginas" data-test="pager">
    <span class="tabular-nums">{{ from() }}–{{ to() }} de {{ total }}</span>
    <button class="rounded-full px-2 py-0.5 hover:bg-zinc-800 disabled:opacity-40" :disabled="page === 0" aria-label="Página anterior" data-test="pager-prev" @click="page -= 1">
      ‹
    </button>
    <span class="tabular-nums">{{ page + 1 }}/{{ pages }}</span>
    <button
      class="rounded-full px-2 py-0.5 hover:bg-zinc-800 disabled:opacity-40"
      :disabled="page >= pages - 1"
      aria-label="Próxima página"
      data-test="pager-next"
      @click="page += 1"
    >
      ›
    </button>
  </nav>
</template>
