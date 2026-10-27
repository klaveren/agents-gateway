<script setup lang="ts">
import { computed } from 'vue'
import { initials } from '@/lib/format'
import { usePopover } from '@/lib/popover'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * O seletor de PROJETO, no topo do trilho: o projeto atual recorta Conversas, Agentes e a conversa nova.
 * `placement`: no trilho (desktop) abre para o lado; na barra do celular, para cima.
 */
defineProps<{ placement: 'side' | 'up' }>()
const auth = useAuthStore()
const projects = useProjectsStore()
const { open, root } = usePopover()

const label = computed(() => projects.currentProject?.name ?? 'Sem projeto')

async function choose(id: string) {
  open.value = false
  await projects.select(id)
}
</script>

<template>
  <div ref="root" class="relative flex justify-center" :class="placement === 'up' ? 'min-w-0 flex-1' : ''">
    <button
      type="button"
      class="flex flex-col items-center gap-0.5 text-[10px] font-medium"
      :class="placement === 'up' ? 'w-full py-1.5 text-zinc-400' : ''"
      :aria-expanded="open"
      aria-haspopup="menu"
      :title="`Projeto: ${label}`"
      @click="open = !open"
    >
      <span
        class="grid place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 font-bold text-zinc-950"
        :class="[placement === 'up' ? 'h-[22px] w-[22px] rounded-md text-[9px]' : 'h-10 w-10 text-sm', open ? 'ring-2 ring-emerald-300/60' : '']"
        >{{ projects.currentProject ? initials(projects.currentProject.name) : 'AG' }}</span
      >
      <span v-if="placement === 'up'" class="max-w-full truncate px-0.5">{{ label }}</span>
    </button>

    <div
      v-if="open"
      role="menu"
      class="absolute z-50 w-64 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40"
      :class="placement === 'side' ? 'top-0 left-full ml-3' : 'left-1 bottom-full mb-2'"
    >
      <div class="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500">Projeto</div>
      <button
        v-for="project in projects.list"
        :key="project.id"
        type="button"
        role="menuitemradio"
        :aria-checked="project.id === projects.current"
        class="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-zinc-800"
        :class="project.id === projects.current ? 'text-emerald-300' : 'text-zinc-200'"
        @click="choose(project.id)"
      >
        <span class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-zinc-800 text-[10px] font-semibold">{{ initials(project.name) }}</span>
        <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
        <span v-if="project.id === projects.current" class="text-xs">✓</span>
      </button>
      <p v-if="!projects.list.length" class="px-3 py-2 text-xs text-zinc-500">{{ auth.isAdmin ? 'Nenhum projeto ainda.' : 'Você não está em nenhum projeto: peça a quem administra.' }}</p>
      <RouterLink v-if="auth.isAdmin" to="/projects" role="menuitem" class="block border-t border-zinc-800 px-3 py-2.5 text-zinc-300 hover:bg-zinc-800">Gerenciar projetos</RouterLink>
    </div>
  </div>
</template>
