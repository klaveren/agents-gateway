<script setup lang="ts">
import Icon from './Icon.vue'

/**
 * Lista ao lado, detalhe à direita — o desenho das Conversas, usado também em Agentes, Providers e Usuários.
 *
 * ⚖️ Telas largas (`lg`): as duas colunas. Média: uma de cada vez. Celular (< `md`): o detalhe abre por
 * cima de TUDO, em tela cheia (inclusive da barra de navegação), com a volta no topo — como num app de mensagens.
 */
defineProps<{ open: boolean; backTo: string; backLabel: string; title?: string }>()
</script>

<template>
  <div class="flex h-full">
    <aside class="scroll-thin h-full w-full shrink-0 overflow-x-hidden overflow-y-auto border-r border-zinc-800/80 lg:w-[340px]" :class="open ? 'hidden lg:block' : 'block'">
      <slot name="list" />
    </aside>
    <section
      class="h-full min-w-0 flex-1 flex-col bg-zinc-950"
      :class="open ? 'flex max-md:fixed max-md:inset-0 max-md:z-40 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]' : 'hidden lg:flex'"
    >
      <header v-if="open" class="flex shrink-0 items-center gap-1 border-b border-zinc-800/80 px-2 py-2 lg:hidden">
        <RouterLink :to="backTo" class="flex items-center gap-1 rounded-full px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"><Icon name="back" class="h-4 w-4" /> {{ backLabel }}</RouterLink>
        <span v-if="title" class="min-w-0 truncate text-sm font-medium text-zinc-200">· {{ title }}</span>
      </header>
      <div class="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5">
        <slot name="detail" />
      </div>
    </section>
  </div>
</template>
