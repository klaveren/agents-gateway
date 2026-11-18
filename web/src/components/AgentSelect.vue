<script setup lang="ts">
  import { computed, nextTick, ref, watch } from 'vue'
  import { usePopover } from '@/lib/popover'
  import type { IAgent } from '@/lib/types'
  import AgentAvatar from './AgentAvatar.vue'
  import Icon from './Icon.vue'
  import SharedBadge from './SharedBadge.vue'

  /**
   * O agente da conversa nova: um seletor GRANDE (cada item do tamanho do cartão de antes), em ordem alfabética e com
   * busca. Fechado, mostra o escolhido; aberto, a lista. O indisponível aparece apagado, com o motivo, e não se escolhe.
   */
  const props = defineProps<{ options: readonly IAgent[]; value?: string }>()
  const emit = defineEmits<{ pick: [id: string] }>()

  const { open, root } = usePopover()
  const query = ref('')
  const search = ref<HTMLInputElement>()

  const sorted = computed(() => [...props.options].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })))
  const shown = computed(() => {
    const term = query.value.trim().toLocaleLowerCase('pt-BR')
    return term ? sorted.value.filter((option) => `${option.name} ${option.id}`.toLocaleLowerCase('pt-BR').includes(term)) : sorted.value
  })
  const selected = computed(() => props.options.find((option) => option.id === props.value))

  watch(open, async (isOpen) => {
    if (!isOpen) return
    query.value = ''
    await nextTick()
    search.value?.focus()
  })

  function choose(option: IAgent) {
    if (option.unavailable) return
    emit('pick', option.id)
    open.value = false
  }

  /** Enter na busca escolhe o primeiro que serve. */
  function pickFirst() {
    const first = shown.value.find((option) => !option.unavailable)
    if (first) choose(first)
  }

  const detail = (option: IAgent) =>
    `${option.providers[0]?.name ?? ''} · ${option.providers[0]?.models[0] ?? ''}${option.providers.length > 1 ? ` · +${option.providers.length - 1} provedor(es)` : ''}`
</script>

<template>
  <div ref="root" class="relative" data-test="agent-select">
    <button
      type="button"
      class="flex w-full min-w-0 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-left transition-colors hover:bg-zinc-900"
      :class="{ 'border-emerald-500/60': open }"
      aria-haspopup="listbox"
      :aria-expanded="open"
      data-test="agent-select-toggle"
      @click="open = !open"
    >
      <template v-if="selected">
        <AgentAvatar :name="selected.name" :provider="selected.providers[0]?.id ?? ''" size="sm" />
        <span class="min-w-0 flex-1">
          <span class="flex min-w-0 items-center gap-1">
            <span class="truncate text-sm font-medium">{{ selected.name }}</span>
            <SharedBadge :from="selected.sharedFrom" />
          </span>
          <span class="block truncate text-xs text-zinc-400">{{ detail(selected) }}</span>
        </span>
      </template>
      <span v-else class="flex-1 text-sm text-zinc-400">Escolha um agente</span>
      <Icon name="chevron" class="h-4 w-4 shrink-0 text-zinc-400 transition-transform" :class="open ? 'rotate-90' : ''" />
    </button>

    <div v-if="open" class="absolute inset-x-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40">
      <div class="border-b border-zinc-800 p-2">
        <input
          ref="search"
          v-model="query"
          type="search"
          class="h-9 w-full rounded-lg bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-emerald-500/60"
          placeholder="Buscar agente…"
          aria-label="Buscar agente"
          @keydown.enter.prevent="pickFirst"
        />
      </div>
      <ul role="listbox" class="max-h-80 overflow-y-auto p-1.5" data-test="agent-select-list">
        <li v-for="option in shown" :key="option.id">
          <button
            type="button"
            role="option"
            :aria-selected="option.id === value"
            :disabled="!!option.unavailable"
            :title="option.unavailable?.label"
            class="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            :class="option.id === value ? 'bg-emerald-500/10' : 'hover:bg-zinc-800'"
            @click="choose(option)"
          >
            <AgentAvatar :name="option.name" :provider="option.providers[0]?.id ?? ''" size="sm" />
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-1">
                <span class="truncate text-sm font-medium">{{ option.name }}</span>
                <SharedBadge :from="option.sharedFrom" />
              </span>
              <span class="block truncate text-xs text-zinc-400">{{ detail(option) }}</span>
              <span v-if="option.unavailable" class="block truncate text-xs text-amber-300">{{ option.unavailable.label }}</span>
            </span>
            <Icon v-if="option.id === value" name="check" class="h-4 w-4 shrink-0 text-emerald-400" />
          </button>
        </li>
        <li v-if="!shown.length" class="px-3 py-4 text-center text-sm text-zinc-500">Nenhum agente com esse nome.</li>
      </ul>
    </div>
  </div>
</template>
