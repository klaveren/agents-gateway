<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usePopover } from '@/lib/popover'
import Icon from './Icon.vue'

export type TRailIcon = 'users' | 'key' | 'plug' | 'box' | 'settings' | 'agents' | 'rule' | 'doc' | 'bolt' | 'slash' | 'folder'
export interface IRailMenuItem {
  to: string
  key: string
  label: string
  hint: string
  icon: TRailIcon
}

/**
 * Um botão do trilho que abre um menu de páginas (o Sistema, os Docs). `active`: a página aberta é uma
 * destas — o botão fica aceso.
 */
const props = defineProps<{ title: string; icon: TRailIcon; items: readonly IRailMenuItem[]; placement: 'side' | 'up'; active?: string }>()
const { open, root } = usePopover()

const lit = computed(() => props.items.some((item) => item.key === props.active))

/**
 * ⚠️ O menu cresce para baixo (no trilho) ou para cima (na barra do celular) a partir do botão: em tela baixa ele
 * passava da borda, sem rolagem. A altura máxima é o espaço que sobra até a borda, medido ao abrir.
 */
const room = ref<number>()
watch(open, (isOpen) => {
  const rect = root.value?.getBoundingClientRect()
  if (!isOpen || !rect) return
  room.value = Math.max(160, (props.placement === 'side' ? window.innerHeight - rect.top : rect.top) - 12)
})
</script>


<template>
  <div ref="root" class="relative flex justify-center" :class="placement === 'up' ? 'min-w-0 flex-1' : ''">
    <button
      type="button"
      class="flex w-full flex-col items-center gap-0.5 py-1.5 text-[10px] font-medium transition-colors md:w-14 md:gap-1 md:rounded-xl md:py-2"
      :class="lit || open ? 'bg-zinc-800 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'"
      :aria-expanded="open"
      aria-haspopup="menu"
      :title="title"
      @click="open = !open"
    >
      <Icon :name="icon" class="h-[22px] w-[22px]" />
      <span>{{ title }}</span>
    </button>

    <div
      v-if="open"
      role="menu"
      class="scroll-thin absolute z-50 w-64 overflow-y-auto overscroll-contain rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40"
      :class="placement === 'side' ? 'top-0 left-full ml-3' : 'right-1 bottom-full mb-2'"
      :style="room ? { maxHeight: `${room}px` } : undefined"
    >
      <div class="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500">{{ title }}</div>
      <RouterLink
        v-for="item in items"
        :key="item.key"
        :to="item.to"
        role="menuitem"
        class="flex items-center gap-2.5 px-3 py-2.5 hover:bg-zinc-800"
        :class="item.key === active ? 'text-emerald-300' : 'text-zinc-200'"
      >
        <Icon :name="item.icon" class="h-4 w-4 shrink-0 text-zinc-400" />
        <span class="min-w-0">
          <span class="block">{{ item.label }}</span>
          <span class="block truncate text-xs text-zinc-500">{{ item.hint }}</span>
        </span>
      </RouterLink>
    </div>
  </div>
</template>
