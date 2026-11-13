<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAboveBar, usePopover } from '@/lib/popover'
import Icon from './Icon.vue'

export type TRailIcon = 'users' | 'key' | 'plug' | 'box' | 'settings' | 'agents' | 'rule' | 'doc' | 'bolt' | 'slash' | 'folder' | 'clock' | 'warn' | 'shield' | 'git'
export interface IRailMenuItem {
  /** Ausente no AGRUPADOR (`children`): ele só abre e fecha a lista dos filhos. */
  to?: string
  key: string
  label: string
  hint: string
  icon: TRailIcon
  /** Os filhos de um agrupador (ex.: Logs → API, Erros, Catálogo), mostrados recuados embaixo dele. */
  children?: readonly IRailMenuItem[]
}

/**
 * Um botão do trilho que abre um menu de páginas (o Sistema, os Docs). `active`: a página aberta é uma
 * destas — o botão fica aceso.
 */
const props = defineProps<{ title: string; icon: TRailIcon; items: readonly IRailMenuItem[]; placement: 'side' | 'up'; active?: string }>()
const { open, root } = usePopover()
const above = useAboveBar(open, root)

const lit = computed(() => props.items.some((item) => item.key === props.active || item.children?.some((child) => child.key === props.active)))

/** Os agrupadores abertos: começa aberto o que tem a página atual entre os filhos. */
const expanded = ref(new Set<string>())
watch(
  open,
  (isOpen) => {
    if (isOpen) expanded.value = new Set(props.items.filter((item) => item.children?.some((child) => child.key === props.active)).map((item) => item.key))
  },
  { immediate: true },
)
function toggle(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

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
      class="z-50 overflow-y-auto overscroll-contain rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40"
      :class="placement === 'side' ? 'absolute top-0 left-full ml-3 w-64' : 'fixed inset-x-2'"
      :style="{ ...(room ? { maxHeight: `${room}px` } : {}), ...(placement === 'up' && above ? { bottom: `${above}px` } : {}) }"
    >
      <div class="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500">{{ title }}</div>
      <template v-for="item in items" :key="item.key">
        <!-- O agrupador: abre e fecha os filhos, que ficam recuados embaixo dele. -->
        <template v-if="item.children">
          <button
            type="button"
            class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-zinc-800"
            :class="item.children.some((child) => child.key === active) ? 'text-emerald-300' : 'text-zinc-200'"
            :aria-expanded="expanded.has(item.key)"
            :data-test="`menu-group-${item.key}`"
            @click="toggle(item.key)"
          >
            <Icon :name="item.icon" class="h-4 w-4 shrink-0 text-zinc-400" />
            <span class="min-w-0 flex-1">
              <span class="block">{{ item.label }}</span>
              <span class="block truncate text-xs text-zinc-500">{{ item.hint }}</span>
            </span>
            <span class="shrink-0 text-xs text-zinc-500">{{ expanded.has(item.key) ? '▾' : '▸' }}</span>
          </button>
          <template v-if="expanded.has(item.key)">
            <RouterLink
              v-for="child in item.children"
              :key="child.key"
              :to="child.to ?? '/'"
              role="menuitem"
              class="flex items-center gap-2.5 py-2 pr-3 pl-9 hover:bg-zinc-800"
              :class="child.key === active ? 'text-emerald-300' : 'text-zinc-200'"
            >
              <Icon :name="child.icon" class="h-4 w-4 shrink-0 text-zinc-400" />
              <span class="min-w-0">
                <span class="block">{{ child.label }}</span>
                <span class="block truncate text-xs text-zinc-500">{{ child.hint }}</span>
              </span>
            </RouterLink>
          </template>
        </template>
        <RouterLink
          v-else
          :to="item.to ?? '/'"
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
      </template>
    </div>
  </div>
</template>
