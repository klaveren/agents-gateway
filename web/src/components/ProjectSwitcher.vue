<script setup lang="ts">
import { computed } from 'vue'
import { lite } from '@/lib/edition'
import { initials } from '@/lib/format'
import { useAboveBar, usePopover } from '@/lib/popover'
import { loadServers, serverList, switchServer } from '@/lib/servers'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import Icon from './Icon.vue'

/**
 * O seletor de PROJETO, no topo do trilho: o projeto atual recorta Conversas, Agentes e a conversa nova.
 * A lite não troca de projeto: só mostra o atual (o padrão).
 * ⚖️ No app do Mac, o mesmo menu troca de SERVIDOR (ver `lib/servers`): o bloco fica acima dos projetos, que são os do
 * servidor que está na janela. Na lite ele é o menu inteiro.
 * `placement`: no trilho (desktop) abre para o lado; na barra do celular, para cima.
 */
defineProps<{ placement: 'side' | 'up' }>()
const auth = useAuthStore()
const projects = useProjectsStore()
const { open, root } = usePopover()
const above = useAboveBar(open, root)

const label = computed(() => projects.currentProject?.name ?? 'Sem projeto')

void loadServers()
/** Sem o que escolher (a lite, fora do app), o botão só mostra o projeto. */
const fixed = computed(() => lite.value && !serverList.value)

async function choose(id: string) {
  open.value = false
  await projects.select(id)
}

async function go(id: string) {
  open.value = false
  if (id === serverList.value?.current) return
  // A falha de abrir é do app, que avisa na janela; aqui só sobra o servidor que saiu da lista, e não há o que mostrar.
  await switchServer(id).catch(() => undefined)
}
</script>

<template>
  <div ref="root" class="relative flex justify-center" :class="placement === 'up' ? 'min-w-0 flex-1' : ''">
    <button
      type="button"
      class="flex flex-col items-center gap-0.5 text-[10px] font-medium"
      :class="placement === 'up' ? 'w-full py-1.5 text-zinc-400' : ''"
      :aria-expanded="open"
      :aria-haspopup="fixed ? undefined : 'menu'"
      :disabled="fixed"
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
      class="z-50 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40"
      :class="placement === 'side' ? 'absolute w-64 top-0 left-full ml-3' : 'fixed inset-x-2'"
      :style="placement === 'up' && above ? { bottom: `${above}px` } : undefined"
    >
      <template v-if="serverList">
        <div class="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500">Servidor</div>
        <button
          v-for="server in serverList.servers"
          :key="server.id"
          type="button"
          role="menuitemradio"
          :aria-checked="server.id === serverList.current"
          class="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-zinc-800"
          :class="server.id === serverList.current ? 'text-emerald-300' : 'text-zinc-200'"
          data-test="server-item"
          @click="go(server.id)"
        >
          <span class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-zinc-800"><Icon name="globe" class="h-3.5 w-3.5" /></span>
          <span class="min-w-0 flex-1 truncate">{{ server.name }}</span>
          <span v-if="server.id === serverList.current" class="text-xs">✓</span>
        </button>
        <RouterLink v-if="serverList.manage" to="/servers" role="menuitem" class="block px-3 py-2.5 text-zinc-300 hover:bg-zinc-800" data-test="servers-manage">Gerenciar servidores</RouterLink>
      </template>
      <template v-if="!lite">
        <div class="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500" :class="serverList ? 'border-t' : ''">Projeto</div>
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
        <RouterLink v-if="auth.isAdmin || projects.managesAny" to="/projects" role="menuitem" class="block border-t border-zinc-800 px-3 py-2.5 text-zinc-300 hover:bg-zinc-800">Gerenciar projetos</RouterLink>
      </template>
    </div>
  </div>
</template>
