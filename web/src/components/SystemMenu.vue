<script setup lang="ts">
import { computed } from 'vue'
import { usePopover } from '@/lib/popover'
import Icon from './Icon.vue'

/**
 * O menu do SISTEMA (só admin): Projetos, Rules, Specs e ADRs, Usuários, Modelos, MCPs, Pacotes e Configuração num botão só, como o da conta.
 * ⚖️ O trilho fica com o que se usa todo dia (conversas, uso, agentes); o que se configura de vez em
 * quando mora aqui. `active`: a página aberta é uma destas — o botão fica aceso.
 */
const props = defineProps<{ placement: 'side' | 'up'; active?: string }>()
const { open, root } = usePopover()

const ITEMS: Array<{ to: string; key: string; label: string; hint: string; icon: 'users' | 'key' | 'plug' | 'box' | 'settings' | 'agents' | 'rule' | 'doc' }> = [
  { to: '/projects', key: 'projects', label: 'Projetos', hint: 'Pastas, membros e o que é de cada um', icon: 'agents' },
  { to: '/rules', key: 'rules', label: 'Rules', hint: 'Regras que todo agente respeita', icon: 'rule' },
  { to: '/docs', key: 'docs', label: 'Specs e ADRs', hint: 'Documentos que os agentes consultam', icon: 'doc' },
  { to: '/users', key: 'users', label: 'Usuários', hint: 'Contas, papéis e acessos', icon: 'users' },
  { to: '/models', key: 'providers', label: 'Modelos', hint: 'Provedores, chaves, assinaturas e modelos', icon: 'key' },
  { to: '/mcp', key: 'mcp', label: 'MCPs', hint: 'Servidores de ferramentas', icon: 'plug' },
  { to: '/packages', key: 'packages', label: 'Pacotes', hint: 'Ferramentas do servidor', icon: 'box' },
  { to: '/settings', key: 'settings', label: 'Configuração', hint: 'Operação, limites e implantação', icon: 'settings' },
]
const lit = computed(() => ITEMS.some((item) => item.key === props.active))
</script>

<template>
  <div ref="root" class="relative flex justify-center" :class="placement === 'up' ? 'min-w-0 flex-1' : ''">
    <button
      type="button"
      class="flex w-full flex-col items-center gap-0.5 py-1.5 text-[10px] font-medium transition-colors md:w-14 md:gap-1 md:rounded-xl md:py-2"
      :class="lit || open ? 'bg-zinc-800 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'"
      :aria-expanded="open"
      aria-haspopup="menu"
      title="Sistema"
      @click="open = !open"
    >
      <Icon name="settings" class="h-[22px] w-[22px]" />
      <span>Sistema</span>
    </button>

    <div
      v-if="open"
      role="menu"
      class="absolute z-50 w-64 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40"
      :class="placement === 'side' ? 'top-0 left-full ml-3' : 'right-1 bottom-full mb-2'"
    >
      <div class="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500">Sistema</div>
      <RouterLink
        v-for="item in ITEMS"
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
