<script setup lang="ts">
  import { computed } from 'vue'
  import { lite } from '@/lib/edition'
  import { initials } from '@/lib/format'
  import { PALETTES } from '@/lib/projectColors'
  import { useAboveBar, usePopover } from '@/lib/popover'
  import { loadOtherProjects, loadServers, otherServerProjects, serverList, switchServer } from '@/lib/servers'
  import { watch } from 'vue'
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

  /** O nome do servidor que está na janela (a tag dos projetos daqui). */
  const currentServerName = computed(() => serverList.value?.servers.find((server) => server.id === serverList.value?.current)?.name)
  // Ao abrir o menu, o app relê os projetos dos outros servidores (login e lista mudam).
  watch(open, (isOpen) => {
    if (isOpen && serverList.value) void loadOtherProjects()
  })

  async function go(id: string, project?: string) {
    open.value = false
    if (id === serverList.value?.current && !project) return
    if (id === serverList.value?.current && project) return void (await projects.select(project))
    // A falha de abrir é do app, que avisa na janela; aqui só sobra o servidor que saiu da lista, e não há o que mostrar.
    await switchServer(id, project).catch(() => undefined)
  }

  /**
   * 🔤 Os projetos daqui e os dos outros servidores numa lista só, em ordem alfabética (o mesmo nome em dois servidores
   * fica junto, pelo nome do servidor). O clique num daqui escolhe o projeto; num de fora, troca de servidor e abre.
   */
  const projectEntries = computed(() => {
    const here = projects.list.map((project) => ({ key: project.id, project, serverId: undefined as string | undefined, serverName: currentServerName.value }))
    const others = serverList.value
      ? (otherServerProjects.value ?? []).flatMap((server) =>
          server.state === 'ok' ? (server.projects ?? []).map((project) => ({ key: `${server.id}:${project.id}`, project, serverId: server.id as string | undefined, serverName: server.name as string | undefined })) : [],
        )
      : []
    const byName = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })
    return [...here, ...others].sort((a, b) => byName.compare(a.project.name, b.project.name) || byName.compare(a.serverName ?? '', b.serverName ?? ''))
  })

  /** A paleta do projeto, se ele tem cor. */
  const paletteOf = (color: string | undefined) => (color && color in PALETTES ? PALETTES[color as keyof typeof PALETTES] : undefined)
</script>

<template>
  <div ref="root" class="relative flex justify-center" :class="placement === 'up' ? 'min-w-0 flex-1' : ''">
    <button
      type="button"
      class="flex flex-col items-center gap-0.5 text-[10px] font-medium"
      :class="placement === 'up' ? 'w-full py-2.5 text-zinc-400' : ''"
      :aria-expanded="open"
      :aria-haspopup="fixed ? undefined : 'menu'"
      :disabled="fixed"
      :title="`Projeto: ${label}`"
      @click="open = !open"
    >
      <span
        class="grid place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-accent-end font-bold text-zinc-950"
        :class="[placement === 'up' ? 'h-[22px] w-[22px] rounded-md text-[9px]' : 'h-8 w-8 text-xs', open ? 'ring-2 ring-emerald-300/60' : '']"
      >
        {{ projects.currentProject ? initials(projects.currentProject.name) : 'AG' }}
      </span>
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
      </template>
      <template v-if="!lite">
        <div class="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500" :class="serverList ? 'border-t' : ''">Projeto</div>
        <!-- 🗂️ No app do Mac, os projetos dos OUTROS servidores entram na mesma lista, com a tag de qual é; tudo em ordem alfabética. -->
        <button
          v-for="entry in projectEntries"
          :key="entry.key"
          type="button"
          :role="entry.serverId ? 'menuitem' : 'menuitemradio'"
          :aria-checked="entry.serverId ? undefined : entry.project.id === projects.current"
          class="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-zinc-800"
          :class="!entry.serverId && entry.project.id === projects.current ? 'text-emerald-300' : 'text-zinc-200'"
          :data-test="entry.serverId ? 'other-project-item' : undefined"
          @click="entry.serverId ? go(entry.serverId, entry.project.id) : choose(entry.project.id)"
        >
          <!-- 🎨 As iniciais na cor do projeto: dá para achar o projeto pela cor. Sem cor, o cinza de antes. -->
          <span
            class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] font-semibold"
            :class="paletteOf(entry.project.color) ? 'text-zinc-950' : 'bg-zinc-800'"
            :style="paletteOf(entry.project.color) ? { background: paletteOf(entry.project.color)!['500'] } : undefined"
            :data-test="entry.serverId ? undefined : 'project-swatch'"
          >
            {{ initials(entry.project.name) }}
          </span>
          <span class="min-w-0 flex-1 truncate">{{ entry.project.name }}</span>
          <span v-if="serverList && entry.serverName" class="server-tag shrink-0" :data-test="entry.serverId ? undefined : 'project-server-tag'">{{ entry.serverName }}</span>
          <span v-if="!entry.serverId && entry.project.id === projects.current" class="text-xs">✓</span>
        </button>
        <template v-for="server in serverList ? (otherServerProjects ?? []) : []" :key="`server:${server.id}`">
          <button
            v-if="server.state !== 'ok'"
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-zinc-400 hover:bg-zinc-800"
            :disabled="server.state === 'offline'"
            data-test="other-server-login"
            @click="go(server.id)"
          >
            <span class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-zinc-800"><Icon name="globe" class="h-3.5 w-3.5" /></span>
            <span class="min-w-0 flex-1 truncate">{{ server.state === 'login' ? `Entrar em ${server.name}` : `${server.name} não respondeu` }}</span>
          </button>
        </template>
        <p v-if="!projects.list.length" class="px-3 py-2 text-xs text-zinc-500">
          {{ auth.isAdmin ? 'Nenhum projeto ainda.' : 'Você não está em nenhum projeto: peça a quem administra.' }}
        </p>
        <RouterLink v-if="auth.isAdmin || projects.managesAny" to="/projects" role="menuitem" class="block border-t border-zinc-800 px-3 py-2.5 text-zinc-300 hover:bg-zinc-800">
          Gerenciar projetos
        </RouterLink>
        <RouterLink v-if="serverList?.manage" to="/servers" role="menuitem" class="block px-3 py-2.5 text-zinc-300 hover:bg-zinc-800" data-test="servers-manage">
          Gerenciar servidores
        </RouterLink>
      </template>
    </div>
  </div>
</template>

<style scoped>
  /* A tag do servidor de cada projeto (só no app do Mac, com mais de um servidor). */
  .server-tag {
    border-radius: 9999px;
    background: rgb(39 39 42);
    padding: 0 0.4rem;
    font-size: 10px;
    line-height: 1.1rem;
    color: rgb(161 161 170);
  }
</style>
